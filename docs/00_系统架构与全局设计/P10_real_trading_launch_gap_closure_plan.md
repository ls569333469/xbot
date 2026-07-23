# P10 XBOT 真实交易上线差距收敛与执行方案

> 文档编号：P10  
> 创建日期：2026-07-22  
> 当前状态：执行中；四链 RPC、双进程共享心跳、Supervisor 和按链真实交易证据已完成  
> 上位基线：[P9_gmgn_live_trading_execution_plan.md](./P9_gmgn_live_trading_execution_plan.md)  
> 信号基线：[P8_6551_max_realtime_signal_execution_plan.md](./P8_6551_max_realtime_signal_execution_plan.md)  
> 本文目标：把“已经具备的真实资金能力”与“仍需修复、配置和验收的项目”拆开，先完成可控真实 Buy/Close，再开放单关系自动实盘。

---

## 一、结论

XBOT 并不是从零开始接入真实交易：GMGN 官方 `/v1` 鉴权、报价、Swap、订单查询和策略查询已经接入，CUPSEY 已完成过一次真实买入、全部卖出和历史回填，资金执行核心具备真实基础。当前后端自动化测试 `111/111` 通过，前端生产构建通过。

但是，项目现在还不能直接声明为“可以安全自动实盘”。真正缺少的不是继续堆叠模拟逻辑，而是以下真实运行闭环：

1. 自动交易首次上线仍需要一笔受控首单验收；它不是产品运行模式，只用于确认真实 Buy、Strategy、Receipt 和 Close 全链路正确。
2. 资金告警 Outbox 目前只写日志和浏览器 WebSocket，没有真正发送到 TG；根据 2026-07-22 决定，TG 作为后续增强，不阻挡本轮自动交易核心修复。
3. 链级 `contract_tested/shadow_verified/live_enabled` 只是数据库验收状态，不是交易记录；真实交易记录保存在 Attempt、Order、Receipt、Position 和 Lot 表中。目前只有 SOL CUPSEY 有完整历史资金记录。
4. 四链公共 RPC 已配置并实测主网身份；正式高频运行前仍应将限流公共端点替换为带 SLA 的专用节点。
5. 双进程 6551 状态误报已修复，API 现在读取 ingestion 写入数据库的共享心跳。
6. 当前预算仍是原型默认值，例如 SOL 单笔 `1 SOL`、每日 `5 SOL`，不适合作为首轮小额实盘上限。
7. Supervisor 已加入并通过配置重启实测；OS 开机自启动仍需在正式部署阶段配置。

因此 P10 将真实交易拆成两个互不混淆的目标：

| 目标 | 含义 | 是否需要 24 小时 Shadow |
|---|---|---|
| 自动交易首单验收 | 自动系统上线前只允许一条指定 Signal、指定 CA、指定金额执行一次 Buy/Close；验收完成后不作为日常模式 | 否，但必须通过 GMGN、RPC、预算和单笔确认检查 |
| 自动实盘 | 新的合格 6551 Signal 可自动进入 Buy；已有仓位持续对账和退出 | 是，且必须达到 P10 自动实盘验收标准 |

在不受外部 API 故障影响的情况下，预计完成代码修复、配置和首个 SOL 人工 Buy/Close 需要 `1-2` 个开发日。自动实盘还需要至少 `24 小时 + 50 条有效 Signal` 的真实观察，以及 `3-5` 天单关系灰度，这部分是运行时间，不是继续开发模拟盘。

---

## 二、2026-07-22 当前事实

### 2.1 已完成

