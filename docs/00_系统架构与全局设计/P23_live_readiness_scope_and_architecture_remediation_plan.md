# P23 实盘就绪分层、策略作用域与历史链路治理方案

> 版本：v1.0
>
> 状态：第一阶段代码治理、独立迁移演练、完整回归和隐私扫描已完成；生产审计、服务器发布和真实交易验收待完成
>
> 审计日期：2026-08-08
>
> 审计范围：P1-P22 方案文档、当前工作区代码、Migration 000-040、自动化测试、服务启动脚本、配置和发布边界

## 1. 结论

本轮二次确认弹窗的问题不是单个 GMGN 接口故障，而是三个边界叠加：

1. **启动确认没有策略作用域**：设置页调用的 `/api/system/arm/prepare` 不接收 P21 Policy ID 或目标链；后端通过全局 `live_policy` 计算摘要。因此 P21 测试会显示固定 CA 的 30 个白名单、15 个 Watch、720 条关系。
2. **就绪检查把能力、策略和外部探测混在一起**：GMGN 调度器、GMGN 契约探测、策略只读探测、链生产批准、固定 CA 配置、P20 动态配置和 P21 关注发现没有分层，任何一层失败都可能出现在同一个确认弹窗。
3. **准备与确认没有复用同一份就绪快照**：准备阶段在 `arm-preparation-service.js:79-81` 调用 `getSnapshot({ probe: true })`；确认阶段在 `:142-150` 再次读取 readiness 和 policy，但保存的 `snapshot_hash` 没有作为确认输入使用。确认阶段当前通常不会再次执行完整外部 probe，但会重新读取全局数据库状态，仍然可能得到与弹窗不同的结果。

截图中的三项红色内容具有明确含义：

- `GMGN_SCHEDULER_NOT_HEALTHY`：调度器确实处于 cooldown，属于阻塞新买入的真实状态；
- `CONTRACT_PROBE_FAILED`：准备阶段对当前全局固定白名单执行了 GMGN 只读探测，探测失败后被提升为 blocker；
- `STRATEGY_PROBE_FAILED`：同一准备阶段对当前全局策略订单接口执行探测，失败后被提升为 blocker；
- `GMGN_TRADE_WEIGHT_REFILLING`、`FAST_PATH_WARMER_DISABLED_LAZY_LOAD`：它们属于 advisory，但前端复用了 `blockerLabel()`，且缺少对应标签，所以显示成“未识别的阻断项”。这是前端契约错误，不代表这两项本身阻塞启动。

P23 的核心决定是：**固定 CA、P20 动态策略、P21 新关注发现继续共享同一交易执行内核，但必须共享“执行能力”，不能共享一个无作用域的“业务就绪快照”。**

本方案暂不改变 CA 匹配、Grok/x_search、GMGN 验证、Quote、Swap、止盈止损、平仓、对账和预算业务语义；先修复启动作用域、就绪语义、快照一致性和服务编排。

## 2. P1-P22 复盘矩阵

