# P24 单信号 GMGN 执行边界与全局调用治理方案

> 版本：v1.4
>
> 状态：代码实施完成，静态调用审计、后端单元测试、前端构建与 DOM 测试完成；未执行真实交易
>
> 范围：固定 CA、P20 动态喊单、P21 新关注发现、GMGN Provider 调用、429 冷却与执行会话
>
> 前置依据：P22 GMGN 限流治理、P23 实盘就绪分层与三策略项目级执行导图

## 1. 方案结论

用户对问题的判断基本正确：**没有达到策略触发条件的策略，不应该调用 GMGN；达到条件的事件，只应该由它自己创建一次交易执行会话，并在该会话内调用 GMGN 完成 Quote 和 Swap。**

但仅仅把调用分配给“触发信号自己”还不够。多个信号可能在同一秒内同时触发，如果每个信号都直接绕过全局调度并发调用 GMGN，仍然会触发 429。因此 P24 增加第二个硬约束：

```text
未触发事件：GMGN = 0
一个触发事件：一个 Signal -> 一个 ExecutionSession -> 一个 Provider lease
多个同时触发事件：共享全局 Provider Gate，按 API/IP 配额串行或有界并发
一次实时买入：Quote -> 最小本地硬检查 -> Swap
```

P24 的目标不是为三种策略各建一套交易引擎，而是让每个事件只有一个 Provider 调用所有者，并让所有策略共享 P19/P12 的资金执行、订单、Receipt、Position 和 Exit 状态机。

## 2. 当前核心问题

### 2.1 未触发策略仍然拥有 GMGN 调用入口

以下路径不属于真实交易，却可能产生 GMGN 读取请求：

- readiness 或人工启动检查对无关的固定 CA 批量探测；
- GMGN cache warmup、Candidate warmup 或低优先级恢复任务；
- 6551 监听 Worker 为了判断事件是否可交易而读取 Provider；
- Grok / x_search 研究阶段再调用 GMGN 验证 CA；
- P21 发现 CA 后先物化 `ca_whitelist`，再创建 Activation outbox；
- Activation、交易 Context 和交易执行分别读取 user、token、security、pool、gas；
- 缓存未命中时，多个 Worker 对同一 CA 同时 `getOrLoadFresh`。

这类调用的共同问题是：**调用发生时没有一个真实的 Trade Intent，也没有一个唯一的 ExecutionSession。**

### 2.2 同一个已触发事件被多个模块重复处理

历史路径可能类似：

```text
6551/Grok
  -> 候选验证
  -> GMGN token/security/pool
  -> ca_whitelist
  -> Activation
  -> readiness/context
  -> Quote
  -> Swap
```

这不是一次交易，而是多个模块分别认为自己拥有 Provider 调用权。即使每个模块单独看频率不高，组合后也会把一次事件放大成多组请求。

### 2.3 多个真实信号同时触发仍可能打穿配额

即使完全删除未触发调用，固定 CA、P20 和 P21 也可能在同一时间各自产生 Signal。若三个 Worker 直接同时请求 Quote，仍然会共享同一 API Key、出口 IP 或 GMGN rate scope 的限额。

因此 P24 必须同时解决：

1. **触发资格**：没有 Signal 不调用 GMGN；
2. **调用所有权**：一个 Signal 只能有一个 ExecutionSession；
3. **全局调度**：多个 ExecutionSession 不能绕过共享 Provider Gate；
4. **重复提交**：同一 Signal 不能重复 Quote/Swap，Swap 未知结果不能盲目重试。

### 2.4 旧调用路径代码审计矩阵

以下结论基于当前工作区代码，而不是只根据历史方案推断。这里的“删除”指从生产交易链路移除；“迁移”指保留业务能力但必须改由统一访问边界或明确维护入口承接；“保留”指调用本身仍然有业务必要，但必须满足时机、身份和审计条件。

