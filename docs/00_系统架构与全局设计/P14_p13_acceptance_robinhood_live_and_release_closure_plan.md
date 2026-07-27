# P14 P13 验收、Robinhood 实盘与生产收尾统一方案

> 2026-07-25 状态校正：P14 代码、Migration 016、独立数据库门禁、新链诊断、限时单白名单验收、完整 `manual_e2e` 和生产批准接口均已实现；Robinhood 后续已完成真实 Buy/Close、Receipt 和生产批准，当前作为第五条正常交易链。限时验收未开启，相关操作已退出前端并登记为后台维护工具。下文的首次接入基线保留为历史设计证据，不再代表当前 Robinhood 状态。

> 编制日期：2026-07-24
> 状态：Active Plan（剩余生产观察与发布收尾）；P12/P13/P15 保留为设计和实施证据
> 资金原则：只读检查不触发交易；任何真实 Buy/Close 必须在执行前由用户确认金额、CA 和触发关系
> 最终目标：P13 行为验收完成，Robinhood 通过真实自动 Buy/Close 闭环，五链共用同一资金状态机并具备可发布证据

## 1. 为什么需要 P14

P12 已实现 Trade Intent、多 Attempt、Receipt、Reconciliation、Wallet Write Lane、明确失败证据和 Retry 内核；P13 已完成白名单主导配置、Actor-only Watch、自动 Watch 同步、旧路径隔离和 Migration 015。

但目前“代码实现”“生产行为验收”和“真实资金闭环”仍分散在 P12、P13 的不同章节，容易产生以下误判：

1. P13 单元测试通过不等于所有 P13 生产行为已经验收。
2. Robinhood 页面和 Chain Manifest 存在不等于可以实盘。
3. 四链历史真实成交不等于 P12/P13 更新后的版本已经完成回归。
4. Retry 内核存在不等于当前运行配置真的可以开启 Retry。
5. 旧代码被隔离不等于已经满足删除条件。

P14 将上述未完成项收敛为一条执行顺序，后续不再并行执行 P12、P13 的旧清单。

## 2. 2026-07-24 当前事实基线

### 2.1 已完成并已复核

| 范围 | 当前证据 |
|---|---|
| 数据库 | 生产库已应用 Migration 013、014、015 |
| 后端自动化 | `npm.cmd test`：173/173 通过 |
| 前端 | TypeScript + Vite production build 通过 |
| P13 配置 | 白名单和关系是 CA、金额、次数、TP/SL、滑点、事件类型的业务来源 |
| 6551 | ingestion/execution 心跳 fresh，WSS 为 `subscribed`；Watch Outbox 无 pending/failed |
| 资金状态 | 无未决 Intent、无 Wallet Quarantine；五条链的 Circuit 均为 open、连续失败数为 0 |
| 历史实盘 | SOL 4 次、BSC 2 次、Base 1 次、ETH 1 次 Buy/Close 均有 confirmed 历史记录，仓位已关闭 |
| Robinhood 代码能力 | `chainId=4663`、ETH、18 decimals、EVM Receipt、GMGN Wallet/Market/Quote/Strategy、Swap `condition_orders`、Order、Position/Lot 和 Close 通用链路已接入 |

### 2.2 尚未完成

| 范围 | 当前缺口 |
|---|---|
| P13 集成验收 | 独立数据库集成测试 `21/21` 通过；Migration 000-016 新库安装及 013-016 历史升级演练通过，临时测试库已删除 |
| P13 生产行为 | 热加载不停止 Engine、Actor-only Watch、关系事件和多对多映射需要按正式验收剧本留证 |
| 四链回归 | P12/P13 更新后尚未分别完成最小真实 Buy/Close 回归 |
| Retry | 全部链默认关闭；生产逐链开放未验收，并存在遗留 `chainConfig.enabled` 检查导致 Retry 永久拒绝的 P0 问题 |
| Robinhood RPC | 官方 Public RPC 已写入本地并验证 `chainId=4663`、区块新鲜和连续响应；官方明确限流且不建议生产，正式上线前仍需稳定 Provider RPC |
| Robinhood 资金 | GMGN 已返回 Robinhood 钱包；GMGN 余额数组为空，官方 RPC `eth_getBalance` 同步确认余额为 `0 ETH` |
| Robinhood 数据 | 没有 Active 白名单、订单、仓位、Receipt 或 `manual_e2e` 证据 |
| Robinhood 门禁 | 代码能力已接入，但 `contract_tested=false`、生产批准 `live_enabled=false`，没有限时验收作用域 |
| 首次接入路径 | Readiness 只探测 Execution Chains，Robinhood 被代码门禁排除后无法通过正常路径生成首次 Contract Probe，存在循环门禁 |
| 生产观测 | 外部交易告警、50 条 Fast Path SLO 样本、Retry/Terminal Audit 生产指标尚未完成 |
| 发布治理 | 当前 P12/P13 大量改动尚未形成清晰发布基线、Secrets 扫描和版本标签 |