| 方案 | 主要产物 | 当前保留价值 | P23 发现的历史遗留 |
|---|---|---|---|
| P1-P5 | 原型、基础白名单、Paper、初期风控、环境读写 | 作为历史数据和早期验收证据 | 文档中仍有原型时代的“已完工/当前状态”表述，不能作为运行事实；旧风险和模拟入口必须由可达性清单管理 |
| P6 | `signal/paper/live` 模式边界和 Provider 抽象 | 定义运行模式原则 | 全局模式与策略级 `mode` 的职责没有完全统一，P21 的 `paper/live` 是领域语义，系统 `TRADING_MODE` 是进程语义，缺少显式兼容契约 |
| P7 | TwitterAPI.io 早期信号 MVP、Follow baseline | 关系去重和 Signal-only 经验 | TwitterAPI.io、SocialData、轮询 Job 仍作为显式回退/测试资产存在；生产默认不可达，但需要统一登记和定期 reachability 检查 |
| P8/P8.1 | 6551 Max、WSS、Inbox、显式关系 | 当前 X 事件主链路 | 6551 只负责事件采集和 Watch，语义上已与研究和交易分离；但设置页和 readiness 仍把它与全局交易条件混合展示 |
| P9 | GMGN 托管交易、Adapter、Quote/Swap/Order/Receipt | 当前唯一资金执行内核 | Provider 调度已集中到 `gmgn-http`，但业务模块仍直接选择多个 GMGN 读接口，缺少统一的“场景、优先级、作用域、缓存策略”访问契约 |
| P10/P11 | Readiness、Engine 授权、真实交易门禁 | 真实交易安全基线 | 全局 arm 只表达 Engine 能否启动，后来被扩展成业务策略汇总，造成 P21 测试被固定策略污染 |
| P12 | Trade Intent、Attempt、Wallet Lane、Retry、Receipt | 资金一致性和不确定结果处理 | 业务状态机已经较清晰，但 readiness 仍是跨域大快照；退出和对账应保持 always-on，不应依赖新买入 scope |
| P13 | 白名单拥有配置、Watch Outbox | 固定 CA 配置所有权 | 固定 CA 是正确的业务授权源；P21/P20 采用独立授权表后，设置页仍以固定 CA 统计作为默认范围 |
| P14 | 链能力、Contract Evidence、Acceptance Scope、生产批准 | 链级上线门禁 | “代码可用、合同已测、Shadow、生产批准”仍全部塞进链卡片；未选中的链也可能阻塞全局启动 |
| P15 | 设置页三视图、维护工具退出日常前端 | 当前 UI 信息架构基线 | P15 原则要求渐进披露，但启动弹窗再次把 Provider 诊断细节全部暴露；需要把详情和交易确认分离 |
| P16/P16.1/P16.2/P16.3/P16.4 | 投研、模板、生态关系、未发币监控、四步工作区 | 复用模板和证据的基础 | 维护工具、研究工具、策略运行状态多次扩展，形成多处“研究/探测/激活”入口；P23 只保留一个业务入口和一个维护入口 |
| P17 | 热激活、Outbox、临时恢复、紧凑 arm | 当前 Engine 恢复和一次性授权基础 | `arm_preparations` 只保存摘要和 hash，没有保存可供确认复用的最小快照；过期/失败/旧 Revision 需要统一清理和审计 |
| P18 | Supervisor、服务器发布、数据迁移 | 生产部署基线 | 本地 Supervisor、`server.js --role`、旧的 all 角色和手动启动脚本并存；需要明确唯一生产启动入口和实例互斥 |
| P19 | 低延迟执行、Fast Path、实时队列 | 当前执行链路 | P19 的快路径正确地绕过逐笔完整 readiness，但启动、恢复和人工确认仍会调用全局 readiness，语义不一致 |
| P20 | 动态解析、账号策略、Candidate Index、链预算矩阵 | 当前动态策略主链路 | P20 readiness 已有独立动态状态，但仍与固定策略合并成一个 `executionPolicy`；设置摘要和 arm 不能表达“只启用某条动态策略” |
| P21 | 账号研究独立化、新关注发现、Grok/x_search、复用交易管线 | 当前关注策略主链路 | P21 事件和授权已有独立表，但 Engine readiness 不识别 P21-only 场景；Follow 解析 worker、GMGN 验证和 Whitelist Activation 需要统一 trace |
| P22 | GMGN cooldown、共享限流状态、P21 验证快照 | 限流和首次交易压力治理 | 限流已集中，但价格监控、研究、准备探测、激活和 Follow 验证仍缺少统一调用预算；`429` 状态仍容易被人工确认界面误读为全系统故障 |

## 3. 发现的问题分级

### 3.1 P0：必须在下一次 P21 实盘前解决

#### P0-1：Arm 没有 Policy Scope

证据：

