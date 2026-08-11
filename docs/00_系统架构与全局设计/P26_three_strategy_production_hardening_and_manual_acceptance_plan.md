# P26 三策略生产固化与人工实盘验收方案

> 版本：v1.2
> 日期：2026-08-11
> 状态：P26 正式代码收口与自动回归已完成；人工三策略真实 X 行为实盘验收待执行
> 前置基线：P25 三策略真实小额成交、后端全量测试、前端构建和 DOM 验收均已通过

> 实施记录：P25 verified baseline 已以 `dfd1c48` 推送至 `codex/p25-verified-baseline`。P26 已在独立分支实施生产角色拆分、Research 启动隔离、Attempt 级审计、保护策略批量同步、Query Order 正确性修订、历史 Warmup/Trenches 运行路径清理和全局 GMGN 审计。自动回归为后端 `498/498`、前端 lint/build 通过，桌面与移动端核心页面 DOM 通过且无控制台错误；Engine 运行中的 12 秒无事件观察窗口记录 GMGN 总请求 `0`、买入请求 `0`、429 `0`、未知来源 `0`。P26 仍须完成第 11 节人工三策略实盘验收后才能标记全部完成。

> 证据边界：P25 三笔成交使用隔离脚本构造策略触发结果，资金执行、GMGN Order、链上 Receipt 和 Position/Lot 均为真实；它证明的是“三类 Signal 到统一交易内核”的真实资金闭环，不等同于真实 6551/Grok 端到端事件验收。真实 X 入口由 P26 人工验收覆盖。

## 1. P26 目标

P26 不再增加新的交易前置门槛，也不重新设计三种策略。它只做三件事：

1. 把 P25 真实成交验证过的执行行为固化为正式代码契约。
2. 删除临时触发、历史兼容分支和可能重新制造 GMGN 高频调用的路径。
3. 使用真实 X 行为依次完成固定 CA、P20 动态喊单、P21 新关注发现三次人工实盘验收。

P26 完成后，三种策略的买入必须共同遵守同一条资金链路：

```text
真实 6551 事件
  -> 策略域独立判断是否命中
  -> 策略域输出确定的 chain + CA
  -> 原子创建唯一 Signal
  -> Live Queue 原子 Claim
  -> execution_session_id = signal:<signal_id>
  -> 必要参数组装
  -> GMGN Swap（严格一次）
  -> GMGN Order Query（仅订单未确定时）
  -> RPC Receipt
  -> Position / Position Lot / Exit Strategy
```

未命中条件的策略不得创建交易 Signal，不得预留 GMGN 配额，也不得调用 GMGN。

卖出和平仓不是第二次买入，也不能复用买入会话：

```text
Position / Position Lot
  -> 独立 Sell Intent
  -> 独立 Sell Attempt
  -> execution_session_id = attempt:<attempt_id> 或 position:<position_id>
  -> 每个 Sell Attempt 最多一次 GMGN Swap
  -> Order / Receipt / Lot Settlement
```

## 2. P25 成功基线

P26 以以下真实成交证据为不可回退基线：

| 策略 | Signal | Attempt / Order | Position | Tx Hash | 结果 |
|---|---:|---|---:|---|---|
| 固定 CA | `820` | `130 / 44` | `567` | `0x320802ccf9a2b7cd9691c6d62f6e74cfc7d28dc7ea28f09c92724a023c271eac` | confirmed |
| P20 动态喊单 | `821` | `131 / 45` | `568` | `0x5ded7cccfca9f535f3e76522a852ab40e272524de929d05258e59e6372aa9d64` | confirmed |
| P21 新关注发现 | `822` | `132 / 46` | `569` | `0x11f825eabad55bc5d53a3becbf23de833043df1dc32f50f77231147c6b4ddf41` | confirmed |

P25 已证明成立的事实：

- 三种策略都能进入同一个 Live Queue 和 GMGN 执行内核。
- 每个 Signal 只有一次 Swap。
- Robinhood 的 Order、Tx、Receipt、Position 和 Lot 可以完整闭环。
- 默认热路径不需要 `security`、`token/info`、`pool`、预热或美元价格硬门槛。
- 新两笔交易的 GMGN 请求均为 HTTP `200`，没有 `429`。
- 未知 `native_usd_price` 保持 `null`，不再被错误写成 `0`。
- Robinhood 报告值与钱包 Transfer 相差 1 raw unit 时，可以使用链上实际到账完成结算。