Engine 当前为 stopped。P14 的无资金阶段不得自动启动 Engine。当前有 14 条 Active 白名单，其中 7 条仍具备买入资格；Robinhood 首次实盘前必须启用“唯一白名单验收作用域”，不能只暂停其他 Robinhood 白名单。

## 3. P14 的边界

### 3.1 本阶段必须完成

1. 完成 P13 自动化和生产行为验收。
2. 修复已发现的 Retry 配置字段漂移，并分离 Buy Retry 与 Sell Retry 的 Engine 门禁。
3. 为未批准链增加管理员鉴权、指定 `chain + whitelist_ids` 的只读首次接入通道，不绕过 Live Policy 直接下单。
4. 配置并验真 Robinhood Production RPC。
5. 完成 Robinhood 真实 6551 Signal -> Buy -> Receipt -> Position/Lot -> Strategy -> Close -> PnL。
6. 对 P12/P13 更新后的 SOL、BSC、Base、ETH 做最小真实回归。
7. 形成可发布、可回滚、无密钥泄漏的代码和文档基线。

### 3.2 本阶段不做

- 不新增 Binance、Robinhood CEX 或新的交易 Provider。
- 不把 Robinhood 建模成独立 Provider；它仍是 GMGN 下的一条 EVM Chain。
- 不用 Paper、Mock、Shadow 或手工改数据库布尔值代替真实成交证据。
- 不为测试故意制造 timeout、状态不确定或可能重复扣款的真实交易。
- 不在验收前删除 Paper、TwitterAPI.io、SocialData、Shadow 和历史表。
- 不因为某次 Swap 没及时返回就直接重发。

## 4. 统一门禁

| Gate | 内容 | 资金动作 | 通过后允许 |
|---|---|---:|---|
| G0 | 代码、Migration、单元、构建和独立测试库基线 | 无 | 开始 P13 行为验收 |
| G1 | P13 热加载、Watch、关系、前后端一致性验收 | 无 | 开始 Robinhood 只读接入 |
| G2 | Robinhood RPC、Wallet、Token/Pool/Security/Quote 和有效 Contract Probe | 无 | 开启单白名单限时验收作用域 |
| G3 | Robinhood 最小真实自动 Buy 和真实 Close | 有 | Robinhood 可作为正常白名单链使用 |
| G4 | 四链更新后回归、生产观测和发布检查 | 有 | P14 完成并进入常态迭代 |

任何 Gate 失败都停留在当前阶段，不手工修改数据库 `implemented/contract_tested/live_enabled` 强行跳级。状态口径固定为：

- `executionImplemented`：源码是否具备该链执行能力，只随代码发布变化。
- `contract_tested`：当前代码版本、Migration、RPC 身份、配置指纹和候选 CA 的只读契约是否通过。
- `acceptance_scope`：限时、单链、单白名单的真实验收授权；存在时全系统 Live Policy 只能包含这一条白名单。
- `live_enabled`：完整真实 Buy/Close 证据通过后的生产批准；它必须成为真实门禁，不再是无效数据库布尔值。

## 5. P14-A：P13 正式验收

### A0. 发布前 P0 修复

1. 删除 `execution-service.retryIntent()` 和 `close-service.retryCloseIntent()` 对已被 P13 移除的 `chainConfig.enabled` 依赖。
2. Buy Retry 是否可运行只由以下事实共同决定：
   - Chain Manifest `executionImplemented=true`；
   - 目标链 Readiness 通过；
   - 当前白名单/关系仍有效；
   - `retryEnabled=true`、次数、窗口和绝对费用上限合法；
   - Engine 已解锁并允许新买入；
   - 上一 Attempt 已有 `definitive_failed_no_fill` 证据。