- 前端 `frontend/src/pages/SettingsPage.tsx:176-177` 只调用 `prepareArm()`；
- API `frontend/src/lib/api.ts:293-296` 没有策略或链参数；
- `backend/domains/system/arm-preparation-service.js:16-54` 以全局 `livePolicy` 构造 context；
- `backend/domains/trade/readiness-service.js:559-570` 将固定 Policy 与全部有效 P20 动态链合并；
- `backend/domains/trade/runtime-policy-summary.js:13-65` 的范围统计也只以固定 `livePolicy` 为准。

后果：

- P21 只想测试一个 KOL 和一条链，却显示固定 CA 全量统计；
- Robinhood 未完成会阻塞只想测试 SOL/BSC/Base 的 P21；
- 只有 P21、没有固定 CA/P20 时，`LIVE_POLICY_EMPTY` 和 `NO_LIVE_CHAIN_READY` 可能错误阻塞；
- 用户无法从弹窗判断“这次确认究竟会允许哪些策略交易”。

#### P0-2：准备快照和确认快照不是同一份

现有数据库保存 `configuration_fingerprint`、`policy_fingerprint`、`snapshot_hash`，但确认只比较 configuration、policy 和 activation versions，没有校验 `row.snapshot_hash`，也没有从持久化快照还原 Engine 所需的 readiness snapshot。

后果：

- 准备弹窗显示的链和 blockers 与确认时重新读取的结果可能不一致；
- 429、链状态、激活状态在 60 秒内变化时，用户得到“确认失败”但没有明确指出是快照过期、scope 变化还是 Provider 冷却；
- 通过“重新检查”会重新触发全局探测，而不是只刷新选定 scope。

#### P0-3：P21 不被全局 readiness 识别为独立可交易来源

现有 readiness 的 `LIVE_POLICY_EMPTY`、`fixedChainReady`/`dynamicChainReady` 和部分 whitelist/relation 校验只覆盖固定 CA 与 P20 动态策略。P21 的 signal 在 `runtime-signal-authorization.js` 中走独立 follow authorization，但 Engine 启动门没有对应的 `followChainReady` 和 `followPolicyConfigured`。

这会产生相反的两种错误：P21-only 被错误拦截；固定 CA 已通过时，P21 是否配置正确又无法在启动摘要中被准确看见。

### 3.2 P1：影响限流、可操作性和故障恢复

#### P1-1：外部探测 fan-out 仍由全局 CA 数量决定

`getSnapshot({ probe: true })` 会对固定 policy 的链、白名单、RPC 和策略订单执行探测；`probeContracts()` 以最多 4 个并发请求 `getTokenInfo/security/pool_info`，`probeStrategies()` 再按链请求 Strategy Orders。一次人工启动可能在实际交易前消耗大量 GMGN 权重，并在第一次 429 后留下多个失败结果。

P22 已阻止 cooldown 期间继续排队，但没有解决“为什么人工启动要探测不相关的 30 个 CA”这个上游问题。

#### P1-2：Advisory 使用了 Blocker 文案契约

`SettingsPage.tsx:487-489` 使用 `blockerLabel()` 渲染 advisory；`display-labels.ts` 没有完整的 advisory label/action 映射。于是 `GMGN_TRADE_WEIGHT_REFILLING`、`FAST_PATH_WARMER_DISABLED_LAZY_LOAD` 等正常的降级提示显示为原始错误码或“未识别的阻断项”。

必须把 `blockers`、`advisories`、`chain blockers` 变成三种不同 DTO，禁止前端通过数组位置和同一个 label 函数猜语义。

#### P1-3：全局状态摘要重复读取同一业务数据

`runtime-policy-summary.js`、`arm-preparation-service.js` 和 `readiness-service.js` 各自查询 policy、白名单、关系、链状态，再在前端分别展示。相同数据的计数和 scope 可能不一致，形成“弹窗 30/15/720、设置页其他数字、策略页另一个数字”的漂移。

P23 不再增加新的统计查询，而是让一个 `runtime-scope-service` 产出统一的 scope manifest，供 readiness、arm、runtime summary 和前端 DTO 复用。

