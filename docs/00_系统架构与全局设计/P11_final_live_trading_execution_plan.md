# P11 XBOT 最终真实交易执行方案

> 文档编号：P11  
> 创建日期：2026-07-22  
> 当前状态：P11-M1 至 M6、T0 至 T4 已完成；SOL 真实自动买入、保护策略和真实卖出闭环已通过，下一步进入 BSC、Base 逐链验收  
> 上位基线：[P10_real_trading_launch_gap_closure_plan.md](./P10_real_trading_launch_gap_closure_plan.md)  
> 核心目标：让符合条件的新 6551 信号自动提交 GMGN 真实订单，并以真实 Order、Tx Hash、RPC Receipt、Position 和 Lot 作为完成证据。

---

## 一、P11 的最终决定

XBOT 从 P11 开始只保留三种清晰运行状态：

| 状态 | 真实含义 |
|---|---|
| 已停止 | 不接受新的真实买入；已有订单、持仓、策略和退出仍持续对账 |
| 真实交易运行中 | 新的合格 6551 Signal 自动进入 GMGN 真实下单链路 |
| 故障保护 | 因关键故障停止新买入，但继续查询未决订单并保护、退出已有持仓 |

`TRADING_MODE=live`、`LIVE_TRADING_ENABLED=true` 与前端“启动真实交易”必须表达同一件事：**合格的新 Signal 会产生真实资金动作。**

P11 不再将 Paper、Shadow、24 小时观察、50 条样本或前三笔人工批准作为实盘前置条件。这些能力可以保留为开发工具，但不得进入真实交易 Readiness、不得替代真单、不得把前端“真实交易运行中”悄悄降级成只记录信号。

P11 保留以下必要资金控制：

- 单笔、每日、每周和累计预算。
- 最大同时持仓数和单 CA 重复买入限制。
- Signal 时效、关系绑定和 Live Policy。
- GMGN 鉴权、钱包余额、Quote、最小到账量和 Gas Reserve。
- 蜜罐、税率、Mint/Freeze Authority、流动性和已知高风险值。
- 幂等、未知提交持续对账、GMGN Order 与 RPC Receipt 核验。
- 一键停止新买入；停止后仍允许对账、策略管理和退出。

---

## 二、当前真实状态

截至 2026-07-22，系统已经具备以下真实基础：

- 6551 MAX WSS 已订阅，`reply` 事件已通过真实账号测试。
- 6551 Watch REST、WSS Subscribe/Pong 和 Follower Events REST 已完成真实接口测试；主动关注行为监听在 KOL `xueqiu88` 上，`xueqiu88.newFlwBol=true`，项目账号不启用该标志。
- 6551 真实操作、WSS Event 和平台“关注”选项已共同确认语义：`event.twAccount -> content[].twAccount`，即“被监控 Actor -> 新关注的账号”；Inbox 集成测试按该方向生成 Signal，取消后重新关注不会二次生成 Signal。
- 当前首测关系已切换为 `@xueqiu88 -> @asteroid_bags -> ASTEROID`。
- `7773` 已生成真实 Provider Event、Activity 和 Signal `#527`。
- 6551 Inbox 到 Signal `#527` 的本地处理耗时约 `3ms`。
- GMGN `/v1` 鉴权、钱包、Token、Security、Pool 和 Quote 请求成功。
- SOL 钱包余额满足测试要求，ASTEROID `0.005 SOL` Quote 成功。
- GMGN Buy、Order Query、Strategy、Close、Reconciler、RPC Receipt、Position、Lot 和 PnL 代码已经存在。
- execution、ingestion 双进程及 Supervisor 已运行。
- ASTEROID 白名单 `#96` 已修正为单笔 `0.005 SOL`、累计 `0.03 SOL`；数据库、后端 API、前端输入和 SOL 链级上限读取一致。
- 真实 Provider Event `#222`（6551 ID `71548773`）由 `xueqiu88` 的主动关注操作产生，payload 为 `twAccount=xueqiu88`、`content= CupseyToken`；旧方向解析将其错误归档为 `ignored`，未生成 Signal、Attempt 或资金动作，该旧事件不会重放。
- 2026-07-22 20:36 通过 6551 平台“关注”选项与真实 Event 再次校正方向并立即停止新买入；20:38 已部署正确解析、重建 Watch 并以 ASTEROID Live Policy 再次启动真实交易。