| 当前代码入口 | 当前触发条件 | 当前 GMGN 行为 | 判断 | P24 处理 |
|---|---|---|---|---|
| `backend/domains/follow-discovery/resolver.js:187-223` `resolveFollowEvent` | P21 Follow 事件完成 Grok 研究、提取 CA 后 | 每个候选进入 `gmgnMarketSource.verifyCandidate`，并并行请求 `token/info`、`security`、`pool` | 删除旧路径 | P21 快速链路只保留 Grok/x_search 证据、CA 格式和归属校验；CA 进入唯一 Signal 后由 ExecutionSession 负责 Quote。完整研究必须是显式维护任务，不能由 Follow Worker 隐式启用。 |
| `backend/domains/follow-discovery/materializer.js:34-64` `materialize` | P21 Live 事件物化候选 | 写入 `ca_whitelist` 后创建 `enqueueWhitelistActivation` | 删除事件级 Activation，保留本地物化 | 保留候选和 Signal 的审计记录，但不创建 Provider Activation，不设置交易必须等待的 `activation_wait_version`。 |
| `backend/domains/dynamic-signal/ca-resolver.js:149-203` `resolveCandidates` | P20 动态事件解析候选 | 对未验证候选批量调用 `verifyCandidate`，可形成并发 Provider 读取 | 快速模式删除，完整模式迁移 | 快速 Live 只做本地 CA/链/事件去重，随后创建 Signal；完整检查由显式操作触发且对同一 `chain + CA` 只执行一次、有快照、有预算。 |
| `backend/domains/dynamic-signal/dynamic-target-service.js:7-74` `materialize` | P20 候选进入 Paper/Live | Live 候选写白名单后创建 Activation outbox | 删除事件级 Activation | 动态候选可以落库，但不能因为候选落库而触发 GMGN；执行权只属于后续 Trade Intent 的 ExecutionSession。 |
| `backend/jobs/gmgn-cache-warmup.js:27-60`、`backend/server.js:191` | Execution capability 启动且 `GMGN_CACHE_WARMER_ENABLED=true` | 每 2 秒轮转固定 CA，调用 `loadCachedContext` | 删除生产运行入口 | 删除启动调度和 readiness 硬门禁；如需诊断，只允许人工、单次、独立 scope 的维护命令。 |
| `backend/jobs/gmgn-candidate-cache-warmup.js:18-46`、`backend/server.js:206` | `P20_CANDIDATE_WARMUP_ENABLED=true` | 定时拉 GMGN rank/hot，写入 Candidate Index | 从交易运行时删除，迁移为投研工具 | P20 事件链不依赖热榜或 Candidate warmup；保留市场研究能力时必须归入独立投研模块和独立预算。 |
| `backend/jobs/dynamic-launch-window.js:110-124`、`backend/server.js:207` | P20 动态 launch window 在服务运行时轮询 | 每个允许链请求 GMGN `trenches`，写入候选索引后再唤醒动态 Job | 删除 Live 交易前置轮询 | 动态喊单的触发源应是 6551 内容事件和本地/Grok CA 提取；不能先用 GMGN 市场扫描等待候选。历史回测或投研需要时迁移到独立、人工触发的 market research job。 |
| `backend/domains/trade/fast-path-context.js:17-40` `loadCachedContext` | 当前 Signal 准备交易，缓存 miss 或 `fresh=true` | 读取 `user/info`、`token/info`、`security`、`pool`、`gas_price`、原生币 `token/info` | 删除热路径补读，迁移上下文来源 | 钱包地址、CA、链和 Token decimals 优先取本地 Execution Profile/Signal Snapshot；Gas 和余额走 RPC 或短时本地状态；Quote 返回交易所需的实时成交数据。缓存 miss 不能展开成一组 GMGN 请求。 |
| `backend/domains/trade/execution-service.js:263-305` `buildPrepared` | Live 买入准备 | `loadCachedContext` 后调用 Quote，并并行启动提交前失败取证 | 保留 Quote，删除并行 Provider 取证 | Quote 是交易 Session 的必要 Provider 步骤；提交前快照改为本地/RPC 数据，失败后的 Provider 取证改为异步、低优先级、仅在结果不确定时执行。 |
| `backend/jobs/whitelist-activation.js:122-186` `probeWhitelist` | Activation outbox 消费 | 固定 CA 当前会 fresh 读取上下文并 Quote；P21 当前跳过 Quote 但仍可能 fresh 读取钱包 | 固定 CA 改为本地配置动作；P20/P21 删除入口 | Activation 只负责本地配置版本和 6551 Watch 同步；不再探测 GMGN。若固定 CA 配置缺少钱包或链配置，直接报告配置错误，由显式诊断处理。 |
| `backend/domains/trade/readiness-service.js:214-350` `probeChains/probeContracts/probeStrategies` | readiness probe、人工启动检查或相关流程 | `user/info`、每个白名单 Quote、Strategy Orders 等 Provider 探测 | 从普通 readiness 删除，迁移到维护诊断 | 普通页面、启动、监控和策略事件只读本地 readiness snapshot；Provider 诊断必须是显式单次命令，不能阻止无关策略，也不能成为每个 Signal 的前置步骤。 |
| `frontend/src/pages/SettingsPage.tsx:521-525` -> `backend/domains/system/routes.js:79-94` -> `backend/domains/system/arm-preparation-service.js:116-120` | 用户点击“准备启动实盘”且前端固定传 `probe: true` | 间接进入 readiness Provider probes，可能按链/白名单扩散多次 GMGN | 删除默认探测，保留显式诊断按钮 | 启动准备默认读取本地 snapshot；单独的“Provider 诊断”才允许一次性 probe，并在 UI 上显示调用数量和 scope，不能把诊断当成交易启动前置。 |
| `backend/domains/trade/trade-failure-evidence-service.js:121-137` `capturePreSubmitSnapshot` | 每次买入提交前 | 读取钱包 Token Balance 和 Wallet Activity | 删除提交前热路径调用，保留不确定结果取证 | 提交前使用 RPC/本地快照；仅在 Swap 已提交但结果不确定、且有原始 Attempt/Order 关联时，经过共享 Gate 做受控对账。 |
| `backend/domains/trade/paper-engine.js:17-39`、`backend/domains/trade/routes.js:348-354` | Paper 开仓或旧 Paper 平仓 | 直接请求 GMGN Token/User 信息 | 删除生产 Provider 依赖 | Paper 使用 Mock/录制行情和测试钱包快照；Paper 不能共享实盘 API scope。旧接口在迁移完成后删除或仅保留明确的兼容返回码。 |
| `backend/domains/research/service.js:247-255` | 用户主动打开独立投研工具 | 读取 Token/Security/Pool | 保留但隔离 | 这是投研能力，不是策略热路径；必须通过独立 research access、独立限流标签和人工触发，不能被 P20/P21 或 readiness 复用。 |
| `backend/domains/dynamic-signal/gmgn-market-source.js:16-164`、`backend/domains/actor-screening/backtest.js:12-16,69-72` | K 线、热榜、战壕、Top holders 和历史回测 | 直接使用 GMGN market endpoint | 保留能力，迁移访问边界 | 只作为独立投研/回测来源；不得由策略事件、启动、页面或 readiness 自动调用，且必须使用 research scope。 |
| `backend/domains/trade/close-service.js`、`backend/domains/trade/reconciliation-service.js` | 已有 Position/Order、平仓、策略订单或未知结果对账 | Query/Strategy Orders/Balance/Activity/Quote/Swap | 保留能力，统一访问和降频 | 真实平仓、已提交订单查询、Receipt/Position 对账是必要链路；迁移到 `gmgn-access-service + Session/Recovery lease`，并禁止用余额/Activity 轮询替代订单查询。 |
| `backend/domains/trade/execution-service.js:489-552` 及同文件重试分支 | 已 Claim 的 Live Signal | 预约 Trade lease，Quote，随后 Swap | 保留并升级为唯一所有者 | 只能由一个 ExecutionSession 调用；Quote/Swap 共用一个 lease、trace 和 Signal，不允许策略 Worker 或旧重试路径再次直接调用。 |
| `backend/lib/gmgn-http.js` | 所有 Provider 请求的低层实现 | 负责签名、HTTP、429 观察和底层接口 | 保留低层库，不保留业务直连 | 业务模块不得直接 import；由 access service 暴露完整的受控接口，低层库只接受带 provenance 的请求。 |