#### P1-4：`429` 的业务影响没有按 scope 表达

调度器 cooling 是 Provider 级事实，但当前 readiness 将其直接作为全局 blocker。P22 的正确语义是“暂停新买入并等待 reset_at”，不是自动停止已有持仓保护；UI 应显示 Provider cooldown 的剩余时间和受影响的 scope，而不是简单的“调度器状态异常”。

#### P1-5：潜在高频旧入口仍存在（本轮已完成第一批清理）

复核初始发现 `backend/jobs/price-monitor.js` 在 cron 被关闭时不可达，但代码仍会在 live position 上逐仓调用 GMGN Token Info；如果误启用 cron，会绕过 P19 的持仓价格/对账访问预算。该 Job、旧 `signal-matcher`、`risk-manager` 及对应旧测试已在本轮删除。P7 的轮询 Job、旧 Provider 和 legacy feature 仍作为显式回退或维护资产存在，后续必须继续按 reachability manifest 收敛。

这些文件不能仅因前端没有入口就删除；本轮已用 P12 可达性清单、生产启动引用、API 路由、测试和维护脚本逐项核对，确认无生产引用的三类旧代码已删除，其余按显式回退或维护入口保留。

### 3.3 P2：结构、文档和发布治理问题

- `backend/scripts/supervisor.js` 是正式 `npm start` 入口，但 `server.js --role=all`、`start:all`、`start-local-supervisor.cmd` 和开发模式仍并存；生产已通过 `check-env` 禁止 all，但本地测试容易同时启动两套服务。
- 两个角色都会执行 Migration runner；数据库 advisory lock 能保证串行，但启动流程没有独立的 schema phase，导致重复等待和难以观测。
- `followDiscoveryWorker` 固定单并发，每个事件可能触发一次 Grok fast/fallback 及多组 GMGN 读请求；缺少统一的 provider budget、最大并发和 trace 摘要。
- `docs/ENGINEERING_LOG.md` 和早期 P1-P18 文档保留了历史状态，`docs/README.md` 的当前入口也尚未包含 P21/P22/P23，容易让部署人员使用过时结论。
- 工作区存在 `.vite/`、本地日志、数据库 dump、PEM 和 `.env`。Git ignore 能阻止上传，但它们仍是本地隐私和误操作风险，不应作为发布输入。

#### P23 全历史清理复核结论

本次复核范围扩展到 P1-P22 的全部后端、前端、迁移、启动脚本、cron、测试和维护文档，不以“当前页面没有入口”作为删除依据，而以生产/脚本/维护/测试可达性分别核对。

已完成第一批无生产可达代码清理：

- 删除 `domains/signal/risk-manager.js`：只被已废弃的 `signal-matcher` Paper 风控路径引用；Live 已由 `execution-service` 负责，P20/P21 不依赖它；
- 删除 `jobs/signal-matcher.js`：旧的轮询匹配和 Paper 执行 Job，当前服务器不启动，Live 由 `live-execution-queue` 处理；
- 删除 `jobs/price-monitor.js`：旧的逐仓 GMGN 价格轮询和 Paper 平仓 Job，当前 cron 未启用，Live 平仓由统一 Strategy/Close/Receipt 链路处理；
- 删除上述三个旧入口对应的专用测试，避免测试继续为已删除的运行链路提供伪覆盖；
- `backend/cron.json` 收敛为空配置，当前常驻 worker 不再通过旧 cron 重复注册；
- `.vite/` 加入 Git 忽略，构建缓存不再成为发布候选。

以下资产本轮明确保留，不视为垃圾代码：迁移文件 000-040、交易和信号历史表、固定 CA/P20/P21 授权模块、`live-execution-queue`、`execution-service`、`close-service`、对账/Receipt/Retry、P20 Paper 入口、Shadow 维护工具、6551 主客户端、旧 Provider 的显式回退客户端以及独立审计/迁移演练脚本。它们分别有数据兼容、资金保护、显式运维或测试可达性；后续只有在可达性清单和等价测试同时通过后才能归档。