- [x] GMGN API Key 与签名私钥有效。
- [x] GMGN API Key 已确认为 XBOT 新建且独占，当前 `GMGN_KEY_EXCLUSIVE=true`。
- [x] GMGN Weighted Scheduler 正常，内部额度为 `14 weight/s`，当前无 429、无冷却、无排队。
- [x] Buy、Order、Strategy、Reconciler、Close、Lot、PnL 和链上 Receipt 代码已经形成。
- [x] Swap 和其他资金写请求不自动重试；不确定结果进入持续对账。
- [x] 已有一轮 CUPSEY 真实 Buy/Close 资金事实，并已完成数据库恢复。
- [x] 当前没有未处理的 `submission_uncertain`，没有未保护的 Live Position。
- [x] 6551 已配置为实时数据源，WSS 已启用，Inbox 已收到真实事件。
- [x] 当前已真实验收的自动事件类型只有 `reply`。
- [x] 用户确认四链均已充值；GMGN 实时只读核对为 SOL `0.492438771`、BSC `0.1 BNB`、Base `0.02 ETH`、Ethereum `0.01 ETH`。
- [x] 四链 RPC 已实测主网并写入配置：Solana Genesis Hash 正确，BSC Chain ID `56`，Base `8453`，Ethereum `1`。
- [x] 6551 WSS 状态已改为 ingestion 共享心跳，当前真实状态为 `subscribed`。
- [x] Supervisor 已通过一次 `.env` 变更重启测试，两个角色均自动恢复且 Engine 保持 Locked。
- [x] Readiness 和 Settings 已按链展示 confirmed Buy、Sell、GMGN Order、RPC Receipt 和最近确认时间；SOL 当前为 `1/1/2/2`，其他链为 `0`。
- [x] 后端自动化测试 `111/111` 通过。
- [x] 前端 TypeScript 和 Vite 生产构建通过。

### 2.2 当前运行状态

```text
TRADING_MODE=live
LIVE_TRADING_ENABLED=true
Engine=Locked
GMGN_KEY_EXCLUSIVE=true
P8_VERIFIED_LIVE_EVENT_TYPES=reply
SHADOW_LIVE_ENABLED=true
TRADE_ALERTS_VERIFIED=false/empty
Live Policy=6551 + reply + SOL + CUPSEY
SOL/BSC/Base/Ethereum RPC=已配置并完成主网身份实测
全局每日/每周 USD 限额=5/15
```

当前 Readiness 阻断项为：

```text
FAST_PATH_SLO_NOT_VERIFIED
NO_LIVE_CHAIN_READY
```

这些状态不代表 GMGN 不能真实交易；它们代表当前自动下单入口保持关闭。`TRADE_ALERTS_VERIFIED=false` 继续作为可见检查项，但按用户决定已不再阻断本轮自动交易。P10 不会通过直接改数据库或一次性打开全部开关来消除其余提示，而是让每个状态都由真实证据驱动。

### 2.3 当前数据量

- 6551 Inbox 当前累计 `38` 条事件，最近一天 `28` 条。
- 当前数据库中有 `3` 条正式 Signal：`1` 条已执行、`2` 条只记录。
- 当前只有 6551 `reply` 具备真实事件验收记录。
- 当前没有活动 Position；历史 CUPSEY Buy/Sell Attempt 均为 `confirmed`。
- 现有样本不足以证明自动实盘的 24 小时延迟、限流、重复下单和恢复行为。

---

## 三、查缺补漏结果

### 3.1 自动交易核心修复（G2 TG 后置）

#### G1：人工测试与自动实盘没有隔离

历史上的 `scripts/execute-live-signal.js` 曾要求测试开关、金额上限和确认参数，但仍调用普通 `executionService.execute()`。该入口现已删除。该服务要求：

```text
TRADING_MODE=live
LIVE_TRADING_ENABLED=true
Engine=Armed
全部自动 Readiness 通过
```

一旦全局 Armed，同一时间到达的新 Live Signal 也可能进入自动执行队列。因此现有脚本并不是真正的“只执行一笔”。

P10 修复：新增独立 `manual_test` 执行范围。人工测试在 Engine 继续 Locked、自动队列关闭时运行，只能消费绑定 Signal、链、CA、金额、钱包、Risk Snapshot 和过期时间的一次性 Permit。

#### G2：TG 资金告警没有真实外部送达（后续增强）

当前 `notification-outbox.js` 的发送动作只有：

1. 写日志。
2. 向当前浏览器 WebSocket 广播。
3. 将 Outbox 标记为 `sent`。