3. Sell Retry 独立使用退出门禁：`TRADING_MODE=live`、总实盘开关开启、链代码可执行、仓位和 Retry 配置有效；即使 Engine stopped 也允许已有仓位退出。
4. 增加 Buy Retry 和 Close Retry 测试，输入必须使用 `configService.validateChainConfigs()` 规范化后的真实配置结构。
5. `risk-manager.js` 中旧链级 `enabled/dailyBudget/...` 只允许存在于显式 Legacy Paper 边界，生产 Live 不得调用。

### A1. 独立数据库验收

1. 创建名称包含 `test` 且不等于生产库的专用数据库。
2. 运行 `npm.cmd run test:integration`，要求完整通过，不接受跳过。
3. 在另一座空测试库执行 Migration 000-016 和 P12/P13/P14 历史回填演练。
4. 验证生产历史 Order、Receipt、Position/Lot、Strategy、Budget/Ledger 行数和关键字段不变。
5. 测试完成后删除测试库或明确标记为可重建测试资产。

### A2. P13 生产行为验收

Watch、关系和 Signal 去重验收时 Engine 保持 stopped，避免资金动作。`LIVE_CONFIGURATION_CHANGED` 和白名单热加载验收不能在 stopped 状态下宣称通过，必须使用 Armed Stub/隔离测试库，或在全系统 Live Policy 为空的受控生产窗口中短时 Armed 验收：

1. 新增一条测试白名单关系，确认只创建/更新 Actor Watch，不创建 Project Target Watch。
2. 在 Armed Stub/隔离环境修改白名单金额、次数、TP/SL、滑点和关系事件，确认配置指纹不变化且不触发 `LIVE_CONFIGURATION_CHANGED`。
3. 验证同一 CA 多 Actor、同一 Actor 多 CA、多个关系命中同一 CA 时的 Watch 去重与 Signal 去重。
4. 验证 Follow、Reply、Quote、Retweet、Tweet/CA/关键词提及的事件权限按关系独立生效。
5. 保存白名单后由 Outbox -> ingestion Worker 自动同步；不再要求手工 Apply。
6. 删除最后一条有效关系后才允许删除 XBOT 管理的远端 Watch；非 XBOT 管理 Watch 不得修改。
7. 前端显示值、配置 API 返回值和数据库白名单字段必须一致。
8. 测试结束清理临时关系和 Watch，不删除真实白名单。

### A3. P13 验收退出标准

- [x] 后端 `173/173` 单元测试通过。
- [x] 前端 lint、TypeScript、production build 通过。
- [x] 独立数据库集成测试 `21/21` 通过。
- [x] Migration 000-016 新库安装和 013-016 历史库升级演练通过；13 张历史业务表和 Outbox 行保持不变。
- [x] 白名单热加载代码路径不主动停止 Engine；Engine stopped 基线下测试通过，运行中生产行为仍需验收。
- [x] Actor-only Watch、自动同步、所有权边界和多对多关系代码与单元测试通过；生产行为验收待完成。
- [x] 普通设置页已移除重复业务预算、旧轮询和旧 Provider 开关。
- [x] Retry 配置字段漂移已修复并有回归测试；Buy Retry 要求 Engine armed，Sell Retry 在 Engine stopped 时仍可退出。

## 6. P14-B：Robinhood 禁用状态接入

### B0. 修复首次接入循环门禁与状态语义

Robinhood 已有统一执行代码，但尚未取得生产批准。只读诊断不能依赖 Live Policy，否则未批准链无法生成首次 Contract Probe；生产执行又不能仅因代码能力存在就自动开放。

修复原则：

1. 明确区分 `diagnostic chains`、`acceptance chains` 与 `production chains`。
2. 管理员只读诊断 API 必须显式指定 `chain + whitelist_ids`，只允许严格只读的 Wallet、RPC、Token、Pool、Security、Quote 和 Strategy 查询，禁止扫描全部 Active 白名单。
3. 正常 Live Policy 只包含 `executionImplemented=true + live_enabled=true + 有效白名单关系` 的链；验收作用域存在时只包含作用域指定的一条白名单，不合并其他生产白名单。
4. 只读诊断不得调用 Swap、Strategy Create/Cancel，不得创建 Attempt、Reservation 或 Wallet Lane。
5. Robinhood Contract Probe 可以在生产批准关闭时写入追加式证据，但不能自动修改 `live_enabled`。
6. 前端分别显示“代码交易能力 / 只读契约 / 限时验收 / 生产批准”，不再用一个含义模糊的开关概括全部阶段。