本轮还清理了以下确认无当前运行用途的发布残留：`backend/.env.example` 中的 `CRON_ENABLED`、旧 GMGN 全局额度和 P8 事件白名单；已选方案 A 之外的 P21 方案 B HTML 预览；以及本地 `.codex-*.log`、`vite*.log` 生成日志。`.env`、PEM、数据库备份、生产日志和历史交易数据不在清理范围内。

## 4. P23 目标架构

### 4.1 四层职责

```text
Runtime Control
  Engine: stopped / running / paused_transient / fault_protected
  只负责全局新买入开关、恢复意图、停止和告警

Runtime Scope
  fixed_ca / dynamic_policy / follow_discovery
  每个 scope 有 policy_id、revision、allowed_chains、授权快照和交易模板快照

Readiness
  global checks + scope checks + chain checks + provider advisory
  只检查选定 scope；未选链不能阻塞本次确认

Execution Core
  Signal -> authorization -> intent -> attempt -> GMGN quote/swap/order -> receipt -> position/exit
  固定 CA、P20、P21 只通过这里进入资金执行
```

### 4.2 统一 Runtime Scope Manifest

新增一个只读领域服务，不新增三套策略表：

```text
runtime-scope-service
  listActiveScopes()
  resolveScope({ type, id, chains })
  buildManifest(scope)
  fingerprint(manifest)
```

Manifest 至少包含：

- `scope_type`、`scope_id`、`policy_revision`；
- `chains` 和每条链的预算/生产授权状态；
- 固定 CA 的 whitelist IDs；
- P20 的 dynamic policy ID；
- P21 的 follow policy ID、KOL、Watch 同步状态；
- 交易模板版本和不可变交易配置快照；
- scope 的 `context_hash` 和受影响的旧 Revision 数量。

`live-policy.js` 继续作为固定 CA 的授权实现，不将 P20/P21 强行塞入固定关系表。`runtime-signal-authorization.js` 继续按 signal kind 路由到 dynamic/follow authorization。统一服务只负责组合 scope 和展示，不替代三种授权逻辑。

### 4.3 分层 Readiness DTO

后端统一输出以下结构，前端不得再根据单个字符串数组猜语义：

```json
{
  "ready": false,
  "scope": { "type": "follow_discovery", "id": 2, "revision": 1 },
  "global": { "blockers": [], "advisories": [] },
  "chains": [{ "chain": "sol", "ready": true, "blockers": [], "advisories": [] }],
  "provider": { "cooldown_until": null, "affected": [], "advisories": [] },
  "checks": { "probed": false, "snapshot_hash": "..." }
}
```

规则：

- 全局 blocker：Engine 配置、管理员授权、未解决资金写入、持仓保护、必要的 6551 采集健康；
- Scope blocker：Policy 关闭/过期、Revision 变化、模板/预算无效、Watch 未同步、目标链未批准；
- Chain blocker：只对 `scope.allowed_chains` 生效；Robinhood 未配置不能阻塞只测 SOL 的 P21；
- Provider advisory：权重恢复中、缓存预热关闭、延迟样本不足、告警未验证；
- Provider cooldown：禁止继续发起低价值探测，显示 `reset_at` 和受影响 scope；已有仓位对账和平仓继续运行。

### 4.4 两阶段确认必须复用快照

#### Prepare

`POST /api/system/arm/prepare` 接收显式 scope：

```json
{
  "scope_type": "follow_discovery",
  "scope_id": 2,
  "chain_ids": ["sol"]
}
```

准备阶段默认只读现有缓存、最新 Evidence、Watch 状态和 RPC 健康；只有用户点击“刷新外部探测”才执行有界 GMGN probe，且只针对所选 scope。

持久化：

- 一次性 token hash；
- `scope_manifest_hash`；
- `readiness_snapshot_hash`；
- 最小的无秘密 `readiness_snapshot`；
- `scope_type/scope_id/policy_revision`；
- 过期时间和检查来源。