### 2.5 删除调用后必须同步清理的旧门禁

不能只删除 `enqueueWhitelistActivation` 或 `verifyCandidate`，否则当前代码仍会在这些位置把信号挡住：

- `backend/domains/signal/live-policy.js`、`backend/domains/trade/arm-preparation-service.js`、`backend/domains/trade/runtime-scope-service.js`、`backend/domains/trade/runtime-policy-summary.js` 仍读取 `live_activation_state = 'live_ready'`；
- `backend/domains/trade/live-execution-queue.js` 仍按 `live_activation_state` 和 `activation_wait_version` 筛选可执行 Signal；
- `backend/domains/trade/trade-repository.js` 仍校验 Activation version；
- `backend/domains/follow-discovery/materializer.js` 和 `backend/domains/dynamic-signal/dynamic-target-service.js` 仍写入 Activation 状态。

P24 实施时必须把这些旧字段分成两类：

1. 固定 CA 配置版本：保留用于判断本地配置是否变更，不拥有 GMGN 调用权；
2. 事件执行授权：迁移到 `signal claim + trade intent + execution session` 的原子状态，不再等待事件级 Activation。

旧字段在迁移期可以只读兼容历史记录，但新建的 P20/P21 Signal 不得写入或依赖 `activation_wait_version`。历史未完成 Activation 任务要在迁移脚本中标记为 `superseded`/`cancelled`，不能继续消费。

### 2.6 调用语义的最终解释

“触发一次就调用一次 GMGN”在系统设计中应解释为：**一个触发 Signal 获得一个 Provider lease 和一个 ExecutionSession**，而不是要求交易只发一个 HTTP 请求。

- 买入通常需要 `Quote -> Swap` 两个接口动作；它们属于同一 Session，不是两条独立策略链路；
- Quote 失败不发 Swap；Swap 已发出但响应不确定时，只做 `Order/Receipt` 对账，不重新 Swap；
- 没有 Signal 的监听、研究、页面、readiness、Activation、warmup 都是 `GMGN = 0`；
- `security/pool/token/info/gas/user` 不再是默认买入前置步骤，只有显式投研或受控恢复场景才允许出现。

### 2.7 GMGN endpoint 调用盘点

`backend/lib/gmgn-http.js` 当前封装的请求并不等于都会在交易中发生。按 endpoint 反查后的边界如下：