已实现：

- `POST /api/trade/chains/:chain/diagnose`：显式白名单只读诊断。
- `POST /api/trade/chains/:chain/acceptance/start`：最长 30 分钟、全系统唯一验收作用域。
- `POST /api/trade/acceptance/finish`：Engine stopped 后显式结束或取消作用域。
- `POST /api/trade/chains/:chain/approve`：仅接受同一已完成验收内、当前代码和配置上下文下的完整真实证据。
- 作用域过期后 Live Policy 保持为空，不自动恢复其他生产链。

### B1. Production RPC 与费用配置

1. 首次 Contract Probe/最小验收可使用已验证的 Robinhood 官方 Public RPC；正式生产批准前替换为 Alchemy、QuickNode、Blockdaemon、dRPC 或 Validation Cloud 等稳定 Provider RPC，正式运行不依赖公共限流端点。
2. 验证 RPC 返回 `eth_chainId=4663`、最新区块持续增长、区块时间新鲜、Receipt 和历史区块查询可用。
3. 增加并校验 Robinhood 的：
   - `GMGN_MAX_FEE_RESERVE_ROBINHOOD`
   - `GMGN_MIN_GAS_RESERVE_ROBINHOOD`
4. 首次 Swap 不发送未经真实契约验证的 Robinhood Gas、anti-MEV、tip 或 fee escalation 字段。
5. Retry 在 Robinhood 完整闭环前保持关闭。

2026-07-24 只读结果：

- 官方 Public RPC：`chainId=4663`，最新区块约 3 秒新鲜，连续请求约 330-520ms，区块持续增长。
- GMGN 推荐 Robinhood Gas：high `338408000 wei`（约 `0.338408 gwei`），average `228806000 wei`；这只是 Gas Price，不等于整笔交易总费用。
- GMGN 钱包末尾脱敏引用与 RPC 查询一致，余额为 `0 ETH`；在充值前不得开启真实验收。
- 设置 API 和前端已支持 `GMGN_MAX_FEE_RESERVE_ROBINHOOD`、`GMGN_MIN_GAS_RESERVE_ROBINHOOD`；开启验收前两项必须显式填写正数，不能依赖代码兜底。
- 执行准备和全局 Readiness 同样要求逐链显式正数配置；缺失时返回 `CHAIN_FEE_RESERVE_MISSING` / `CHAIN_GAS_RESERVE_MISSING`，不再使用隐藏默认值。

2026-07-25 审计加固：
- Contract Probe、Trade Intent、Retry Audit 和 `manual_e2e` 统一使用“发布版本 + 工作区源码内容哈希”；代码变化后旧证据自动失效，不再使用固定 `local-worktree`。
- Contract Probe 上下文同时绑定单笔/累计预算、次数、TP/SL、滑点、到期时间及 Actor/Project/Event 关系；真实 Buy 创建 Attempt 前再次核对限时验收上下文，验收期间修改配置会被拒绝。
- Robinhood 加入 EVM CA 地址规范化和大小写无关查重，避免同一 CA 因大小写差异创建重复白名单。
- 增加受保护的测试库管理命令，只允许名称含 `test` 且不同于生产库的数据库执行 `recreate/drop`；本轮两座临时测试库已删除。

### B2. CA 只读矩阵

1. 用户提供一个认可的 Robinhood CA、Project X、KOL Actor 和事件类型。
2. 白名单可以先保存为 Active，因为代码执行门禁仍关闭；Engine 同时保持 stopped。
3. 对该 CA 验证 Address、Token、Pool、Security、Quote、decimals、最小到账量和流动性。
4. 记录代表性平台 CA 的 `passed/failed/not_tested`，平台矩阵不作为所有 CA 的一刀切整链门禁。
5. Contract Probe 通过后生成不可变证据，绑定代码版本、Migration、RPC identity、RPC URL 哈希、配置指纹和 CA；证据有有效期，相关输入变化后自动失效。证据不记录密钥或完整钱包地址，只保存脱敏钱包引用。

### B3. Robinhood 只读退出标准