当前没有发生 `7773` 对应的真实买入；该旧 Signal 只保留为审计记录，不会重放：

```text
TRADING_MODE=live
LIVE_TRADING_ENABLED=true
真实交易状态=真实交易运行中
armed=true
desiredRunning=true
armedAt=2026-07-22 20:38:40 +08:00
Signal #527=signal_only / LIVE_TRADING_STOPPED
Signal #527 Trade Attempt=0
@xueqiu88 + ASTEROID x_follow_signal_once=0
实时信号通道=PostgreSQL LISTEN/NOTIFY 已连接
```

P11 最终审查发现并已修复以下问题：

1. `0.005 SOL` 本金加 `0.0002 SOL` 费用预留原本会错误触发单笔和白名单上限；现已改为单笔/累计核本金，链日/周、全局 USD 和钱包余额核本金加费用。
2. SOL 的 `RUG_RATIO_UNKNOWN` 和不可推导的 `PRICE_IMPACT_UNKNOWN` 已改为警告；EVM 缺失仍 fail closed，已知高风险值仍硬拒绝。
3. Readiness 已移除 SLO、Shadow、`shadow_verified/live_enabled` 硬门禁，并增加 RPC 链身份、最新区块和显式账号关系探测。
4. execution 进程通过 PostgreSQL `LISTEN/NOTIFY` 接收 ingestion 已提交的新 Signal，500ms 数据库扫描只作为断线后备。
5. 实盘期望状态、操作者、时间、Readiness 快照和配置指纹已持久化；重启时实时复核，不通过进入故障保护。
6. 设置页已修复桌面横向溢出、移动端启动弹窗被长页面错误定位，以及 Supervisor/API 启动后主控制卡状态不同步的问题。
7. 6551 `NEW_FOLLOWER` 以真实操作和平台配置为准：`twAccount` 是主动关注的 Actor，`content` 是被关注账号；解析器已按此方向修正。
8. 6551 Watch 删除接口对用户名大小写敏感；客户端和对账器现保留远端原始用户名，例如删除时使用 `CupseyToken` 而不是 `cupseytoken`，并增加回归测试。
9. Follow Watch 设置在 KOL Actor 上，用于发现该 KOL 主动关注了哪些项目；项目账号只保留 6551 强制的 Tweet 标志。

Signal `#527` 继续作为审计记录保留。它已经超过自动 Signal 时效，P11 不允许系统静默重放旧信号；最终自动真单使用 Engine 启动后产生的一条新 6551 `follow`。如果 6551 未推送该真实关注事件，则本轮必须明确判定关注链路未通过，不能用构造事件替代；已验收的 `reply` 只作为独立真实交易备用触发方式。

当前 `@xueqiu88 + ASTEROID` 没有 `x_follow_signal_once` 记录。由于关注 Signal 永久只触发一次，不能在真实交易停止时提前消耗这条真实关注；现在已完成 P11 代码更新、Readiness 和启动真实交易，可以进行取消关注和重新关注。

### 2.1 最终真实闭环证据（替代 ASTEROID 首测计划）

ASTEROID 仅保留为前期测试计划和方向校验证据。P11 最终资金闭环使用真实关系 `@xueqiu88 -> @neet_sol -> NEET`，未使用 Paper、Shadow、构造 Provider Event 或旧 Signal 补买。