| GMGN endpoint | 当前主要调用者 | 当前风险 | P24 结论 |
|---|---|---|---|
| `GET /v1/user/info` | `fast-path-context`、readiness probe、P21 旧 Activation、Paper | 缓存 miss/启动 probe 会无事件调用 | 交易使用本地钱包 Profile；readiness 和 P21/Paper 不再调用 |
| `GET /v1/token/info` | P20/P21 候选验证、fast path、投研、Paper、Paper 平仓路由 | 同一 CA 在研究/准备/执行重复读取 | 快速交易移除；投研独立保留；Paper 改 Mock/快照 |
| `GET /v1/token/security`、`GET /v1/token/pool_info` | P20/P21 候选验证、投研、fast path | 候选或缓存 miss 造成并行三请求 | P20/P21 快速路径为 0；仅显式完整投研/完整检查允许 |
| `GET /v1/market/rank`、`POST /v1/market/hot_searches` | Candidate warmup、历史回测可选来源 | 后台热榜扫描没有 Trade Intent | 从交易启动移出，只保留投研/回测 scope |
| `POST /v1/trenches` | `dynamic-launch-window.js`，每秒 worker 按允许链轮询 | 当前最明确的隐藏高频调用之一，事件尚未得到完整 CA 就已打 GMGN | 删除 P20 Live 前置轮询；市场发现改独立人工工具 |
| `GET /v1/market/token_kline`、`GET /v1/market/token_top_holders` | Actor backtest、独立投研 | 非交易读取，但可能与实盘共享 Key/IP | 保留能力，独立 research scope、队列和审计 |
| `GET /v1/user/wallet_token_balance`、`GET /v1/user/wallet_activity` | 平仓准备、持仓对账、未知交易/失败取证 | 轮询和失败取证可能在无新 Signal 时持续产生请求 | 余额优先 RPC/本地；Activity 只用于受控恢复/外部卖出核实，不进入买入前置 |
| `GET /v1/trade/quote` | readiness probe、固定 CA Activation、买入/平仓 | readiness/Activation 会把一次事件放大为额外 Quote | 只保留由 Buy/Exit ExecutionSession 持有 lease 的 Quote |
| `POST /v1/trade/swap` | 买入、平仓和受控重试 | 必要写调用，但旧重试可能复制提交风险 | 只由对应 Session 执行；未知结果只 Query/Receipt，不重发 |
| `GET /v1/trade/query_order` | 已提交订单对账 | 必要的结果确认 | 保留，按订单状态退避并通过 Recovery lease |
| `GET /v1/trade/gas_price` | fast path、平仓准备、readiness | 可被缓存 miss 和启动 probe 扩散 | 交易前优先 RPC/本地 gas 状态；不做默认 GMGN 读取 |
| `GET /v1/trade/strategy/orders`、`POST /v1/trade/strategy/cancel` | 平仓保护、策略单对账/取消、readiness probe | Strategy Orders 可能一次业务动作发 open/history 两次读取 | readiness 移除；已有策略单的取消/核验保留，统一 Session 并按状态退避 |

当前没有发现 `axios`、裸 `https.request` 或其他绕过 `gmgn-http` 的业务代码直接访问 `openapi.gmgn.ai`；但这条结论必须由 P24-M0 的静态 import/URL 检查和运行时 request audit 双重证明，不能只依赖本次文本搜索。

### 2.8 现有请求审计的盲区

当前 `backend/lib/provider-rate-recorder.js:11-35` 写入的 `provider_rate_events` 已经包含 endpoint、method、weight、HTTP 状态、source、process role、Signal/Policy/Whitelist ID 和 `context_json`，但还存在三个缺口：

- `backend/lib/gmgn-http.js:115-127` 只保留 source、process role、Signal/Policy/Whitelist ID 和嵌套 context，没有把 `stage`、`trace_id`、`execution_session_id`、`rate_scope` 作为稳定字段传递；
- `gmgn-access-service` 虽然在 access layer 里生成了 stage 语义，但低层 `requestContext` 会丢失没有显式映射的字段；
- 因此当前审计可以回答“哪个 endpoint 被请求”，但不能可靠回答“它属于哪个 ExecutionSession，是否在 Signal 之前，是否与另一个 Worker 共用了同一 lease”。

P24-M0 必须先修复审计再判断调用是否收敛：

1. 为请求上下文定义稳定字段：`source`、`stage`、`signal_id`、`policy_id`、`whitelist_id`、`trace_id`、`execution_session_id`、`rate_scope`；
2. 在 `provider_rate_events` 中增加可索引字段，或将完整规范化对象原样写入 `context_json`，不能只依赖 source 字符串拼接；
3. 每次请求在进入 scheduler 前就固定 provenance，Quote/Swap/Query/Recovery 不能中途换 source；
4. 增加按 `stage`、`session_id`、`signal_id` 聚合的审计查询，明确输出“未触发请求、单 Signal 非 Quote/Swap 请求、无 session 请求、同 Signal 多 session 请求”；
5. 请求审计落库失败必须报警，但不能因为审计失败而自动重发 GMGN 请求。

### 2.9 P24 实施级补充约束

本节是对旧调用审计的实施补充，不改变 P24 的最终业务链路：