P25 尚未证明、必须由 P26 人工测试补齐的范围：

- 真实 6551 WSS 事件从接收到 Signal 的完整路径；
- P20 真实发布/回复内容的解析、链确认和去重；
- P21 真实 Follow、Grok/x_search、RPC 链确认和去重；
- 三种真实 X 事件与后台 Research、Readiness、保护策略同步并存时的全局 GMGN 调用边界。

## 3. 三策略正式职责

### 3.1 固定 CA 策略

固定策略的正式输入来自已保存配置：

```text
KOL / 项目关系 + 允许的事件类型 + 固定 chain + 固定 CA
```

执行规则：

- 6551 事件必须命中已启用关系和事件类型。
- 直接读取配置中的 `chain + CA`，不重新发现、不重新验收、不调用 GMGN 验证。
- 一个语义事件只能创建一个固定策略 Signal。
- 配置保存、页面读取、Watch 同步和 Engine 启动均不得调用 GMGN。

### 3.2 P20 动态喊单策略

P20 只负责判断新帖、回复、引用或其他允许内容是否表达买入意图，并解析确定资产。

解析优先级：

1. 完整 Solana CA：按地址格式确定 Solana。
2. 完整 EVM CA：使用策略允许链和本地 RPC 合约代码唯一性确定链。
3. 本地 Candidate Index 中唯一且未过期的 `chain + CA`。
4. 已配置 ticker、名称或项目上下文的唯一匹配。

P20 在解析阶段不得调用 GMGN `security`、`pool`、`token/info`、`trending` 或 `trenches`。无法唯一确定链和 CA 时必须停在解析失败或歧义状态，不得猜链、猜 CA 或提交交易。

### 3.3 P21 新关注发现策略

P21 的监听与研究职责保持分离：

```text
6551 Follow
  -> 确认关注方向与稳定 target user id
  -> Grok/x_search 研究目标账号、项目身份和关联账号
  -> 提取候选 CA 与链证据
  -> 本地 RPC 验证 EVM 合约部署链
  -> 唯一 chain + CA
  -> Signal
```

执行规则：

- Grok 提示词只描述 X 研究目标，不包含 GMGN、本地程序或交易执行指令。
- Grok 没有明确链证据时，EVM 链由本地 RPC 唯一性确认。
- GMGN 不参与关注发现、账号身份研究或 CA 提取。
- 只有唯一可信 `chain + CA` 才能创建 Signal。
- Baseline、历史关注和重复关注不得产生买入 Signal。

## 4. 统一 Signal 逻辑合同

三种策略进入交易域前必须形成同一份逻辑执行投影。它不是要求 `trade_signals` 新增同名物理列：

```text
signal_id
strategy_type             fixed | dynamic | follow_discovery
activity_id
provider_event_id
source_created_at
chain_id
contract_address
whitelist_id / policy_id
budget_per_trade
slippage
execution_mode = live
trace_id
semantic_key
```

字段来源必须明确：

| 逻辑字段 | 当前正式来源 |
|---|---|
| `strategy_type` | `trade_signals.signal_type` 及 P20/P21 policy 外键 |
| `activity_id` | `trade_signals.activity_id` |
| `provider_event_id`、`source_created_at`、`semantic_key` | `x_activities` / `x_provider_events` |
| `chain_id`、`contract_address`、`budget_per_trade`、`slippage` | `ca_whitelist` 及对应 policy snapshot |
| `trace_id` | `trade_signals.trace_id`，缺失时使用稳定执行 Trace |
| `execution_session_id` | Provider Audit 的 `context_json`，买入为 `signal:<signal_id>` |

正式代码不得根据策略类型分别组装或提交 GMGN Swap。Signal 之后统一进入执行服务，但必须保留 P20/P21 的策略版本、事件时效、日预算、单币买入次数和 Usage Ledger 授权适配器。

数据库约束与 Claim 必须保证：

- 同一语义事件和策略目标最多一个 Signal。
- 同一 Signal 最多一个活动 Buy Intent。
- 同一 Signal 最多一个成功的 Buy 资金写入 Attempt。
- 每个资金写入 Attempt 最多提交一次 Swap；买入、人工卖出和重试恢复分别按 Attempt 幂等。
- 订单不确定时只允许 Query Order 和 RPC Receipt，不允许再次 Swap。