#### Confirm

确认阶段不重新请求 GMGN，不重新执行全局 readiness probe。它只在事务中：

1. CAS 消费 token；
2. 比较 scope revision、context hash、配置 fingerprint 和 activation versions；
3. 比较准备阶段的 `readiness_snapshot_hash`；
4. 使用保存的最小 readiness snapshot 调用 `engineState.arm()`；
5. 写入 audit，返回明确的 `ARM_PREPARATION_EXPIRED`、`ARM_SCOPE_CHANGED` 或 `ARM_SNAPSHOT_STALE`。

如果确认前发生真实资金风险变化，必须阻塞并要求重新准备；不能为了减少弹窗而放宽门禁。

### 4.5 GMGN 访问统一入口

保留底层 `gmgn-http` 签名和 Adapter，但新增 `gmgn-access-service` 作为业务访问契约：

| 场景 | 允许请求 | 优先级 | 失败行为 |
|---|---|---:|---|
| P21 Grok 阶段 | 不调用 GMGN | - | 由 xAI 搜索结果决定是否进入验证 |
| P21 候选验证 | Token Info、Security、Pool | 事件验证 | 429 按 reset_at 等待，其他未知字段拒绝 |
| P21 激活 | Wallet、RPC、已保存 verification snapshot | 激活 | 不重复 Quote，不重复 Security/Pool |
| 固定 CA 激活 | Wallet、RPC、按既有契约 Quote | 激活 | 保留固定 CA 原语义 |
| P20 动态 | Candidate、Token、Quote | 事件/交易 | 复用缓存，按策略和事件限额 |
| 真实交易 | Quote、Swap、Order | 新交易/对账 | Swap 不盲重试，未知结果进入对账 |
| 研究/历史工具 | 明确用户操作的只读查询 | 低优先级 | cooldown 期间不排队 |
| 价格监控 | P23 前禁止逐仓 cron 直查 | - | 迁移到统一价格/对账调度后再开放 |

所有请求必须带 `source`、`process_role`、`policy_id`、`whitelist_id`、`signal_id`（可空）和 `trace_id`。P22 共享桶按实际 Provider 配额边界配置，测试 profile 和生产 profile 默认分开，若同一出口/IP 受共同限制则显式配置共享 scope。

## 5. P23 实施阶段

### P23-M0：冻结和基线

- Engine 保持 stopped；不调用 `arm/prepare`；不改历史 Signal、Position、Order、Receipt；
- 执行 `prelive-audit.js` 只读检查，必要时使用 `--expire-stale` 处理过期旧 live recorded signal；
- 记录 Migration 000-039、服务角色、监听端口、Provider profile、GMGN cooldown、P21 pending/processing 事件和 activation outbox；
- 固定 CA、P20、P21 当前配置导出为脱敏摘要。

### P23-M1：先修复 DTO 和前端二次确认

- 增加独立 `advisoryLabel/advisoryActionLabel`；
- 弹窗显示“本次 Scope”而不是全局 30/15/720；
- blocker、advisory、链状态分别显示；
- cooldown 显示剩余时间、受影响 scope 和“稍后重试”，不显示“系统故障”；
- 未选链不出现在本次确认卡片；
- Scope 详情只读，不增加第二个业务配置入口。

### P23-M2：统一 Scope Manifest 和 readiness

- 先以查询服务组合现有 fixed/dynamic/follow 表，不删除现有授权模块；
- readiness、runtime summary、arm summary、scope detail 全部改用同一 Manifest；
- P21-only、P20-only、fixed-only 和多策略组合分别测试；
- 保持旧 API 响应字段兼容一轮，但新增 `scope` 和分层 DTO，发布后再移除旧全局 counts。

### P23-M3：修复 prepare/confirm 快照契约

- 新增 Migration 040，仅 additive 增加 scope 字段和最小 readiness snapshot；
- prepare 只执行一次明确授权的 probe；
- confirm 不再做全局 GMGN probe；
- 旧 Revision 自动变为 stale，排队任务只能取消，不能被旧 worker 恢复；
- 过期、失败、消费完成的 `arm_preparations` 保留审计，但由维护任务归档，不删除资金历史。