- [ ] 禁用链可以只读探测，但绝不进入 Live Policy。
- [ ] Production RPC 连续可用并确认 `chainId=4663`。
- [ ] GMGN Wallet 存在，RPC 与 GMGN 余额口径可解释。
- [ ] 至少一个真实候选 CA 的 Token/Pool/Security/Quote 通过。
- [ ] `chain_readiness_evidence` 有 Robinhood passed Contract Probe。
- [ ] 只读检查没有自动打开 `live_enabled`，也没有创建 Attempt、Reservation 或 Wallet Lane。

当前状态：只读诊断与证据代码已完成，官方 Public RPC 已通过基础链验证；等待钱包充值、真实 Robinhood CA/关系、费用参数和 GMGN CA Quote 后执行定向 Contract Probe。稳定 Production RPC 仍是生产批准前置项。

## 7. P14-C：Robinhood 真实自动交易验收

### C0. 用户侧前置条件

真实资金动作前，用户只需要完成：

1. 向 GMGN 返回的 Robinhood 钱包充值少量 Robinhood Chain ETH。
2. 在前端确认唯一测试白名单的单笔金额、累计金额、最大买入次数、TP、SL 和滑点。
3. 确认 Actor -> Project Target 关系及本次实际触发事件。
4. 明确回复确认本次最小真实 Buy；测试金额完全读取白名单，不使用脚本硬编码值。

### C1. 受控开放

1. 停止新买入并确认无未决 Intent、Attempt、Strategy Action、Wallet Quarantine 和 Reconciler Backlog。
2. 备份生产数据库，记录代码版本与配置指纹。
3. G2 通过后由管理员接口创建最长 30 分钟的 Robinhood 验收作用域，绑定唯一白名单；Engine 仍保持 stopped。
4. 验收作用域存在时全系统 Live Policy 只能包含该 Robinhood 白名单，SOL/BSC/Base/ETH 和其他 Robinhood 白名单都不能进入本次自动买入范围。
5. 重新执行 Readiness Probe，核对余额不少于：白名单单笔金额 + Fee Reserve + Exit Gas Reserve。
6. 前端必须清楚显示作用域白名单、到期时间和“生产尚未批准”；用户确认后才启动真实交易。

### C2. 自动 Buy

1. 用户执行真实 6551 互动，不使用后台人工构造 Signal。
2. 核对完整时间线：

```text
6551 Event
  -> Inbox
  -> Activity
  -> Signal + matched_relation_ids
  -> Trade Intent
  -> Attempt #1
  -> GMGN Swap
  -> Query Order
  -> Tx Hash
  -> Robinhood RPC Receipt
  -> exact Token Delta
  -> Position + Lot
  -> TP/SL Strategy
```

3. 同一 Provider Event 重放、同一 Signal 重入和进程重启不得创建第二笔 Buy。
4. 如果响应 timeout、5xx、非 JSON、缺少 Order ID 或状态冲突，标记 uncertain、隔离钱包并继续对账，不重发。
5. 只有 GMGN 终态和链上完整未成交证据同时成立时，才可标记 `definitive_failed_no_fill`；Robinhood 此阶段仍不自动重试。

### C3. 真实 Close

1. Buy confirmed 且 Position/Lot/Strategy 全部一致后，先停止新买入。
2. 从前端点击真实平仓，不使用数据库手工改状态。
3. 先核对/取消未触发 Strategy，再提交一次 Sell。
4. 保存 Sell Order、Tx Hash、Receipt、精确 Token Delta、原生币到账、Gas、PnL 和预算结算。
5. Position 必须进入 closed，Lot remaining 为 0，钱包余额差异可解释。
6. Buy + Sell confirmed 后生成 `manual_e2e` 追加式证据；证据必须同时包含 Buy/Sell Intent、Attempt、Order、Tx Hash、Receipt、Position/Lot、Strategy、Budget/Ledger 和代码版本，缺少任一关键项只能记录 failed，不能冒充通过。

### C4. Robinhood 退出标准

- [ ] 真实 6551 事件自动触发一次且仅一次 Buy。
- [ ] GMGN Order、Tx Hash、`chainId=4663` Receipt 和 Token Delta 一致。
- [ ] Position、Lot、Strategy、Budget Reservation/Ledger 正确。
- [ ] 前端真实 Close 成功，到账、Gas 和 PnL 可解释。
- [ ] 进程重启和事件重放不重复交易。
- [ ] 无未决 Intent、无 Wallet Quarantine、无未保护仓位。
- [ ] Engine stopped 后，由管理员批准接口校验有效 Contract Probe 和完整 `manual_e2e`，再设置 `live_enabled=true`；不得由 Close 自动扩大 Live Policy。
- [ ] Robinhood Retry 仍保持关闭，等待单独验收。