它没有调用 Telegram 或其他外部通知服务。旧 `notifier.js` 虽有 Telegram 代码，但没有接入 P9 Outbox，文本还存在编码损坏；`TG_BOT_TOKEN/TG_CHAT_ID` 也不在 `.env.example` 和受控配置 Schema 中。

P10 后续修复：Outbox 增加真实 Delivery Adapter。第一版至少支持 Telegram，只有收到 Telegram HTTP 成功响应并记录 delivery receipt 后才允许标记 `sent`。本项不阻挡当前 RPC、6551、Supervisor、预算和自动交易链路更新；在无人值守 24/7 运行前完成。

#### G3：链级验收只是裸布尔值

`chain_live_readiness` 中的 `contract_tested/shadow_verified/live_enabled` 目前没有对应的正式 API，也没有证据表。系统无法回答是谁、何时、用哪个 CA、哪个钱包、哪个 GMGN/RPC 响应完成了验收。

P10 修复：新增链验收证据和受控状态迁移。布尔状态由证据计算或由带审计的审批动作更新，禁止直接 SQL 手工改为 `true`。

#### G4：链上最终性依赖已配置，仍需逐链成交验收

GMGN 是交易执行和托管钱包 Provider，但 Provider 的 `confirmed` 不能替代独立链上事实。Receipt Service 已实现 Solana/EVM RPC 校验，四链公共 RPC 已完成主网身份实测并写入受控配置。

后续验收：每条链的 Buy/Sell 都必须核对交易 Hash、成功状态、确认数、托管钱包 Token Delta 和原生资产 Delta；失败、找不到或不一致时进入 `reconciliation_required`，不能把 Position 标记为最终完成。公共 RPC 适合当前 MVP，正式高频运行前替换为带 SLA 的专用节点。

#### G5：首轮预算不适合真实测试

当前 SOL 配置为单笔 `1 SOL`、每日 `5 SOL`，BSC 单笔 `0.5 BNB`、每日 `1 BNB`。即使其他门槛会阻止当前下单，这些值也不能带入首轮真实运行。

P10 建议的 SOL 首测上限：

```text
单笔 Native 上限：0.005 SOL
每日 Native 上限：0.01 SOL
每周 Native 上限：0.03 SOL
最多 Open Position：1
单 CA 同时持仓：1
人工测试 Permit：一次、60 秒内有效
全局每日/每周 USD：根据执行前 GMGN 原生币 USD Snapshot 设置并由用户确认
```

USD 上限不能用写死的 SOL 价格换算；每次 Prepare 使用 GMGN 当前钱包资产的 USD 信息生成 Snapshot，并同时满足 Native 与 USD 两套上限。

### 3.2 P1：自动实盘前必须修复

#### G6：双进程状态误报

P9.1 已将服务拆成：

```text
ingestion：6551 WSS、事件落库和 Signal 生成
execution：API、GMGN、交易队列、对账和告警
```

但 `/api/x-monitor/6551/status` 在 execution 进程读取本进程内未启动的 Consumer 单例，因此会显示 `stopped`。这不代表采集进程真的停止，也不能用于自动实盘健康检查。

P10 修复：ingestion 每 `5 秒` 写入数据库 Service Heartbeat，包含角色、PID/instance ID、WSS 状态、订阅时间、最后消息、最后 Pong、队列深度、重连次数和错误。API 只读取共享心跳，并在超过阈值后显示 `stale/down`。

#### G7：Shadow 通过条件没有系统自动证明

当前 Shadow Worker 会记录单条评估，但前端显示的 `processed` 是内存计数，重启后归零；`shadow_verified` 也不会根据连续运行时长、有效样本数、429 和延迟自动生成。

P10 修复：新增 `shadow_run_sessions` 和聚合报告，持久化：

- 开始/结束时间、重启间隔和中断原因。
- 候选 Signal、通过、拒绝、失败和重复数量。
- Fast/Slow Path P50/P95/P99。
- GMGN 请求权重、排队、Quote 失败和 429。
- 每条链/CA/事件类型覆盖率。
- 理论预算与理论下单次数。

只有满足自动验收规则时，才能生成不可修改的 Shadow Report 并申请将该链标记为 `shadow_verified`。

#### G8：进程启动和重启不可依赖人工记忆