- **历史候选不能授权买入**：`dynamic_candidate_index` 中来自 `gmgn_rank`、`gmgn_hot`、`gmgn_trenches`、`gmgn_info` 的候选，只能作为投研或历史回测资料。P20 Live 只有在当前 6551/Grok 事件中提取到完整 CA，并通过本地链/地址/事件归属校验后，才可以创建 Live Signal。不能因为旧索引中的项目名、Ticker、Handle 匹配成功，就恢复动态任务并买入。
- **完整检查必须显式隔离**：P20/P21 的快速 Live Resolver 不得调用 `verifyCandidate`，也不得通过缓存 miss 复活 `token/info`、`security`、`pool`。完整检查只能由独立投研/维护入口人工触发，使用 research 或 diagnostic scope。
- **Provider 低层访问收口**：生产业务模块不得直接 import `backend/lib/gmgn-http.js`。执行、平仓、订单对账、受控恢复、readiness 诊断和 research 必须通过 `gmgn-access-service` 获取带 `stage`、`trace_id`、`execution_session_id`、`rate_scope` 的访问对象；`gmgn-http`、审计器和底层测试是唯一例外。
- **启动 Worker 白名单**：生产 Execution capability 不得启动 `gmgn-cache-warmup`、`gmgn-candidate-cache-warmup`、`dynamic-launch-window`。这些模块即使保留文件，也只能由独立维护/投研命令显式启动，不能由 `server.js` 或 supervisor 间接启动。

## 3. P24 目标项目级链路

### 3.1 统一主链路

```text
外部事件
  -> 6551 监听 / Grok 研究
  -> 策略专属本地解析
  -> 获得完整 CA
  -> 本地最小执行门槛
       chain + CA + 去重 + 信号 TTL + 策略授权 + 预算
  -> 创建一个 Signal / Trade Intent
  -> 创建一个 ExecutionSession
  -> 获取一个全局 Provider lease
  -> GMGN Quote
  -> Quote 后最小本地硬检查
  -> GMGN Swap / 买入
  -> Order / Receipt / Position / Exit
```

`Signal`、`Trade Intent` 和 `ExecutionSession` 是本地编排与审计对象，不是三个额外的 GMGN 调用步骤：

- `Signal`：记录“哪个事件发现了哪个 CA”；
- `Trade Intent`：记录“准备按哪个策略、预算和滑点买入”；
- `ExecutionSession`：记录“一次事件的唯一 Provider owner、trace、lease、Quote 和 Swap”。

页面和日志可以展示这些状态，但它们不能各自触发 Provider 请求。

### 3.2 固定 CA

```text
配置保存 CA/链/预算/退出模板
  -> 配置变化时完成一次本地配置激活与 Watch 同步（GMGN = 0）
  -> Watch 同步
  -> 6551 事件
  -> 本地固定 CA / 关系匹配
  -> Signal
  -> ExecutionSession
  -> GMGN Quote
  -> 最小本地硬检查
  -> GMGN Swap / 买入
```

固定 CA 的 Activation 在 P24 中降级为本地配置生命周期动作，只校验 CA/链/预算/退出模板并同步 Watch，不调用 GMGN。配置没有变化时，新的 6551 事件不能重新 Activation，也不能重新读取 token、wallet、security、pool 或 gas 来“确认已经准备好”。钱包地址和链运行状态来自本地 Execution Profile、RPC 或已持久化的 readiness snapshot。

### 3.3 P20 动态喊单

#### 快速实盘模式

```text
6551 内容事件
  -> 去重、作者归属、intent gate
  -> 本地提取候选 CA
  -> CA + 策略预算/链权限通过
  -> Signal
  -> Dynamic ExecutionSession
  -> GMGN Quote
  -> 最小本地硬检查
  -> GMGN Swap / 买入
```

P20 快速模式中，获得候选 CA 后不创建固定白名单 Activation，也不因为 Candidate Index 缺少快照而自动触发一组 GMGN 读取。

#### 完整检查模式

```text
6551 内容事件
  -> 本地提取候选 CA
  -> 新 chain + CA 首次完整检查一次
  -> 保存候选快照
  -> Signal
  -> Dynamic ExecutionSession
  -> GMGN Quote -> 最小硬检查 -> GMGN Swap
```

完整检查是策略显式选择，不是 Worker 隐式行为。快照属于候选资产资料，不属于每次交易事件的 Activation；后续同一 CA 直接复用，过期时更新资产资料而不是重复创建交易准备链路。

### 3.4 P21 新关注发现

```text
6551 Follow 事件
  -> actor/target 去重和行为键
  -> Grok 4.5 + x_search
  -> 项目、CEO、核心成员关系和 CA 证据提取
  -> 本地证据归一化和策略授权
  -> Signal
  -> Follow ExecutionSession
  -> GMGN Quote
  -> 最小本地硬检查
  -> GMGN Swap / 买入
```

P21 的研究阶段 GMGN 调用数必须为 `0`。`Policy Snapshot` 只保存 CA、证据、关系、策略 Revision、预算和有效期，不能创建 Provider Activation，也不能表示“GMGN 已经验证完成”。

## 4. GMGN 调用预算

### 4.1 按事件状态定义预算