### P23-M4：治理 Provider 调用和服务编排

- 所有 GMGN 读写经过统一访问契约；
- 已删除 `price-monitor` live cron 入口；后续价格/离场能力只能通过统一 Strategy、Close、Receipt 和对账链路提供；
- Follow worker 增加有界并发、事件级 trace、provider budget 和取消水位线；
- 生产只允许 `npm start -> scripts/supervisor.js -> ingestion/execution`；
- `server.js --role=all` 只保留开发/专用集成测试用途，生产继续拒绝；
- schema migration 已从业务角色启动中分离为 Supervisor 的独立发布阶段；`run-migrations.js` 完成后才启动两个业务角色，本地 `server.js --role=all` 仍支持开发自举；
- 增加实例锁/角色心跳审计，发现本地和服务器同时持有相同 6551/GMGN 生产凭据时阻断新买入。

### P23-M5：文档、隐私和垃圾资产治理

- `docs/README.md` 作为唯一当前入口，加入 P21/P22/P23；
- `ENGINEERING_LOG.md` 只保留历史记录，不再写“当前状态”；易变状态全部链接到 audit 命令；
- `.vite/`、`frontend/dist`、日志、数据库 dump、PEM、`.env` 永不进入发布包；
- `private_key.pem` 和 `public_key.pem` 即使被 ignore，也应移到仓库外的密钥目录；
- P21 仅保留用户选定的方案 A 预览；预览文件不进入前端路由或生产构建；
- 运行 `git ls-files`、secret scan、`git diff --check`、构建和 Schema Audit 后才允许提交。
- 第一批不可达旧代码已完成删除；剩余旧 Provider、Paper、Shadow、轮询回退和维护脚本必须在 reachability manifest 中标注 owner、启用条件、唯一入口和删除前置，不允许继续以“暂时保留”作为永久状态。

## 6. 测试与验收

### 6.1 必须新增的自动化测试

| 测试 | 预期 |
|---|---|
| `arm` scope 只选 P21 policy 2 | 摘要只含 P21 的 KOL、链、模板和事件，不出现固定 CA 的 30/15/720 |
| P21-only + Robinhood 未完成 + SOL 已完成 | 可以准备；Robinhood 不成为 blocker |
| P21-only 无固定 CA/P20 | 不出现 `LIVE_POLICY_EMPTY` 或 `NO_LIVE_CHAIN_READY` 的错误阻塞 |
| fixed-only 回归 | counts、授权、Watch、链门禁与 P22 前一致 |
| P20-only 回归 | 只检查动态策略允许链和链预算 |
| prepare -> confirm | confirm 不调用 `getSnapshot({ probe: true })`，使用同一 snapshot hash |
| readiness 在两次之间变更 | 返回 `ARM_SNAPSHOT_STALE` 或 `ARM_SCOPE_CHANGED`，不启动 Engine |
| advisory 映射 | `GMGN_TRADE_WEIGHT_REFILLING` 和 `FAST_PATH_WARMER_DISABLED_LAZY_LOAD` 不再显示为 blocker |
| 429 cooldown | 不产生新的低价值探测，不延长 cooldown；已有持仓对账仍可运行 |
| P21 Grok | `x_search` 是研究阶段工具，6551 只产生 Follow 事件，不负责 CA 搜索 |
| P21 证据 | 回复/转发/搜索摘要中的 CA 不能授权；人员关联必须有项目账号双向证据 |
| 旧 Revision | pending/processing 任务取消且 stale worker 无法物化白名单或 Signal |
| 角色互斥 | ingestion 与 execution 各自唯一；重复 Supervisor/WSS/worker 不会同时运行 |
| 冷启动 | Engine stopped 时不调用 GMGN probe；只有明确恢复 persisted desired intent 才进入受控恢复 |
| Record/Paper | Record 不创建白名单/Signal；Paper 不调用 GMGN Swap |