旧版本中 `XBOT_PROCESS_ROLE=` 为空时，`npm start` 会直接退出；Settings 保存环境变量后后端按设计退出，但没有进程守护会导致服务停机。

P10 修复：

- [x] 本地开发使用显式 `--role=all`，默认 `npm start` 启动双进程 Supervisor。
- [x] 正式子进程固定使用 `ingestion` 和 `execution` 角色。
- [x] `XBOT_PROCESS_ROLE` 空值不再影响 Supervisor，角色由启动命令覆盖。
- [x] 配置更新后 Supervisor 同时重启两个角色，Engine 重启后保持 Locked。
- [ ] 增加 OS 开机启动、日志轮转和 Supervisor 本身的崩溃拉起。

#### G9：Admin Token 无法安全轮换

`ADMIN_TOKEN` 被列为 Critical Key，普通配置接口拒绝修改，但当前没有专用轮换 API。前端虽然显示输入框，实际无法形成完整轮换流程。

P10 修复：新增专用轮换动作，要求旧 Token、二次确认和审计；写入后 Disarm、重启、清理浏览器旧 Token，并要求重新登录。远程部署前必须增加 HTTPS 和来源限制；当前仍只允许监听 `127.0.0.1`。

#### G10：6551 Watch 仍有一条待同步

当前 Watch Plan 中存在 `pending_update=1`。自动实盘前必须明确 desired 与 remote flags，并完成一次真实 WSS 断线重连、恢复订阅和事件补偿测试。Follow 事件仍未验收，第一阶段自动策略只能使用 `reply`。

### 3.3 P2：上线质量修复

- 修复 `notifier.js`、Trade CSV 和部分后端注释中的乱码。
- 删除或隔离仍会让用户误解的旧 Paper/Legacy 运维脚本；正式入口只展示当前资金状态机。
- Dashboard 的活动持仓统计必须包含 `open_protected/open_unprotected/partially_closed/closing/close_uncertain`，不能只统计 `open`。
- 前端“发送测试告警”必须展示真实外部通道、Delivery ID、送达时间和失败原因，不能只提示“已进入发送队列”。
- 为 Outbox Delivery、Service Heartbeat、Manual Permit、Shadow Session 和 Admin Token Rotation 增加自动化测试。

---

## 四、P10 目标架构

### 4.1 两条资金执行通道

```text
人工受控真单
用户选择一条新 Signal
-> 只读 Prepare
-> Manual Readiness
-> 生成一次性 Permit
-> 用户确认指定金额
-> 单次 Swap
-> GMGN 对账
-> RPC Receipt/Transfer 核验
-> Strategy/Position
-> Permit 失效

自动实盘
6551 WSS
-> 显式 actor -> target -> CA 关系
-> 已验收事件类型
-> Live Policy
-> 自动 Readiness + Armed
-> Durable Live Queue
-> 单次 Swap
-> GMGN + RPC 对账
-> Strategy/Position
```

两条通道复用同一 Execution、Repository、Scheduler、Reconciler、Budget 和 Close Service。差异只在“谁有权创建这一笔 Attempt”：人工通道使用一次性 Permit，自动通道使用 Live Policy + Armed。不能维护两套下单实现。

### 4.2 Manual Readiness

人工受控真单必须检查：

- GMGN API/签名有效且 Key 独占。
- 指定链钱包唯一、余额足够。
- 指定 CA、链、Signal 和显式关系一致。
- 事件类型已真实验收；第一阶段仅 `6551 reply`。
- Token/Security/Pool/Quote 实时探针通过。
- 指定链 RPC 可用且 Chain ID 正确。
- Scheduler 健康、可原子预留 7 weight、无近期 429。
- Reconciler 正常，无不确定订单和未保护仓位。
- 外部资金告警已真实送达。
- Native、USD、Gas、单 CA 和最大持仓上限有效。

人工通道不要求：

- Engine Armed。
- 自动 Live Queue 开启。
- 24 小时/50 Signal Shadow 已完成。
- 其他未计划测试链通过。

这不是绕过资金安全，而是把“单笔执行安全”和“持续自动运行安全”分开。