```text
6551 Provider Event ID：71557930
Signal：#699
Buy Attempt：#90 / confirmed
Position：#42
Buy Amount：0.005 SOL
Buy Output：19.16844 NEET
GMGN Buy Order：od10sol00000019f89e188b8b8caacd57b4d232b
Buy Tx：35xvUqpyqKBCWR8gjjYiUwKTSjKNx69xGQppHbGBR4xXYjQLiHTcgLarrhmcdwPbXSJ73RcHeAJ9ne1p54CE6sHh
TP/SL Strategy：401df363-3c93-4bf9-adb8-130921aa51d4
TP / SL：+100% / -20%

首次 Close Attempt：#106
结果：GMGN 已取消保护策略，但 Swap 未提交；经策略历史、无 Order/Tx 和完整余额三重证据恢复为 rejected
最终 Sell Attempt：#107 / confirmed
GMGN Sell Order：od10sol00000019f8a67584098333dc2f8167d7b
Sell Tx：5ytZq3HXg1b2LyH5W1g6R6hVqQ56hGUqfy3CV6h529oXQBZshvUCNq2GLFa2sXfiL48WRATGZfHHzftEMwtYxxe6
Solana RPC：confirmed / block 434533421 / 6 confirmations
Sold：19.16844 NEET
Wallet Native Delta：0.006790766 SOL
Token Account Rent Refund：0.00203928 SOL
Net Settlement Proceeds：0.004751486 SOL
Realized PnL：-0.000248514 SOL / -4.97%
Lot Remaining：0
Position：closed
```

本次闭环同时修复了平仓默认滑点、GMGN 余额 decimals、重启恢复竞态、退出门禁、可变 Quote 快照、策略取消响应判定、取消后自动恢复和 Solana Token Account 租金返还误计 PnL。相关专项测试 `24/24` 通过，前端生产构建通过；闭环后 Engine 为 `running`、6551 WSS 为 `subscribed`。

---

## 三、P11 实盘原则

### 3.1 真实证据原则

以下内容不能证明真实交易完成：

- 数据库布尔值。
- 前端显示“已开启”。
- Quote 成功。
- 单元测试、集成测试或构造的 Provider Event。
- Signal 状态为 `recorded/pending`。

真实买入完成必须同时具备：

1. 真实 6551 Provider Event。
2. 真实 Activity 和 Signal。
3. 唯一 Trade Attempt。
4. GMGN Provider Order ID。
5. 链上 Tx Hash。
6. RPC 成功 Receipt 和确认数。
7. 钱包 Native/Token Delta。
8. 已打开 Position 和对应 Lot。
9. 覆盖该 Lot 的真实 TP/SL Strategy，或明确记录策略创建失败并立即进入保护处理。

真实卖出完成必须同时具备 GMGN Sell Order、Sell Tx Hash、RPC Receipt、钱包 Delta、Lot 减少、Position 关闭和 PnL。

### 3.2 未知数据处理原则

Provider 明确返回高风险值时必须硬拒绝；Provider 不提供某个可选字段时，不得伪造安全值，也不得仅因字段缺失永久阻断全部实盘。

SOL 首轮规则：

| 检查 | 缺失时处理 | 明确异常时处理 |
|---|---|---|
| GMGN Quote / 最小到账量 | 硬拒绝 | 硬拒绝 |
| 钱包余额 / Gas Reserve | 硬拒绝 | 硬拒绝 |
| Mint Authority | 硬拒绝 | 硬拒绝 |
| Freeze Authority | 硬拒绝 | 硬拒绝 |
| 流动性 | 硬拒绝 | 低于阈值硬拒绝 |
| Rug Ratio | 记录警告 | 高于阈值硬拒绝 |
| Provider Price Impact | 优先计算回退值；仍不可得则警告 | 高于阈值硬拒绝 |
| Honeypot 字段 | SOL 不适用时记录警告 | 明确为 true 时硬拒绝 |

Price Impact 回退值优先使用 Quote 的输入价值、预计输出数量和当前 Token 价格计算；如果价格源也不可用，则依靠 GMGN 最小到账量、白名单滑点上限和小额预算约束本笔交易。

### 3.3 资金提交原则

- Quote、Token、Pool、Security、Wallet 等只读请求可以按限流策略重试。
- Swap/Close 等资金写请求禁止自动盲重试。
- 请求超时或响应不确定时进入 `submission_uncertain`，按客户端幂等键、GMGN Order 和链上记录持续对账。
- 未确认上一笔结果前，同一 Signal、CA、钱包不得提交第二笔。
- 任一故障不得通过直接修改数据库状态伪装成交。