当前状态：完整 `manual_e2e` 已改为逐项核验 Buy/Sell Intent、Attempt、Order、Receipt、Position/Lot、Strategy 和 Budget/Ledger；缺失任何关键证据只写 `failed`。真实 Robinhood Buy/Close 尚未执行。

## 8. P14-D：四链更新后回归与 Retry 开放

### D1. SOL/BSC/Base/ETH 最小真实回归

每条链按相同顺序单独执行，不并行触发：

1. 用户在前端确认该链唯一测试白名单和最小金额。
2. 真实 6551 事件自动 Buy。
3. 核对 Intent、Attempt、Order、Receipt、Position/Lot 和 Strategy。
4. 从前端真实 Close，核对 Receipt、余额和 PnL。
5. 一条链完成并清空未决状态后再进入下一条链。

退出标准：更新后的五条链都使用同一状态机完成真实自动 Buy/Close，没有链级特殊旁路。

### D2. Retry 验收与逐链开放

1. 单元和独立数据库集成测试覆盖 Buy/Sell Retry、双 Worker、重启恢复、Late Confirmation、Multiple Fill 和预算只结算一次。
2. HTTP 资金写请求本身保持零自动 retry。
3. timeout、5xx、429、缺 Order ID 和非 JSON 永不直接创建下一 Attempt。
4. 不故意制造真实不确定交易；生产只在自然出现且证据完整的 `definitive_failed_no_fill` 上观察 Retry。
5. 每条链独立设置 `retryEnabled`、`maxRetries`、窗口和绝对费用上限；一次只开放一条链。
6. Robinhood 必须先完成正常 Buy/Close，再定义已验证 Fee 字段，最后才能进入 Retry 验收。

Retry 可以晚于基础自动交易上线，但系统和前端必须明确显示“正常交易可用，自动重试未开放”，不能把两者混成一个状态。

## 9. P14-E：生产观测、发布与清理

### E1. 必须完成的生产观测

1. 页面可发现：uncertain、Wallet Quarantine、Chain Circuit、Retry scheduled/success/exhausted、Late Confirmation、Multiple Fill、未保护仓位和 Ledger 差额。
2. Reconciler、Strategy Reconciler、Terminal Audit 和 Watch Worker 重启后恢复。
3. 6551 receive -> inbox -> signal -> execution -> swap 延迟使用真实时间戳统计，不把订单确认轮询时间误算为触发延迟。
4. Fast Path SLO 达到至少 50 条真实生产样本后再声明通过；Provider 回放单独统计，不混入生产 Fast Path SLO。
5. Telegram 等外部告警可以后续接入，但未接入时前端必须明确显示“仅站内告警”。

### E2. 发布安全

1. 运行单元、lint、build、独立数据库集成和 Migration 演练。
2. 运行 `git diff --check` 和 JavaScript/TypeScript 语法检查。
3. 扫描 Git tracked/staged 内容，确认 `.env`、PEM、API Key、完整钱包地址、数据库备份和真实响应未进入版本库。
4. 核对 `.gitignore` 覆盖 `.env`、PEM、logs、dist 和数据库备份。
5. 生成发布说明、数据库备份标识、代码版本和回滚点后再提交/推送。

### E3. 延后清理

以下内容不阻断 Robinhood 基础实盘，但必须作为后续结构工作保留：

- 将过大的 `trade-repository.js` 按 Intent、Settlement、Strategy、Query 拆分为兼容模块。
- 将 `SettingsPage.tsx` 拆分为运行状态、Provider、RPC 和高级诊断组件。
- 在生产可达性与专项回放价值再次确认后，删除 Paper/Shadow/旧 Provider 代码和旧表。
- 删除源码中的旧绝对路径和无消费者 API。

结构拆分和资金语义修改不得在同一个提交中混合。

## 10. 测试矩阵