### 4.3 一次性 Permit

新增 `manual_trade_permits`，至少包含：

```text
id / nonce_hash
signal_id / whitelist_id / chain / contract_address
wallet_address
side / max_native / max_usd
risk_snapshot_hash / readiness_snapshot_hash
operator / created_at / expires_at / consumed_at
attempt_id / outcome
```

规则：

1. Permit 默认 `60 秒` 过期。
2. 只能通过数据库 CAS 消费一次。
3. Prepare 后钱包、Quote、Risk、预算、Signal 或 Policy 任一变化都要求重新生成。
4. Permit 消费后，即使请求超时也不能重新发起 Swap，只能进入 Reconciler。
5. 同一时间最多存在一个未消费 Permit。
6. 首测只允许 `buy <= 0.005 SOL`，Close 只能卖出该 Position 的 Lot。

### 4.4 外部告警送达（后续增强）

后续使用 Telegram Delivery Adapter：

```text
notification_outbox pending
-> Telegram HTTPS request
-> HTTP 2xx + Telegram message_id
-> notification_deliveries receipt
-> outbox sent
```

发送失败必须保留 `failed` 并退避重试。浏览器 WebSocket 仅用于看板实时展示，不算资金级外部告警。根据当前决定，本项保留状态展示但不阻断本轮 Readiness；进入长期无人值守运行前再启用可配置的告警故障自动反锁。

必须覆盖以下主题：

- 真实 Buy 已提交、已确认、失败和结果不确定。
- Strategy 创建失败、丢失、触发或数量不一致。
- Position 未保护、钱包余额不一致。
- 真实 Close 已提交、已确认、失败和结果不确定。
- 429、Scheduler 冷却、Reconciler 积压。
- 自动 Disarm、进程离线、WSS stale/down。

### 4.5 链级证据

每条链分别保存：

- GMGN User/Wallet 探针摘要。
- Token/Security/Pool/Quote Contract Probe 摘要。
- RPC Endpoint、Chain ID、最新区块和延迟摘要，不保存密钥 URL。
- Shadow Report ID。
- 真实 Buy/Close Attempt、Order、Hash 和 Receipt ID。
- 验收人、时间、代码版本和数据库 Migration 版本。

只有证据完整时才允许状态迁移：

```text
implemented
-> contract_tested
-> manual_e2e_verified
-> shadow_verified
-> live_enabled
```

Solana、BSC、Base、Ethereum 互不继承结论。

---

## 五、实施阶段

## P10-M0：冻结基线与可恢复启动

- [ ] 备份当前数据库，并记录 Git diff、Migration 版本、GMGN Scheduler 状态和历史 CUPSEY 资金事实。
- [x] 修复 `XBOT_PROCESS_ROLE` 空值导致通用启动失败的问题。
- [x] 增加一键本地启动和双进程 Supervisor。
- [x] 增加共享 Service Heartbeat，6551 状态由 ingestion 心跳提供。
- [x] 验证配置保存后两个进程可自动恢复，Engine 保持 Locked。
- [ ] 增加 execution/ingestion 独立详细 Health 和 OS 开机启动。
- [ ] 验证进程崩溃、系统重启和数据库短暂断开不会重复下单。

退出标准：不依赖 Codex 或人工终端维持服务；任一进程停止后前端能在明确时间内显示故障并自动恢复或告警。

## P10-M1：真实外部告警（后置工作流）

- [ ] 将 Telegram 配置加入受控 Env Schema 和 `.env.example`，Secret 不回传前端。
- [ ] Outbox 接入 Telegram Delivery Adapter，并保存外部 message ID。
- [ ] 修复通知模板乱码和 HTML 转义。
- [ ] 测试告警 API 等待并返回真实送达结果，而不是仅返回入队成功。
- [ ] `TRADE_ALERTS_VERIFIED` 改为由最近一次成功 Delivery Receipt 和配置版本自动计算。
- [ ] 为失败、重试、永久失败、重复 claim 和重启恢复增加测试。

退出标准：关闭浏览器后仍能收到资金告警；错误 Token、错误 Chat ID 和网络失败不会被标记为已送达。本工作流不阻挡 M2-M7。