---

## 四、实盘配置基线

P11 当前首轮只开放 SOL ASTEROID 关系：

```text
Provider：6551
事件：follow（最终真单测试）
链：SOL
KOL：@xueqiu88
项目账号：@asteroid_bags
CA：4UeLCRqARmfb6e6KQijtiktqqXUxbfk6jZng7DhuBAGS
白名单 ID：96
单笔：0.005 SOL
每日：0.01 SOL
每周：0.03 SOL
白名单累计：0.03 SOL
最大 Open Position：1
同一 CA 同时持仓：1
全局每日/每周：5/15 USD
Signal 最大年龄：30 秒
```

白名单 `#96` 已通过后端受控配置服务原子修正。后端会拒绝超过链级 `maxPerTrade` 的白名单金额；前端从同一 `chain_configs` API 读取上限，并支持 `0.000001` 的输入精度。进入真单前仍需通过 GMGN Quote 再次确认输入金额为 `0.005000000 SOL`。

---

## 五、代码更新任务

### P11-M1：统一真实交易状态

- [x] 前端仅提供“启动真实交易”和“停止新买入”两个主要操作。
- [x] 启动成功后显示“真实交易运行中”，并明确显示链、关系、CA、单笔金额和预算。
- [x] 停止或 Readiness 失败时显示真实原因，不再显示为运行中。
- [x] 删除实盘状态下自动转入 Shadow 的行为。
- [x] 新 Signal 在真实交易未启动时只记录；启动时统一归档为 `LIVE_TRADING_STOPPED`，不得显示成已执行。
- [x] 任意 Critical 配置变化自动停止新买入并要求重新通过实时检查。

### P11-M2：重建实盘 Readiness

`assertReadyToArm()` 只检查当前真单所必需的实时事实：

- [x] execution、ingestion、数据库和 6551 WSS 健康。
- [x] GMGN API Key、签名、钱包和目标链可用。
- [x] 当前链 RPC 身份正确且可查询最新区块。
- [x] 当前 CA 的 Token、Security、Pool 和 Quote 成功。
- [x] 钱包余额满足本笔金额和 Gas Reserve。
- [x] Live Policy 精确包含 Provider、事件、链、白名单和关系。
- [x] 单笔、每日、每周、累计和全局 USD 预算通过。
- [x] 没有未决 `submission_uncertain`、重复 Attempt 或未保护 Live Position。
- [x] `LIVE_TRADING_ENABLED=true` 且 `TRADING_MODE=live`。

以下项目改为可观测指标，不再阻断 Arm：

- Fast Path 历史 P95/P99 样本数量。
- Shadow Session、Shadow Report 和 `shadow_verified`。
- Telegram 外部告警是否接入。
- 与本次 SOL 交易无关的 BSC/Base/Ethereum 验收状态。

### P11-M3：统一风险引擎

- [x] `execution-service.js` 成为 Prepare 和 Execute 的唯一实盘风险判定入口。
- [x] `risk-manager.js` 仅保留 Paper 路径；Live 调用明确转交 `execution-service.js`。
- [x] 将 SOL 的 `RUG_RATIO_UNKNOWN` 改为警告，将已知 `HIGH_RUG_RATIO` 保持硬拒绝。
- [x] 为 Price Impact 增加可解释回退计算；确实不可得时记录警告。
- [x] 保持 CA、Quote、余额、预算、Mint/Freeze、流动性、已知蜜罐和已知高风险值的硬拒绝。
- [x] Prepare Token 绑定 Signal、CA、Chain、Wallet、Amount、Quote 摘要、Risk Snapshot、Policy Hash 和短有效期。
- [x] Execute 时重新获取 Quote 并核对不可变字段、风险和预算，不接受前端篡改金额。

### P11-M4：实盘状态持久化和重启恢复