| 测试 | 环境 | 真实资金 | 主要证据 |
|---|---|---:|---|
| P13 单元/构建 | 本地 | 否 | 161+、lint、build |
| P13 集成/Migration | 独立测试库 | 否 | 完整测试输出、行数与约束 |
| Watch/关系热加载 | 生产 Provider，Engine stopped | 否 | Outbox、远端 Watch、Signal |
| 配置指纹热加载 | Armed Stub/隔离库或 Live Policy 为空的受控窗口 | 否 | 指纹不漂移、Engine 不停止 |
| Robinhood RPC/Quote | 生产只读 API | 否 | chainId、区块、Quote、Contract Probe |
| Robinhood 自动 Buy | 生产 | 是 | Event 到 Receipt/Position 全链路 |
| Robinhood Close | 生产 | 是 | Sell Receipt、余额、PnL、manual_e2e |
| 四链回归 | 生产 | 是 | 每链 Buy/Close 证据 |
| Retry 故障矩阵 | 单元 + 独立测试库 | 否 | definitive/uncertain 分类、幂等和预算 |
| Retry 生产观察 | 生产自然失败 | 可能 | 多 Attempt、失败证据、无重复成交 |
| 发布安全 | 本地/Git | 否 | Secrets 扫描、diff、版本和备份 |

## 11. 故障处理与回退

1. 停止 Engine 只停止新 Buy，不停止已提交 Attempt 的 Reconciliation 和已有仓位退出。
2. Robinhood 首笔出现 uncertain 时，立即保持该链不开放、隔离对应钱包并持续对账。
3. 任何 Late Confirmation 以链上事实为准，补记 Position/Lot/Ledger，不用业务终态覆盖真实成交。
4. Multiple Fill 不自动反向交易，冻结对应钱包并等待人工处置。
5. RPC 与 GMGN 结果冲突时不猜测成功或失败，不重试。
6. 回滚代码前必须确认没有正在提交或等待确认的资金写入；Migration 013-016 不做破坏性回滚。
7. 验收作用域到期后 Live Policy 立即变为空并停止新买入，不自动回退为四链正常 Policy；必须由管理员显式结束作用域。

## 12. 用户需要提供的内容

进入 P14-B/C 时只需要用户提供或确认：

1. 可用于 Robinhood 生产验真的 RPC URL。
2. Robinhood GMGN 钱包已充值少量 ETH。
3. 一个认可的 Robinhood CA、Project X、KOL Actor 和事件类型。
4. 前端填写的单笔金额、累计金额、次数、TP、SL 和滑点。
5. 每次真实 Buy/Close 前的明确确认。

其余代码、数据库、Readiness、证据和测试由 XBOT 统一处理，不要求用户重复配置第二套链预算或 CA 许可。

## 13. P14 完成定义

P14 只有同时满足以下条件才算完成：

- [ ] P13 独立数据库和 Migration 已通过；真实 Provider 生产行为验收仍待完成。
- [x] Retry 遗留 `chainConfig.enabled` 问题已修复。
- [x] Robinhood 首次只读接入不再受 Execution Policy 循环门禁影响。
- [x] Robinhood 代码能力、只读契约、限时验收和生产批准四种状态已经分离。
- [ ] Robinhood Production RPC、Wallet、CA Quote 和 Contract Probe 通过。
- [ ] Robinhood 真实自动 Buy/Close、Receipt、Position/Lot、Strategy、Budget/PnL 闭环通过。
- [ ] SOL/BSC/Base/ETH 在 P12/P13 更新后完成最小真实回归。
- [ ] 五链没有未决 Intent、Wallet Quarantine、Multiple Fill 或未保护仓位。
- [ ] Retry 状态按链明确显示为“关闭 / 验收中 / 已开放”，不冒充已完成。
- [ ] Robinhood 验收期间 Live Policy 只有唯一白名单，旧四链白名单不会并行触发。
- [ ] 生产观测能够发现资金状态异常，外部告警未接入时有明确提示。
- [ ] Secrets 扫描、测试、构建、备份和发布基线完成。
- [ ] 文档入口、架构图和运行状态不再把历史实现记录描述为当前完成状态。

最终可声明：

> **XBOT 已完成 P13 白名单主导配置的生产验收，并在 SOL、BSC、Base、Ethereum 和 Robinhood 上通过统一 GMGN 交易内核完成真实自动 Buy/Close；系统只在上一 Attempt 被证明明确失败且未成交后才允许按链受控重试，任何不确定资金状态都不会自动重发。**