| 状态 | 允许的 GMGN 调用 | 目标数量 | 说明 |
|---|---|---:|---|
| 没有触发事件 | 无 | 0 | 监听、Grok、页面打开、后台 readiness 不得调用交易 Provider |
| 事件未提取出有效 CA | 无 | 0 | 记录 `NO_CA`，不进入 GMGN |
| CA 重复或事件已处理 | 无 | 0 | 记录 `DEDUPLICATED`，不重复 Quote |
| 策略门槛未通过 | 无 | 0 | 记录 `POLICY_REJECTED`，不调用 GMGN |
| 快速 Live 事件 | Quote、Swap | 2 | 两次调用必须属于同一个 ExecutionSession 和 trace |
| P20 显式完整检查事件 | 一次性 Token/Security/Pool，可再 Quote、Swap | 有界 | 只有用户显式选择完整检查时允许；与快速交易分离、记录原因和预算，不能由缓存 miss 或 Worker 自动升级 |
| Swap 已提交但结果未知 | Order query / Receipt 对账 | 按需 | 不能重新 Swap；优先确认原交易状态 |
| Provider cooldown | 无新的低价值请求 | 0 | 已触发信号只能在事件 TTL 内等待共享 Gate，过期则 `EXPIRED` |

### 4.2 禁止绕过共享 Gate

以下模块不得直接调用 `gmgn-http` 或自行创建 Provider scheduler：

- 6551 `event-inbox` 和 Watch reconciler；
- Grok / x_search 研究 Worker；
- P20 Candidate Index 读取层；
- P21 Resolver 和 Policy Snapshot；
- Whitelist Activation Worker 的旧 Provider probe（P24 后只保留本地配置/Watch 同步）；
- readiness、warmup、cache warmer；
- 任何策略自己的交易 Worker。

只有 `ExecutionSession` 通过 `gmgn-access-service` 获取 Provider lease 后，才允许发起 Quote/Swap。

## 5. 全局 Provider Gate

### 5.1 作用域

共享 Gate 必须按真实限流边界配置，而不是仅按策略配置：

```text
P24_GMGN_RATE_SCOPE
  = provider + api profile + egress IP + 账号配额边界
```

本地测试和服务器如果共用同一个 API Key 或出口 IP，必须共用同一个 rate scope；独立测试 API 才能使用独立 scope。只换前端端口、Worker 名称或策略 ID 不能隔离 Provider 配额。

### 5.2 预约规则

```text
Signal 创建
  -> 原子 claim signal
  -> 创建 ExecutionSession
  -> 获取 Provider lease
  -> Quote
  -> lease 续租或保持
  -> Swap
  -> 释放 lease
```

约束：

- 一个 `signal_id` 只能 claim 一次；
- 一个 `trace_id` 只能有一个活动 ExecutionSession；
- Quote 和 Swap 使用同一个 lease、同一个 rate scope；
- 多个不同 Signal 按共享桶串行或有界并发；
- lease 超时只能释放或标记失败，不能复制出第二个 Swap；
- Swap 写入开始后，任何网络错误都先进入不确定状态和对账，不盲目重试。

### 5.3 429 行为

```text
收到 429 / RATE_LIMIT_BANNED
  -> 更新共享 cooldown reset_at
  -> 阻止所有低优先级 Provider 请求
  -> 已触发 Signal 在 TTL 内排队等待
  -> TTL 到期标记 EXPIRED
  -> 不买入过期事件
```

429 不应触发无关策略停机，也不应通过继续预热、重复探测或轮换同 scope 的 Worker 来“测试恢复”。

## 6. 最小代码改动边界

### P24-M0：调用审计基线

- 统计所有 `gmgn-http` 调用点、调用场景、进程角色、策略和 Signal；
- 给每次调用补齐 `source`、`stage`、`signal_id`、`trace_id`、`rate_scope`；
- 建立“未触发事件 GMGN = 0”的测试基线；
- 对所有生产代码执行“业务模块不得直接 import `gmgn-http`”静态检查；允许名单仅包含 `gmgn-access-service`、`gmgn-http` 自身、只读请求审计器 `provider-rate-recorder`、Provider 诊断适配器和底层测试；
- 盘点数据库中 pending/queued 的旧 Activation、Candidate warmup 和旧 Revision 任务，记录数量后统一标记为 `superseded`/`cancelled`；
- 禁止实盘配置变更，先使用 Mock Provider 和独立测试库。

### P24-M1：收回 Provider 调用权

- 6551、Grok、P20 Candidate、P21 Resolver、Policy Snapshot 只输出本地事件或候选资料；
- P21 删除事件级 GMGN Resolver 和 Activation 创建路径；
- P20 将完整验证标记为显式模式，快速模式不自动补读；
- 固定 CA Activation 改为本地配置版本和 Watch 同步，不再调用 GMGN；
- readiness、warmup、cache warmer 不得进入交易热路径，普通 readiness 不得发 Provider probe；
- 将 `gmgn-access-service` 扩展为唯一业务访问边界，覆盖 Quote、Swap、Order query、Strategy query、受控 Balance/Activity recovery 和必要的市场研究接口。

### P24-M2：统一单信号 ExecutionSession

- 由统一 Session 负责 Signal claim、Trade Intent、Attempt、Provider lease、Quote、Swap 和 trace；
- 三策略只负责产生策略专属 Signal，不实现自己的 GMGN 调用；
- 统一 Session 读取本地 Execution Profile 和 RPC 状态，不调用一组默认的 `user/token/security/pool/gas` 预热接口；
- Quote 失败不允许 Swap；
- Swap 未知结果只进入 Order/Receipt reconciliation。