## 5. GMGN 正式调用边界

### 5.1 触发前调用数

以下阶段 GMGN 调用必须为 `0`：

- 后端启动与 Engine 恢复；
- 页面读取、DOM 刷新和 Readiness 普通读取；
- 固定 CA 保存或修改；
- 6551 Watch 同步；
- P20 内容解析与候选索引读取；
- P21 Grok/x_search 研究和 RPC 链确认；
- 未命中条件的其他策略。

### 5.2 单个 Signal 的允许调用

```text
gas_price             0 或 1，仅链适配器确实需要时
quote                 0 或 1，仅明确启用或 GMGN 提交要求时
security              默认 0，仅显式策略选项启用时为 1
token_info            默认 0，仅缺少交易必需字段时为 1
swap                  必须为 1
query_order           按订单终态和总截止时间有界查询，不设置 4 次正确性硬上限
strategy_association  0–2，仅创建了保护策略且响应缺少 strategy id 时
```

`query_order = 4` 只可作为单笔验收告警阈值。超过阈值后继续按 `1s -> 2s -> 5s -> 15–30s` 自适应降频，直到明确终态、达到订单恢复截止时间或进入人工核对；任何情况下不得因查询次数再次 Swap。

所有请求必须写入：

```text
signal_id
trace_id
execution_session_id
stage
rate_scope
endpoint
http_status
latency_ms
```

买入请求使用 `signal:<signal_id>`；平仓使用 `attempt:<attempt_id>` 或 `position:<position_id>`；后台策略同步和恢复使用独立的 `strategy:<id>:recovery` / `attempt:<id>:recovery`。不同资金操作不得共用 Session，也不得仅按 Signal 统计整个持仓生命周期的 Swap 次数。

### 5.3 429 行为

- 全部 GMGN 请求必须经过同一个共享 Rate Gate。
- 429 后按官方 `reset_at` 进入共享冷却，不允许各 Worker 独立重试。
- 已过期 Signal 不补买。
- 已提交 Swap 的订单只能恢复查询，不得重新 Swap。
- 429 不得被改写成策略未命中、CA 错误或余额错误。

### 5.4 独立 Research 与 Readiness

- P21 Follow Live Worker 不得调用 GMGN Candidate Verification。
- Token Research 是独立、显式、人工触发的运维能力，不属于 P21 买入链路，不得删除其正式 API。
- `researchQueue` 在 Engine `desired_running/recovering/armed` 任一状态下均不得 Claim 新任务。
- 服务启动时必须先恢复 Engine 持久化意图，再决定是否启动或唤醒 Research Queue，禁止利用 `isArmed=false` 的恢复窗口处理积压 GMGN 研究任务。
- Readiness 普通读取调用数为 0；显式 Probe 必须单独标记 `source/stage/session`，并在实盘买入和订单恢复期间等待。

## 6. 成交与结算合同

### 6.1 成交证据优先级

```text
GMGN Order confirmed
  + Tx Hash
  + RPC Receipt confirmed/status=1
  + 管理钱包目标 Token Transfer
```

四项同时存在才能创建或确认 Position/Lot。

### 6.2 Robinhood raw amount 规则

P25 实测中 GMGN 报告：

```text
136945918108349897997117
```

链上管理钱包实际 Transfer：

```text
136945918108349897997116
```

P26 正式规则：

- 仅 Robinhood 买入允许 GMGN 报告比实际 Transfer 多 `1 raw unit`。这是基于 P25 单笔实测的受控兼容规则，不声明为 GMGN 官方契约。
- 超过 1 raw unit 仍进入人工核对，不允许按比例模糊放宽。
- Position、Lot 和可卖数量必须使用链上管理钱包实际 Transfer。
- 卖出仍要求精确核对管理钱包 Token 流出和可验证的原生币流入。
- Token 税、错误 Transfer、错误钱包或错误合约不得借此规则通过。
- 兼容通过时仍必须逐项匹配 Chain、Token Contract、管理钱包、Transfer Topic 和 Tx Hash，并记录兼容规则版本及差额。

### 6.3 幂等与事件记录