## P10-M2：单笔人工真实交易通道

- [ ] 新增 Manual Readiness，与自动 Readiness 分离。
- [ ] 新增一次性 Manual Permit 表、Repository 和 API。
- [x] 删除 `execute-live-signal.js` 人工测试入口，不再保留第二套真实买入路径。
- [ ] 自动 Live Queue 在人工测试期间始终保持关闭。
- [ ] 前端 Signal 详情增加“准备人工真实交易”，展示 CA、关系、钱包、金额、费用、Quote、风险、Native/USD 上限和 Permit 倒计时。
- [ ] Buy/Close 必须分别二次确认，确认文本中包含链、CA 缩写和金额。
- [ ] 增加并发、重放、过期、请求超时和进程退出测试。

退出标准：Engine Locked 时只允许被 Permit 绑定的单笔交易；同时到达的其他真实 Signal 只能记录，无法创建 Attempt。

## P10-M3：SOL Contract、RPC、预算和证据

- [x] 配置四链公共 RPC，并验证 Solana 主网 Genesis Hash 及 BSC/Base/Ethereum Chain ID。
- [x] Readiness 按链汇总真实 Buy、Sell、GMGN confirmed Order、RPC confirmed Receipt 和最近确认时间，Settings 直接展示真实交易证据。
- [x] 解锁弹窗每 2 秒读取共享状态并显示逐项处理建议，避免 6551 重启恢复后继续展示旧阻断；真实交易模式和实盘权限开关已开启，Engine 保持 Locked。
- [ ] 为正式高频运行替换带 SLA 的专用 RPC，并验证交易、Receipt 和 Token Balance 查询。
- [x] 对 CUPSEY 执行 GMGN User/Token/Security/Pool/Quote 只读 Contract Probe，Token 精度、流动性和 `0.005 SOL` Quote 均成功。
- [x] 将 SOL 首测限额降低到 `0.005 SOL/笔`、`0.01 SOL/日`、`0.03 SOL/周`、最多一个仓位。
- [x] 配置并由用户确认全局每日/每周 USD 上限为 `5/15`。
- [x] 校验托管钱包 `0.492438771 SOL` 高于交易金额与费用预留之和。
- [x] 新增 append-only 链验收 Evidence 表和防修改触发器；Contract Probe 证据 `#1` 已自动驱动 SOL `contract_tested=true`。
- [x] 当前策略只包含 SOL；BSC/Base/Ethereum 继续保持关闭。

退出标准：SOL Manual Readiness 为通过状态，其他链的未完成项不阻塞 SOL 人工首测，也不能被顺带开放。

## P10-M4：SOL 人工 Buy/Close 真实闭环

建议首测使用一条新产生、真实 6551 `reply` Signal。CA 和关系在执行前由用户最终确认。

1. T0：读取 GMGN 钱包、余额、当前 Strategy 和数据库历史，无资金动作。
2. T1：Prepare 并展示 Quote、费用、风险、金额和全部硬限额，无资金动作。
3. T2：用户确认后执行一次 `<=0.005 SOL` Buy。
4. T3：记录 GMGN Order ID，按 `1s -> 2s -> 5s -> 15-30s` 查询至明确结果。
5. T4：使用 Solana RPC 核对 Hash、Token Delta、Native Delta 和确认数。
6. T5：核对 TP/SL Strategy 数量只覆盖本次 Lot。
7. T6：重复执行同一 Permit 和 Signal，确认不会产生第二笔 Swap。
8. T7：Engine 保持 Locked，确认对账仍继续。
9. T8：重启 execution 进程，确认订单和策略恢复且不重复提交。
10. T9：执行一次人工 Close，先处理 Strategy，再只卖该 Lot。
11. T10：GMGN 与 RPC 确认 Sell 后才减少 Lot 和关闭 Position。
12. T11：核对实际费用、Native/Token 余额和 PnL。
13. T12：验证 Buy、Strategy、Close 和异常告警均真实送达。
14. T13：生成完整审计报告并将 SOL 标记为 `manual_e2e_verified`。