### P24-M3：最小快速门槛

保留必要门槛，但不新增 Provider 请求：

- Signal 未过期；
- 事件未重复处理；
- CA、链和策略作用域一致；
- 单笔/每日预算仍有余量；
- 钱包余额和 Gas 预留可由本地缓存或 RPC 得到；
- Quote 有效、最小输出大于零、价格影响未超过策略上限；
- ExecutionSession 和 runtime revision 未变化。

### P24-M4：共享限流和冷却收敛

- 所有 ExecutionSession 复用 P22 共享 rate state；
- 同一 Key/IP/scope 只允许一个调度器事实源；
- `gmgn-http` 的业务直连收口，任何保留的低层调用都必须通过 access service 注入 `signal_id + trace_id + session_id + stage`；
- 本地与服务器不能各自维护互不知情的 Provider 配额；
- cooldown 期间拒绝低价值请求，只保留 TTL 内已触发 Signal 的受控等待和交易后对账。

## 7. 三策略验收方案

### 7.1 无触发基线

- 三个策略全部配置但没有新事件；
- 连续观察 15 分钟；
- 6551 listener、Grok、readiness、Activation、warmup、cache warmer 的 GMGN 调用均为 `0`；
- Provider audit 中不存在无 `signal_id` 的交易热路径请求。

### 7.2 单 Signal 验收

分别对固定 CA、P20、P21 触发一次有效事件：

- 只生成一个 Signal、一个 Trade Intent、一个 Attempt；
- 快速模式最多 `Quote + Swap`；
- Quote 失败时没有 Swap；
- Swap 提交后只做 Order/Receipt 对账；
- 不产生事件级 Activation、user/token/security/pool/gas 预热请求；
- 请求审计中每个保留 Provider 请求都能关联同一个 `session_id`，且不存在同一 Signal 的第二个活动 Session。

### 7.3 并发 Signal 验收

同时触发固定 CA、P20、P21：

- 三个 Signal 都能被记录；
- Provider 请求经过同一个全局 Gate；
- 并发数不超过配置额度；
- 同一 API/IP scope 下不会出现多个本地调度器同时放行；
- Mock 429 时只进入共享 cooldown，不产生请求风暴。

### 7.4 重复与过期验收

- 重复推送同一事件：GMGN 调用仍为 `0`；
- 同一 CA 不同重复事件：按策略去重规则处理，不重复 Swap；
- cooldown 超过 Signal TTL：标记 `EXPIRED`，不延迟买入旧事件；
- Swap 网络结果未知：只对账，不重发 Swap。

### 7.5 旧路径清理验收

- 启动 Execution capability 后，`gmgn-cache-warmup` 和 `gmgn-candidate-cache-warmup` 没有生产定时器；
- P20/P21 Live 事件不会写入新的 Activation outbox；
- P20/P21 新 Signal 不依赖 `live_activation_state = 'live_ready'` 或 `activation_wait_version` 才能进入唯一 ExecutionSession；
- 历史旧 Revision 的 Activation/Warmup 任务都有取消原因和审计记录，且不会被 Worker 再次消费；
- readiness 页面、策略页面和普通监控轮询不产生 GMGN 请求；显式 Provider 诊断单独计数、单独限流、单独审计；
- Paper 流程不读取生产 GMGN API。

## 8. 兼容性边界

- 固定 CA 的 CA、链、预算、滑点、止盈止损、平仓和历史 Position/Order/Receipt 不迁移；
- P20 的关键词、项目账号、动态预算和候选索引保留；市场候选 warmup 从交易运行时移入独立投研工具；只改变 Provider 调用时机和执行所有权；
- P21 的 Grok/x_search、项目/CEO/核心人员证据和 Policy Snapshot 保留；取消事件级 GMGN 验证和 Activation；
- P19/P12 的 Quote、Swap、Attempt、Order、Receipt、Position、Exit 和 Wallet Lane 继续作为唯一资金执行内核；Paper 使用 Mock/录制数据，不复用实盘 Provider；
- P22 的共享 rate state、cooldown、审计和不确定交易对账继续保留。

## 9. P24 完成标准

P24 只有同时满足以下条件才算完成：

1. 未触发事件的 GMGN 调用稳定为 `0`；
2. 三种策略所有真实买入都能关联唯一 `signal_id + trace_id + execution_session_id`；
3. 快速 Live 单事件最多 `Quote + Swap`，且两次调用由同一个 Provider lease 放行；
4. 固定 CA 配置动作不再调用 GMGN，P20/P21 不再创建事件级白名单 Activation；
5. 多个同时触发信号由同一个全局 Gate 调度，不因 Worker 数量增加而放大请求；
6. 429 冷却期间无低价值调用，过期信号不补买；
7. Mock、Paper、独立测试库回归完成后，才允许单次小额 Live 验收；
8. 固定 CA、P20、P21 的历史资金状态、退出和对账结果无回归。

## 10. 实施顺序