### 6.2 发布前检查

```text
[x] Migration 000-040 在独立测试库按文件名顺序演练
[ ] 生产只读 Schema Audit 通过
[x] backend npm test 通过
[x] frontend typecheck/build/lint 通过
[x] 无 secret、PEM、dump、.env、日志进入 Git index
[ ] 固定 CA 回归：保存、Watch、激活、买入、止盈止损、平仓、对账
[ ] P20 回归：Record/Paper/Live 资格和按链预算
[ ] P21 回归：Baseline、Follow、Grok/x_search、唯一 CA、GMGN 验证、旧 Revision
[ ] 429 fixture：cooldown、reset_at、恢复，不调用真实封禁接口
[ ] 本地只运行一套 supervisor；服务器与本地不共用生产 GMGN/X 凭据
[ ] Engine stopped，P21 先 Record，再 Paper，最后单 KOL 小额 Live
```

### 6.3 P21 单次实盘的前置条件

P23 代码更新和 Migration 040 验收完成前，不进行新的真实买入。完成后，测试只允许：

1. 选择一个 P21 Policy 和一个明确链，确认弹窗显示的 scope 与策略页一致；
2. 先用 Record 验证 `xueqiu88` 的 Follow 事件入库、Baseline 和 `behavior_key`；
3. 用 Paper 验证 Grok/x_search -> 本地证据 -> GMGN 地址核验 -> 共享 Signal 链路，确认 Swap 为 0；
4. 清空旧事件和 pending outbox 后，用户明确确认一次小额 Live；
5. 实时观察 Follow event、Grok evidence、GMGN verification snapshot、Whitelist activation、Signal、Attempt、Order、Receipt、Position 和 Exit；
6. 交易完成后人工平仓，并核对资金、Receipt、Lot、Budget 和审计记录；
7. 测试结束立即停止 P21 scope 或 Engine，不能把本次确认变成永久全局 Live。

## 7. 回滚和兼容

- Migration 040 只新增字段，不删除 P1-P22 表和历史数据；
- P21/P20/fixed 授权模块继续保留，P23 初期只改变其组合和启动展示；
- 新 Scope DTO 出错时，后端返回明确的 `SCOPE_RESOLUTION_FAILED`，不静默退回全局 scope；
- 发现 scope 计算错误时，停止新买入、保留对账和平仓，恢复到 `LIVE_TRADING_ENABLED=false` 和 Engine stopped；
- 不使用 `git reset --hard`、不回滚用户已有修改、不删除历史交易；
- 后续旧 Provider、Paper、Shadow 和人工回退脚本仍须由 reachability manifest 管理；新增删除必须先有调用图、等价测试和明确 owner，不再以“暂时保留”代替治理结论。

## 8. P23 完成定义

P23 只有同时满足下列条件才可以标记完成：

1. 二次确认显示的范围与用户选定策略、Revision、链和模板完全一致；
2. P21-only 不再被固定 CA 数量或未选链阻塞；
3. prepare/confirm 使用同一个可审计 snapshot，确认阶段不触发全局 GMGN fan-out；
4. blocker/advisory/provider cooldown 文案和动作一致；
5. 固定 CA、P20、P21 的交易执行仍进入同一 P19/P12 资金链路，现有 426 个回归测试保持通过并新增 P23 覆盖；
6. 本地、测试库和生产服务器的角色、Migration、Provider profile、Watch ownership 和凭据边界可审计；
7. 不可达旧代码已删除或进入有 owner 的维护包，禁用入口不会残留可执行引用；
8. 隐私扫描、Schema Audit、构建、部署 smoke test 和单次 P21 Paper/Live 验收全部通过。

当前状态必须表述为：**P23 第一阶段代码治理、独立测试库 Migration 000-040 演练、完整回归和隐私扫描已通过；生产只读 Schema Audit、服务器发布检查和真实交易验收尚未完成，真实交易未启动。**