退出标准：一笔新的 SOL Buy 和对应 Close 可从 Signal 一直追踪到 GMGN Order、链上 Receipt、Strategy、Lot、余额和 PnL，期间无重复资金动作。

## P10-M5：自动实盘 Shadow

- [x] 支持 `TRADING_MODE=live` 且 Engine Locked 时运行只读 Shadow；Engine 一旦解锁，Shadow 自动停止处理新样本。
- [ ] Live Policy 候选只使用 6551、已验收 `reply`、SOL 和显式关系。
- [x] Live Policy 已收缩为 `6551 + reply + SOL + CUPSEY + @xueqiu88 -> @cupseytoken`。
- [x] Shadow Worker 已开启并开始等待新的合格回复信号，资金提交保持关闭。
- [x] 新增持久化 Shadow Session、策略指纹、5 秒心跳、样本统计和中断原因；Session `#1` 已开始，Supervisor 重启后以 `resumed=true` 续接且不归零。
- [ ] 达到 24 小时和 50 条有效样本后生成 append-only Shadow Report，并自动驱动 `shadow_verified`。
- [ ] 至少连续观察 24 小时并累计至少 50 条有效 Signal，取二者较晚者。
- [ ] Signal、Quote、Risk、理论预算和理论 7 weight 预留全部可解释。
- [ ] 主动 429 必须为 0；重复意图、状态漂移、WSS 长时间离线或告警失败会中止并重新开始窗口。
- [ ] 自动生成 Shadow Report，不能人工勾选 `shadow_verified`。

退出标准：SOL Shadow Report 完整，Fast Path、限流、恢复、预算和重复控制均达到方案指标。

## P10-M6：单关系自动 Live 灰度

首次自动 Live 只允许：

```text
Provider：6551
事件类型：reply
链：SOL
KOL：1 个
项目 X：1 个
CA：1 个
单笔：<=0.005 SOL
每日：<=0.01 SOL 且最多 1 笔
Open Position：最多 1 个
```

- [ ] 保存最小 Live Policy 并自动 Disarm。
- [ ] 切换 `TRADING_MODE=live`。
- [ ] 开启 `LIVE_TRADING_ENABLED=true`。
- [ ] 获取最新 Readiness Snapshot 并由用户确认 Arm。
- [ ] 前三笔继续要求人工批准 Execution。
- [ ] 三笔全部正常后，才允许该唯一关系自动提交。
- [ ] 连续运行 3-5 天，每日核对 GMGN、RPC、钱包、数据库和前端。
- [ ] 任一告警失效、WSS stale、429、重复 Attempt、未保护仓位或对账不一致立即自动 Disarm。

退出标准：单关系、单 CA、单事件类型连续 3-5 天无重复交易、预算超支、未对账订单和钱包差异。

## P10-M7：逐链扩展

建议顺序：

```text
Solana -> BSC -> Base -> Ethereum
```

每条链独立完成 RPC、Contract、真实 Buy/Close、Receipt、Shadow 和小额灰度。用户已确认四链充值且 GMGN 实时余额探针已核对；充值证明钱包有可用资产，但不等于 XBOT 已在该链完成真实交易验收。

---

## 六、前端更新

Settings 不再只展示一串阻断原因，而是提供“真实交易上线进度”：

1. 服务：execution、ingestion、数据库、6551 WSS、Reconciler、Outbox。
2. 凭证：GMGN 已配置、签名有效、Key 独占，不显示具体 Secret。
3. 外部告警：保留当前验证状态；后续接入通道、Delivery ID 和送达时间。
4. 链验收：Contract、RPC、Manual E2E、Shadow、Live Enable 及对应证据。
5. 预算：Native 与 USD 双上限、Gas Reserve 和最大仓位。
6. 人工真单：选择 Signal、Prepare、一次性 Permit、确认、订单和链上结果。
7. 自动实盘：Live Policy、Shadow 进度、Readiness、Arm 和自动 Disarm 原因。

所有阻断项旁边必须显示可执行动作，例如“降低 SOL 单笔预算”“设置全局 USD 上限”“保存 Live Policy”“完成 Contract Probe”。不存在实际操作入口的状态不能再让用户自行改数据库。