```text
P24-M0 调用审计与无触发基线
   -> P24-M1 收回非执行模块的 Provider 权限并迁移旧 Activation 门禁
  -> P24-M2 统一单 Signal ExecutionSession
  -> P24-M3 快速模式最小门槛
  -> P24-M4 全局 Gate、429 cooldown 和并发回归
  -> 独立测试库 Paper/Mock 验收
  -> 单次小额 Live 验收
```

本方案不在未完成调用审计、Mock 429 回归和独立测试库验收前启动真实交易。

## 11. 本次旧路径清理结论

### 11.1 可以删除或从生产启动链路移除

- P21 `resolver.js` 的 `gmgn_verify` 阶段及其 `verifyCandidate` 调用；
- P20 快速模式的批量 `verifyCandidate`；
- P20/P21 事件物化后的 `enqueueWhitelistActivation`；
- `server.js` 对 `gmgn-cache-warmup` 和 `gmgn-candidate-cache-warmup` 的生产启动；
- `server.js` 对 `dynamicLaunchWindowWorker` 的生产市场轮询，以及 `fetchTrenches` 对 P20 Live 的前置依赖；
- 买入前的 GMGN Wallet Balance/Activity 失败取证；
- Paper Engine 对生产 GMGN Token/User 接口的依赖；
- 页面/普通 readiness 对 Provider probe 的隐式触发。

### 11.2 需要升级而不能直接删除

- `gmgn-http.js`：保留签名、请求、429 观察和底层 endpoint，但禁止业务域直接使用；
- `execution-service.js`：保留真实 Quote/Swap，迁移为唯一 ExecutionSession owner；
- `close-service.js`：保留真实平仓 Quote/Swap/Cancel，使用 Recovery/Exit Session 和同一共享 Gate；
- `reconciliation-service.js`：保留已提交订单和未知结果对账，取消高频 Balance/Activity 轮询，必要时降级到受控 recovery lease；
- `research/service.js` 和 GMGN market source：保留独立投研能力，不能被三策略 Worker、readiness 或 warmup 复用；
- `actor-screening/backtest.js`：保留离线回测能力，但禁止由生产交易 Worker 启动；
- `live_activation_state`、`activation_wait_version`：保留历史数据兼容读取，迁移新 Signal 到 Session 授权，不继续作为事件级 Provider 门禁。

### 11.3 必须保留的真实交易链路

```text
有效事件
  -> 唯一 Signal claim
  -> 唯一 Trade Intent
  -> 唯一 ExecutionSession / Provider lease
  -> GMGN Quote
  -> Quote 结果硬校验
  -> GMGN Swap
  -> Order/Receipt 对账
  -> Position/Exit
```

除 `Quote`、`Swap` 和已经提交后的必要对账外，其他 GMGN 读取不能自动附加到这条热路径。

### 11.4 P24 实施前最终核查清单

1. 代码静态扫描：生产业务域只通过 `gmgn-access-service` 访问 Provider；
2. 调用来源扫描：每次 GMGN 请求都有 `stage`、`signal_id`、`trace_id`、`session_id` 和 `rate_scope`；
3. 状态机扫描：新 P20/P21 Signal 不再等待事件级 Activation；
4. 任务扫描：旧 Revision 的 Activation/Warmup 队列已取消且不会重放；
5. 计数测试：无事件为 `0`，单快速事件为最多 `Quote + Swap`，重复事件为 `0`，未知 Swap 只 Query/Receipt；
6. 回归测试：固定 CA 的配置、匹配、买入、平仓、止盈止损和对账不变；P20/P21 只改变 Provider 调用时机和所有权；
7. 最后才允许独立测试 API 的单次小额 Live 验收。

## 12. v1.4 实施收口记录

- `gmgn-http` 已收口到 `gmgn-access-service`、底层请求审计器和明确的维护/测试脚本；生产业务域无直接低层客户端导入。
- 平仓准备不再自动读取 GMGN `gas_price`；BSC/Base Gas 只从本地执行配置或已持久化/RPC 状态解析，缺失时失败关闭。
- 买入、平仓和恢复请求统一写入 `source`、`stage`、`signal_id`、`trace_id`、`execution_session_id` 与 `rate_scope`；订单对账查询补回原始 Signal/Trace 关联。
- 提交前失败快照只使用本地链状态和调用方已经取得的快照，不再额外读取 GMGN Token Balance/Activity。
- 未知提交结果保留 Order/Receipt 对账；无订单号的不确定 Attempt 不再每轮读取 Wallet Activity，持仓余额检查从常驻轮询改为显式恢复工作。
- 新增只读 `/api/trade/provider-audit` 审计视图，用于检查缺失调用上下文、同一 Signal 多 ExecutionSession 和策略热路径混入的非 Quote/Swap 请求；该接口只读本地审计表。
- 验证结果：后端 `457/457` 测试通过，前端 `tsc -b && vite build` 通过，正式前端 `/strategies`、`/strategies/dynamic`、`/strategies/follow-discovery`、`/signals`、`/settings` DOM 均非空且无控制台错误。
- 本轮没有启动后端、没有点击实盘交易、没有调用 GMGN 真实下单接口，也没有更新服务器或 GitHub。