- [x] 数据库保存“期望真实交易运行状态”、操作者、时间和配置指纹。
- [x] Supervisor 重启后先执行实时 Readiness；配置指纹一致且全部通过时恢复真实交易。
- [x] Readiness 不通过时进入故障保护，不恢复新买入，并在前端显示具体原因。
- [x] 重启恢复沿用 Signal claim、Attempt 和 Provider Order 幂等约束，不重复提交 Swap。
- [x] 停止新买入不会停止 Order Query、Reconciler、Strategy、Receipt 和 Close。

### P11-M5：实时队列和幂等

- [x] Engine 启动前产生的旧 Signal 不自动补买。
- [x] Engine 启动后的合格 Signal 在事务中从 `recorded -> pending` 唯一 claim。
- [x] Signal、Canonical Key、Attempt Idempotency Key 和 Provider Order 建立一一对应审计链。
- [x] WSS 事件提交后通过 PostgreSQL `NOTIFY/LISTEN` 直接 enqueue，500ms 数据库扫描仅作为后备。
- [x] 同一 Signal 被通知、CA 事件和扫描器重复观察时只能创建一个 Attempt。
- [x] Signal 超龄、关系失效、预算变化或 Engine 停止时明确拒绝并提示。

### P11-M6：前端实盘控制台

Settings 使用中文显示以下内容：

- [x] 当前状态：已停止 / 真实交易运行中 / 故障保护。
- [x] 当前唯一实盘关系和 CA。
- [x] 单笔、每日、每周、累计、USD 和 Gas Reserve。
- [x] GMGN、6551、RPC、数据库、execution、ingestion 当前健康状态。
- [x] 启动前检查结果，区分“必须修复”和“警告”。
- [x] 最近一笔真实 Provider Event、Signal、Attempt、GMGN Order、Tx Hash 和 Receipt。
- [x] 一键停止新买入；已有持仓继续展示保护和退出状态。

启动确认框只进行一次最终事实确认，不再要求用户理解 `TRADING_MODE`、`LIVE_TRADING_ENABLED`、Engine、Shadow 等内部变量。

---

## 六、最终 SOL 真实交易步骤

### P11-T0：无资金预检

1. 核对白名单 `#96` 保持 `0.005 SOL/笔` 和 `0.03 SOL` 累计上限；金额修正已完成。
2. 核对无活动 Live Position、无 pending/unknown Attempt、无未决 Strategy。
3. 核对 GMGN SOL 钱包、余额和 Gas Reserve。
4. 获取 ASTEROID 最新 Token、Security、Pool 和 `0.005 SOL` Quote。
5. 核对 Solana RPC 最新区块、钱包原生余额和 Token 余额。
6. 展示最终 Live Policy 和全部硬限制。

T0 只能发起只读请求，不产生资金动作。

### P11-T1：启动真实交易

1. 用户在前端点击“启动真实交易”。
2. 后端重新运行实时 Readiness 并保存配置指纹。
3. Readiness 通过后进入“真实交易运行中”。
4. execution 队列开始接受启动时间之后产生的新 Signal。
5. 前端明确显示“下一条合格信号将自动真实买入 0.005 SOL”。

2026-07-22 实际执行结果：

- [x] T0 实时预检通过：`readyToArm=true`，阻断项为 0；SOL 钱包余额、ASTEROID Quote、Solana RPC、预算和显式关系均通过。
- [x] T1 启动成功：`armed=true`、`status=running`、`desiredRunning=true`。
- [x] 旧 Signal `#527` 已归档为 `signal_only / LIVE_TRADING_STOPPED`，未产生补买。
- [x] 6551 WSS 已订阅、心跳新鲜，实时信号通道已连接，队列为空。
- [x] `@xueqiu88 + ASTEROID` 的首次关注机会仍为 0，留给 T2 真实事件。
- [x] 20:38 按 6551 主动关注语义修正后再次启动成功；Watch 全部 `in_sync`，`readyToArm=true`、阻断项为 0，未决 Attempt 为 0。

### P11-T2：触发自动真单