- 相同 Attempt 状态和相同错误码不得每秒重复写事件。
- `reconciliation_required` 只在状态首次变化时记录告警。
- 已确认 Order 的只读重结算不得再次请求 Swap。
- 历史重复审计记录保留，不直接删除；新版本不得继续增长。

## 7. 保护策略与后台同步

GMGN 服务端负责执行已创建的止盈止损策略。本地查询只负责更新 Position 状态，不参与触发止盈止损。

正式策略：

- 新建保护策略后首次本地同步延后至少 5 分钟。
- `running` 状态按 5–10 分钟同步。
- `unknown` 状态按不低于 60 秒同步。
- 已检测到 `triggered/cancelling` 后可按 1 秒完成短期确认。
- 同一 `chain + wallet + query type` 在一个同步窗口必须复用同一份 open/history 查询结果，再按 Provider Order ID 分发到 Strategy Group；不得按每个 Group 独立请求。
- 若 GMGN 接口在特定链不能无 Token Filter 批量查询，必须实施确定性错峰、每周期调用预算和待处理数量告警，不能退回同步突发轮询。
- P26 不允许恢复 10–30 秒常驻轮询。
- 买入完成与保护单同步使用不同阶段标记，不得让后台同步污染买入调用计数。

## 8. P26 正式代码更新范围

### 8.1 交易域

重点复核并收口：

- `backend/domains/trade/live-execution-queue.js`
- `backend/domains/trade/execution-service.js`
- `backend/domains/trade/triggered-provider-context.js`
- `backend/domains/trade/reconciliation-service.js`
- `backend/domains/trade/trade-repository.js`
- `backend/domains/trade/trade-intent-repository.js`
- `backend/domains/trade/provider-audit-service.js`

目标是移除策略专属 GMGN 请求分支、重复 Snapshot、重复 Provider 查询和同状态重复落库，不引入新的通用框架。P20/P21 的 Runtime Authorization 与 Usage Ledger 分支必须保留。

### 8.2 三个触发域

复核：

- 固定策略 Matcher 与关系权限；
- P20 Resolver、Target Materializer 和 Signal 创建；
- P21 Follow Inbox、Grok Research、RPC 链确认、Materializer 和 Signal 创建。

只允许三个域输出统一 Signal，不允许直接引用 GMGN 底层客户端或执行函数。

### 8.3 GMGN 与启动边界

复核：

- `gmgn-access-service` 是业务模块唯一 Provider 入口；
- `gmgn-http` 只保留签名、HTTP 和响应标准化；
- `provider-rate-recorder`、共享 Gate 和审计 scope 一致；
- `server.js` 不启动 Warmup、Trenches、Token/Pool 或余额扫描；
- 正式环境由 Supervisor 显式启动 `--role=ingestion` 和 `--role=execution`，禁止在生产 `.env` 固定 `XBOT_PROCESS_ROLE=all`。
- `--role` 参数优先于 `.env`；`all` 只允许本地单进程开发和明确的测试命令。
- 直接执行正式 `node server.js` 且未指定角色时必须失败关闭，不能静默回落为 `all`。
- Research Queue 必须在 Engine 持久化意图恢复后启动，并服从 `desired_running/recovering/armed` 三态隔离。

## 9. 历史代码清理规则

P26 实施时执行静态扫描，分类处理历史代码：

### 必须删除

- 自动构造 6551/Grok 触发并真实下单的临时验收脚本；
- P21 Live Worker、启动恢复和自动任务中的 GMGN Candidate Verification；独立 Token Research 正式入口保留并隔离；
- P20/P21 事件级 GMGN Activation；
- 启动 Warmup、Trenches 和无事件 Provider Poll；
- 三个策略各自直接调用 Swap 的历史分支；
- 已删除任务仍残留的 package script、cron 注册和测试引用。

删除清单必须显式核对：

- `backend/scripts/run-p25-three-strategy-real-acceptance.js`；
- `backend/tests/p25-three-strategy-real-acceptance.test.js`；
- `test:p25:three-live` 等可自动制造触发并真实下单的 package script；
- 已退役 Warmup、Trenches、Price Monitor、旧 Signal Matcher 对应的 job、cron、测试和 import；
- `.vs/` 等 IDE 元数据、临时 stdout/stderr、运行日志、截图和验收输出不得进入 Git；只读核验器 `run-p25-live-acceptance.js` 保留。

### 必须保留