---

## 七、需要用户提供或确认的内容

GMGN API Key、签名密钥和四链 RPC 已经完成，不需要重新提供。进入 P10 后续实施只需要确认：

1. 确认 SOL 首测上限：`0.005 SOL/笔`、`0.01 SOL/日`、`0.03 SOL/周`，以及全局 USD 日/周上限。
2. 最终首测的 SOL CA、actor -> target 关系和新产生的 6551 `reply` Signal。
3. 首次自动交易验收中的 Buy 和 Close 两次独立资金确认。
4. 后续需要外部告警时，再提供 Telegram Bot Token 和 Chat ID，或选择其他外部通道。

---

## 八、执行顺序与预估

| 顺序 | 阶段 | 预计时间 | 是否有资金动作 |
|---|---|---:|---|
| 1 | P10-M0 启动、守护、共享健康状态 | 0.5 天 | 否 |
| 2 | P10-M2 自动交易受控首单 Permit | 0.5-1 天 | 否 |
| 3 | P10-M3 SOL Contract、预算和证据 | 0.5 天 | 否 |
| 4 | P10-M4 SOL 自动交易首单 Buy/Close 验收 | 0.5-1 天 | 是，每一步人工确认 |
| 5 | P10-M5 自动实盘 Shadow | 至少 24 小时且 50 条有效 Signal | 否 |
| 6 | P10-M6 单关系自动灰度 | 3-5 天 | 是，小额硬上限 |
| 7 | P10-M7 BSC/Base/Ethereum | 每链独立 | 是，逐链确认 |
| 8 | P10-M1 外部告警闭环（后置） | 0.5 天 | 否 |

P10-M0 至 P10-M4 是“距离下一笔可控真实交易”的实际工作；P10-M5 至 P10-M6 是“距离持续自动真实交易”的运行验收。二者不能再混为同一个开关。

---

## 九、P10 完成定义

### 9.1 人工受控真实交易完成

- [ ] Engine Locked 和自动队列关闭时，一次性 Permit 可以且只能执行一笔指定交易。
- [ ] 当前浏览器告警与资金日志可追溯；外部 Delivery Receipt 按后置工作流补充。
- [ ] SOL GMGN Contract 和 RPC Receipt 验收通过。
- [ ] Native、USD、Gas、单 CA 和最大持仓上限全部生效。
- [ ] 新 SOL Buy/Close 完整通过，重复、超时和重启均不产生第二笔资金动作。
- [ ] GMGN、RPC、钱包、Order、Strategy、Lot 和 PnL 可完整追溯。

达到本节即可认定：**XBOT 已具备可重复执行的人工受控真实交易能力。**

### 9.2 自动实盘完成

- [ ] 6551 ingestion 共享健康状态准确，断线和 stale 可检测、可告警、可恢复。
- [ ] Shadow 至少 24 小时且 50 条有效 Signal，主动 429 为 0。
- [ ] 自动状态只能由验收证据生成，不能直接改布尔值绕过。
- [ ] 单关系、单 CA、reply、SOL 小额灰度连续 3-5 天通过。
- [ ] 自动 Disarm 不停止已有订单、Strategy 和 Position 的只读对账与必要退出。

达到本节即可认定：**XBOT 已具备已验收链上的小额自动真实交易能力。**

---

## 十、与 P9.1 的关系

P9.1 的 GMGN 执行内核、幂等、预算、Reconciler、Strategy、Lot/PnL 和逐链解锁设计继续有效。P10 主要解决 P9.1 实施后暴露的五个运行问题：

1. 明确人工真单不等于自动实盘。
2. 为人工真单建立真正的一次性资金权限。
3. 将告警、链验收和 Shadow 从人工勾选改为证据驱动。
4. 修复双进程状态和正式部署恢复能力。
5. 给出从当前状态到下一笔真实 Buy/Close 的最短可执行顺序。

如 P9.1 的阶段描述与 P10 的人工/自动通道边界发生冲突，以 P10 为后续实施基线；P9.1 的资金安全约束不得降低。