1. 确认 `xueqiu88` Watch 的 `newFlwBol=true`、`asteroid_bags` Watch 的 `newFlwBol=false`，并确认 `@xueqiu88 + ASTEROID` 尚无 `x_follow_signal_once`。
2. 用户使用 `@xueqiu88` 先取消关注 `@asteroid_bags`，等待 X 状态生效后重新关注。
3. 6551 WSS 接收 `NEW_FOLLOWER` Provider Event，事件方向必须是 `@xueqiu88 -> @asteroid_bags`。
4. 系统生成 `follow` Activity 和唯一 ASTEROID Signal，并写入永久一次性记录。
5. Live Queue 自动 claim Signal，无需再次人工点击“执行”。
6. Prepare 使用 `0.005 SOL` 生成最终 Quote 和 Risk Snapshot。
7. Execute 向 GMGN 提交真实 Swap。
8. 数据库记录唯一 Attempt 和 GMGN Order ID。

性能目标：

```text
6551 transport -> Inbox commit：P95 <= 300ms
Inbox -> Signal commit：P95 <= 100ms
Signal commit -> GMGN submit start：P95 <= 1s
主动 429：0
```

GMGN 和链上最终确认时间属于外部成交时间，单独记录，不伪装成内部处理延迟。

### P11-T3：真实成交核验

1. Order Query 按 `1s -> 2s -> 5s -> 15-30s` 自适应查询。
2. GMGN 返回明确 Tx Hash 后使用 Solana RPC 查询 Receipt。
3. 核对交易成功、确认数、钱包地址、Token Delta 和 Native Delta。
4. 只有 GMGN 与 RPC 事实一致后才将 Attempt 标记为 confirmed。
5. 创建真实 Position 和 Lot，金额必须来自链上实际到账量。
6. 创建只覆盖本次 Lot 的 TP/SL Strategy。
7. 核对预算只扣减一次，同一 Signal 再次进入队列不会产生第二笔 Swap。

### P11-T4：真实退出闭环

1. 核对 TP/SL Strategy 在 GMGN 真实存在且数量正确。
2. 正常运行时由真实策略触发退出；需要立即回收测试资金时，通过前端真实 Close 执行。
3. Close 不得超过该 Lot 的剩余数量。
4. 核对 Sell Order、Sell Tx Hash、RPC Receipt 和钱包 Delta。
5. 确认 Strategy 已取消或完成、Lot 已归零、Position 已关闭、PnL 已记录。

---

## 七、异常处理

| 异常 | 系统动作 |
|---|---|
| 6551 WSS 断开或心跳过期 | 停止新买入，重连；不影响已有订单对账和退出 |
| GMGN 429 | 停止新买入并按 Retry-After 降频；资金写请求不自动重试 |
| Swap 响应超时 | 标记 `submission_uncertain`，按幂等键和钱包事实对账 |
| GMGN confirmed 但 RPC 未确认 | 保持 chain_verifying，不创建最终成交事实 |
| RPC confirmed 但 GMGN 状态未知 | 以链上事实进入人工复核和持续对账，不重复下单 |
| TP/SL Strategy 创建失败 | 停止新买入，立即告警并进入受控退出流程 |
| 预算或持仓上限达到 | 拒绝新 Signal，已有仓位继续管理 |
| Supervisor 重启 | 核对配置指纹和 Readiness 后恢复；不重复提交旧 Signal |
| 用户点击停止 | 立即停止新买入，继续查询、保护和退出已有仓位 |

---

## 八、逐链真实开放

SOL 完成一笔自动真实 Buy 和对应真实退出后，按以下顺序开放：

```text
Solana -> BSC -> Base -> Ethereum
```

每条新链都必须提供至少一个真实 CA、项目 X Handle 和 actor -> target 关系，并执行一次小额真实 Buy/Close。每条链单独设置 Native 金额、Gas Reserve、滑点、税率和流动性阈值；一条链失败只关闭该链新买入，不阻断其他已验收链。

逐链验收不要求 Shadow，也不能通过修改 `live_enabled=true` 代替真实成交证据。

---

## 九、测试与验收

自动化测试用于防止代码回归，但不作为真单完成证据：