- Signal/Intent/Attempt/Order 的幂等约束；
- 共享 Rate Gate 与 Provider Audit；
- Query Order、RPC Receipt 和未知提交恢复；
- Position/Lot、保护策略、平仓与预算账本；
- 只读成交证据核验工具。

### 禁止做法

- 不以“简化”为由删除订单对账或幂等保护。
- 不把 Paper/Mock 结果作为 Live 通过证据。
- 不添加猜链、猜 CA、旧缓存兜底或失败后再次 Swap。
- 不清空历史资金表或人工修改成交结果。

## 10. 实施顺序

### P26-1 基线冻结

- 保存当前数据库迁移版本、代码 diff 和三笔 P25 成交证据。
- 记录当前 GMGN 429 计数、Engine Scope 和运行配置。
- 确认自动真实下单验收脚本已经删除。
- 执行 Secret 扫描与冗余文件审计，确认 `.env`、私钥、运行日志和截图不进入 Git。
- 在 P26 改业务代码前，将通过测试的 P25 正式基线作为独立 Git 提交推送，确保可审计和可回退；P26 使用后续独立提交。

### P26-2 静态边界审计

- 扫描全部 GMGN 入口和调用来源。
- 扫描三策略到 Signal 的所有创建路径。
- 扫描启动任务、定时任务和恢复任务。
- 输出“保留、删除、改造”清单后再修改代码。

### P26-3 正式代码收口

- 固化统一 Signal 合同和唯一 ExecutionSession。
- 固化 Robinhood Receipt 结算规则。
- 固化重复错误事件幂等。
- 固化策略查询批量复用、错峰和低频调度。
- 修正启动角色和正式运行命令。
- 修正 Research Queue 启动顺序和实盘状态隔离。

### P26-4 自动回归

- 三策略 Trigger/Signal 单元测试。
- GMGN 调用计数与 429 冷却测试。
- Buy/Sell Attempt 级幂等测试，证明合法平仓不会被买入 Signal 的唯一性约束拦截。
- Research 启动恢复窗口、Readiness Probe 隔离和 Strategy 批量同步测试。
- Receipt/Transfer/Position/Lot 结算测试。
- 后端全量测试、前端构建和核心页面 DOM 测试。
- 此阶段禁止任何自动真实下单脚本。

### P26-5 人工三策略实盘验收

由用户在 X 执行真实行为，执行代理只监控和核对，不制造事件。

## 11. 人工三策略测试方案

### 11.1 测试前条件

- 前端 `127.0.0.1:5182`、后端 `127.0.0.1:3011` 正常。
- Settings 显示“真实交易运行中”。
- 6551 WSS 已连接，Watch 同步无待处理错误。
- 三种策略均为 Live；按测试链分别设置并确认原生币小额预算、Gas 余量和 GMGN 最小交易要求。本轮 Robinhood 样本可使用 `0.001 ETH`，不得把 `0.001` 无单位复制到所有链。
- GMGN 当前不在 429 cooldown。
- 每次测试使用新的语义事件，避免 6551 去重和 CA 买入次数限制。
- 每笔测试开始前记录 Provider Audit 基线时间。

### 11.2 测试一：固定 CA

1. 选择一个当前 `live_ready`、尚未达到买入次数上限的固定 CA 策略。
2. 用户使用策略配置的 KOL 账号执行允许的真实事件。
3. 等待 Signal、Attempt、Order、Receipt、Position/Lot 全部确认。
4. 核对固定策略未重新发现 CA、未调用 Token/Security/Pool。
5. 未完成前不得开始测试二。

### 11.3 测试二：P20 动态喊单

1. 用户使用已配置 P20 KOL 发布或回复一条包含完整 CA 的新内容。
2. CA 必须能由地址格式、允许链和 RPC 唯一确定链。
3. 核对 P20 只创建一个 Dynamic Signal。
4. 等待完整 GMGN 和链上结算。
5. 未完成前不得开始测试三。

### 11.4 测试三：P21 新关注发现

1. 用户使用 `@xueqiu88` 关注一个此前未处理的新项目账号。
2. 6551 必须返回新的 Follow 事件和稳定目标身份。
3. 核对 Grok/x_search 输出项目身份、CA、链证据和来源。
4. EVM CA 使用本地 RPC 确定唯一部署链。
5. 只在唯一 `chain + CA` 后创建 Follow Discovery Signal。
6. 等待完整 GMGN 和链上结算。

### 11.5 单笔通过标准

```text
Signal exactly 1
Buy Intent exactly 1
Buy Attempt exactly 1
Swap exactly 1
GMGN Order ID present
Tx Hash present
RPC Receipt confirmed/status=1
Managed-wallet token Transfer verified
Position exactly 1
Position Lot at least 1
GMGN 429 count = 0
No unauthorized GMGN request in the global test window
```

“全局测试窗口”必须查询起始基线时间后的全部 `provider_rate_events`，不能只按当前 `signal_id` 查询。当前买入 Session、合法的订单恢复、已有持仓保护策略同步、显式 Research 和 Readiness Probe 必须按 `source + stage + execution_session_id` 分类；保护策略低频同步单独计量，不得误判为其他策略触发买入。

### 11.6 立即停止条件

任一条件出现时停止后续测试并保留现场：

- Signal 重复，或当前 Buy Attempt 出现第二次 Swap；合法的后续 Sell Attempt 不计入此条件；
- chain 与真实部署链不一致；
- GMGN 返回 401、403、429 或 Schema Invalid；
- Order confirmed 但 Receipt/Transfer 不一致；
- Attempt 长时间停在 `execution_reserved`、`submitting` 或 `reconciliation_required`；
- 未触发的其他策略产生买入类 GMGN 请求，或出现无法归属到合法 Session 的 GMGN 请求；
- Position/Lot 未创建或数量不等于链上实际到账。

停止后只允许只读审计和 Query Order/RPC Receipt 恢复，禁止重新提交同一笔 Swap。

## 12. 回归与发布门槛

P26 代码只有满足以下全部条件才允许提交正式版本：

1. `git diff --check` 通过。
2. 后端全量测试全部通过。
3. 前端 TypeScript 和 Vite Build 通过。
4. Settings、Strategies、Dynamic、Follow Discovery、Signals、History、Positions DOM 非空且无控制台错误。
5. 无事件观察窗口内 GMGN 交易相关调用为 `0`；保护单低频同步单独计量。
6. 人工三策略各一笔真实小额交易完整确认。
7. Provider Audit 无重复 Swap、跨 Signal Session 或未授权调用。
8. 自动真实下单测试脚本和命令不存在于正式版本。
9. Strategy Group 同步没有按 Group 放大的 GMGN 请求，Research/Readiness 不与实盘买入争抢配额。
10. Git Secret 扫描和冗余文件清单通过，运行日志、私钥、截图和临时验收产物未被跟踪。

## 13. GitHub 更新策略

需要更新 GitHub，但不能把当前全部未提交修改直接混成一个不可审计提交：

1. P26 实施前：清理临时真实下单脚本、冗余任务引用和运行产物，完成 Secret 扫描、全量测试、前端构建和 DOM 回归。
2. 将已验证的 P21-P25 正式代码与迁移作为“P25 verified baseline”独立提交并推送，保留三笔真实成交证据但不提交密钥或敏感日志。
3. P26 正式代码使用独立分支/提交，提交内容只包含本方案列出的生产固化修改。
4. P26 自动回归通过后再推送代码；人工三策略实盘结果以独立验收文档或后续提交补充，不改写历史提交。
5. 推送前必须再次执行 `git diff --check`、全量测试、前端构建、DOM 测试和 `git status` 文件分类审计。

## 14. 对现有功能的影响

- 固定 CA：不改变配置、匹配、预算、止盈止损和平仓能力。
- P20：不改变内容意图规则，只明确链/CA 解析和 GMGN 边界。
- P21：不改变 Grok/x_search 研究能力，只禁止 GMGN 参与研究阶段。
- 已有 Position：不迁移、不重建、不重买；继续由原 Order、Lot 和保护策略管理。
- 历史审计：保留全部真实资金证据，不删除旧事件。
- GMGN：减少无事件调用和后台查询频率，不影响实际 Swap 或服务端保护单执行。

## 15. P26 完成定义

P26 只有在“正式代码收口 + 自动回归 + 用户真实 X 行为三策略成交”全部通过后才标记完成。方案审核通过前不执行 P26 代码更新；任何一笔人工测试失败，都必须先定位并修复正式链路，不允许用脚本制造新 Signal 绕过问题。