- [x] Risk：未知字段警告、已知高风险硬拒绝、金额不可篡改。
- [x] Queue：旧 Signal 不补买、新 Signal 唯一 claim、重复事件不重复下单。
- [x] Execution：同一 Idempotency Key 不产生第二个资金请求。
- [x] Restart：期望状态、配置漂移、故障保护和幂等恢复自动化测试通过；真实未决订单恢复将在 T2/T3 验收。
- [x] Stop：停止新买入不停止 Reconciler、Receipt、Strategy 和 Close。
- [x] Frontend：状态、金额、关系、阻断原因、Order 和 Tx Hash 使用中文并读取同一后端事实。
- [x] 后端完整测试 `119/119` 通过。
- [x] 6551 方向、Watch 角色、Inbox 一次性关注和远端用户名大小写专项回归测试 `16/16` 通过。
- [x] 前端生产构建通过。
- [x] 设置页已通过 `1440x900` 与 `390x844` 响应式验收；启动按钮、GMGN 指标和启动确认框无裁切或横向溢出。

真实验收必须使用新产生的 6551 事件，最终审计报告至少包含：

```text
Provider Event ID
Activity ID
Signal ID
Attempt ID
GMGN Order ID
Buy Tx Hash
Buy RPC Receipt
Position ID
Lot ID
Strategy Group ID
Sell Order ID
Sell Tx Hash
Sell RPC Receipt
实际 Native/Token Delta
实际费用和 PnL
全链路时间线
```

---

## 十、执行顺序

| 顺序 | 阶段 | 是否有资金动作 | 退出标准 |
|---|---|---|---|
| 1 | P11-M1 至 M6 代码和前端更新 | 否 | 实盘语义、风险、Readiness、恢复和 UI 一致 |
| 2 | P11-T0 实时预检 | 否 | `0.005 SOL` Quote、余额、RPC、预算全部通过 |
| 3 | P11-T1 启动真实交易 | 否 | 前端显示真实运行，队列接收新 Signal |
| 4 | P11-T2 新关注自动买入 | 是 | GMGN 收到唯一真实 Swap |
| 5 | P11-T3 成交、持仓和策略核验 | 是 | Tx Hash、Receipt、Position、Lot、Strategy 完整 |
| 6 | P11-T4 真实退出 | 是 | Sell Receipt、Lot、Position、PnL 完整闭环 |
| 7 | 保持 SOL 自动实盘运行 | 是 | 后续合格新 Signal 自动真单，不再人工逐笔批准 |
| 8 | BSC、Base、Ethereum 逐链开放 | 是 | 每链真实 Buy/Close 通过 |

P11 不设置模拟观察等待期。代码更新和只读预检通过后，直接进入一笔 `0.005 SOL` 的自动真实交易。

---

## 十一、P11 完成定义

以下条件全部满足，P11 才能标记完成：

- [x] 前端“真实交易运行中”与后端真实资金能力一致。
- [x] ASTEROID 单笔金额已从 `0.1 SOL` 修正为 `0.005 SOL`，累计预算为 `0.03 SOL`。
- [x] 一条新的真实 6551 `follow` 自动产生唯一 GMGN Swap；最终验收方向为 `@xueqiu88 -> @neet_sol`。
- [x] 获得并核验真实 GMGN Order ID、Buy Tx Hash 和 RPC Receipt。
- [x] Position、Lot 和 TP/SL Strategy 与真实到账数量一致。
- [x] 重复事件、重复 Signal、超时和重启均未产生第二笔资金动作。
- [x] 真实 Close 获得 Sell Tx Hash 和 RPC Receipt，Lot、Position 和 PnL 正确。
- [x] 交易完成后系统继续保持自动真实交易能力，Engine 已恢复为 `running`。
- [x] 没有用 Paper、Shadow、构造数据或数据库布尔值替代任何真实成交证据。

达到以上标准后，结论只能写为：

> **XBOT 已完成 SOL 自动真实交易闭环，并可对符合 Live Policy 的新 6551 信号自动执行真实交易。**

在此之前，不得再用“Quote 成功”“Signal 已生成”“模拟评估通过”或“代码已经具备能力”代替真实交易完成结论。
