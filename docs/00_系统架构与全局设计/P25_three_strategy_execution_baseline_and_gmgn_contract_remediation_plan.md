# P25 三策略成交基线恢复与 GMGN 契约统一方案

> 版本：v1.2
> 日期：2026-08-11
> 状态：已完成代码更新、三策略真实小额成交验收和 DOM 回归，进入人工事件实测阶段
> 基线：`origin/main = da5f8533d1944871815e45cd2e3bffa88296a1d6`
> GMGN 官方参考：`GMGNAI/gmgn-skills = 256957db97638e2a70c51b8f65b9338877c7d54f`，`gmgn-cli 1.5.6`

> 2026-08-11 实测补充：GMGN 服务端负责执行已创建的止盈止损单；本地 `strategy_groups` 的 `running` 状态查询仅用于同步本地仓位，不参与买入或止盈止损触发。新建保护单的首次同步延后 5 分钟，后续默认同步间隔由 10–30 秒调整为 5–10 分钟；`triggered/cancelling` 状态仍保留 1 秒确认，避免持仓数量增长后形成无事件的 GMGN 高频调用。

## 1. 结论

P25 不是继续给 P24 增加例外，而是重新建立三策略共同遵守的执行标准：

1. 固定 CA 和 P20 动态策略以 GitHub 已真实成交版本为能力基线。
2. 保留 P24 正确的 Provider 边界：没有合格 Signal 时 GMGN 调用数必须为 0。
3. 删除 P24 引入的错误假设：Live 不能读取本地 Candidate Index、EVM 地址只能在单链策略中解析、删除 GMGN 价格源后仍要求美元预算快照。
4. P21 关注发现只负责通过 Grok/x_search、X 证据和 RPC 得到确定的 `chain + CA`，然后进入与前两种策略相同的交易内核。
5. 三种策略不再各自拼装 GMGN 请求。唯一被 Claim 的 Signal 创建唯一 ExecutionSession；本地只负责幂等、参数组装和结果落库，GMGN 负责实际交易提交。
6. 不提供 Mock、Paper、猜链、假价格、静默跳过 Security、缺字段继续交易或失败后重复 Swap 等降级方案。

最终主链路：

```text
6551 事件
  -> 策略专属触发判断
  -> 确定 chain + CA（本地配置 / 本地 Candidate Index / Grok+x_search / RPC）
  -> 原子创建唯一 Signal
  -> Live Queue 原子 Claim
  -> 唯一 ExecutionSession（本地幂等与参数组装）
  -> GMGN 必要参数请求（仅链适配器需要时读取 Gas）
  -> GMGN Swap / Quote
  -> Query Order + RPC Receipt
  -> Position / Lot / Exit Strategy
```

## 1.1 v1.2 执行链路优化（覆盖旧版交易前置门槛）

本节优先级高于本文旧版关于“每次买入必须先完成 Security、Gas、Quote、Token Info、USD 快照和本地风险硬校验”的描述。P25 的目标是：确定的 `chain + CA` 进入唯一交易会话后，尽快把交易交给 GMGN，而不是在本地再复制一套交易决策系统。

### 三层职责

```text
Trigger Domain
  6551 / Grok
  -> 确定 chain + CA
  -> 创建不可变 Signal

Thin Local Execution Protocol
  -> 原子 Claim Signal
  -> 创建 execution_session_id = signal:<signal_id>
  -> 去重，保证最多一次 Swap
  -> 组装 wallet / input / output / amount / slippage / chain fee fields

GMGN Terminal
  -> 必要时获取链适配器要求的 gas 参数
  -> Quote（需要报价或用户明确要求时）
  -> Swap
  -> Order ID

Settlement Domain
  -> Query Order / RPC Receipt
  -> Position / Lot / Exit Strategy
```

### 必须保留的本地约束

- `chain + CA` 的地址格式和链注册表匹配；
- 钱包地址、原生币输入金额和滑点存在且可转换为 GMGN 参数；
- Signal 原子 Claim、唯一 ExecutionSession、唯一 Buy Attempt；
- Swap 提交前的幂等检查，防止同一 Signal 重复买入；
- Swap 后的 Order、Tx Hash、RPC Receipt 和本地仓位记录。

这些约束是 XBOT 的业务完整性约束，GMGN 不知道 Signal 是否重复，也不会替 XBOT 维护策略和仓位状态。

### 移出正常买入热路径的内容

- GMGN 预热；
- 启动或每次事件触发的 `user/info`；
- `token/pool_info`、市场 Rank、Hot Search、Trenches；
- 每次买入重复读取历史 Security、Pool、Gas 或完整 Token Snapshot；
- 固定 CA 重复合约验收；
- 将本地 USD 快照、旧缓存字段或非必要 Provider 字段作为 Swap 前硬门槛；
- 将 `security / quote` 再解释成一套与 GMGN 重复的本地交易决策。

运维诊断和研究功能可以保留，但必须显式调用、单独标记、经过同一个 GMGN Rate Gate，且不能在正常买入链路中自动触发。

### GMGN 调用规则

默认买入热路径只允许：

```text
条件：GET  /v1/trade/gas_price  （当前链适配器确实需要动态 Gas 时）
可选：GET  /v1/trade/quote      （需要报价、滑点确认或审计时）
必要：POST /v1/trade/swap
确认：GET  /v1/trade/query_order （订单状态不确定时）
```

`token/security` 不再是默认本地硬门槛。若启用安全检查，必须作为明确的策略选项，并明确它会增加一次 GMGN 请求；Security 字段缺失不能被本地擅自解释为 GMGN 拒绝。`token/info` 只用于结算或确实缺少 GMGN 必需参数时，不能因为缺少非交易字段阻断 Swap。

### 429 边界

本地 Rate Gate 只负责排队和限制并发，不负责决定代币是否可以买。单个 Signal 的执行会话独立计量；其他策略未触发时不得为它们预留或调用 GMGN。GMGN 返回 429 时保留 Signal 的可恢复状态，不重试 Swap，不把 Provider 等待伪装成本地策略失败。

### 风险取舍

移除 Security 和本地风险硬门槛会减少延迟和 GMGN 调用，但不会自动提高安全性；GMGN 的 Swap 接口是否拒绝某个高风险代币，不能等同于调用 Security 接口。P25 v1.2 选择“交易链路不被重复本地风控阻断”，安全检查由显式策略开关决定，不能同时宣称无门槛和完整安全保护。

## 2. 已验证的成交基线

### 2.1 固定 CA

数据库中 Signal `797` 是固定 CA `handle_match`：

- KOL：`@xueqiu88`
- Chain：Robinhood
- Buy Attempt：`121`
- 结果：`confirmed`
- 买入金额：`0.001`

这证明固定 CA 的正确基线是：

```text
配置好的 KOL -> 项目关系
  -> 6551 互动事件命中关系
  -> 已配置 chain + CA
  -> Signal
  -> GMGN 交易内核
```

固定 CA 不需要重新发现 CA，也不需要按事件重新验收白名单。

### 2.2 P20 动态策略

数据库中 Signal `804` 是 P20 `dynamic_keyword`：

- KOL：`@wanshenme`
- Chain：BSC
- Buy Attempt：`126`
- 结果：`confirmed`
- 买入金额：`0.01`

这证明 P20 的正确能力包括：

- 6551 帖子/评论事件进入动态策略；
- 从完整 CA、已批准名称、Cashtag/Hashtag 中解析候选；
- 使用 Candidate Index 处理同名、多链和项目别名；
- 确定唯一 `chain + CA` 后进入统一交易内核。

### 2.3 P21 关注发现

本次真实事件 `follow_discovery_events.id = 19`：

- `@xueqiu88 -> @tradeongtr`
- Grok/RPC 结果：`robinhood:0x684618c70480a70637692a51a3a9398dfd7ab0f5`
- Signal：`816`
- GMGN Quote：HTTP `200`
- 最终失败：本地 `USD_BUDGET_SNAPSHOT_REQUIRED`
- 未创建 Attempt，未调用 Swap

这证明 P21 的监听、研究、链/CA 识别、Signal 和 GMGN Quote 已经连通；当前失败不是 GMGN 429，也不是 CA 识别失败，而是 P24 删除价格源后留下的本地账本矛盾。

## 3. P24 回归审计

### 3.1 P20 Live 被切断本地 Candidate Index

当前代码在 Live 模式下：

- `event-worker.js` 把 `candidateIndex` 设为 `null`；
- `ca-resolver.js` 在 `fastLive` 时禁止 `lookupTerms()`；
- EVM 临时候选只有 `evmChains.length === 1` 才能创建；
- 对允许 Base/BSC/ETH/Robinhood 的正常策略，完整 EVM CA 被直接丢弃为 `DYNAMIC_CA_NOT_FOUND`。

真实 Job `13/14/15` 已复现该回归。

### 3.2 P24 把“禁止 GMGN 预热”错误扩大成“禁止本地索引”

Candidate Index 是 PostgreSQL 本地数据，不等于 GMGN 调用。正确边界应是：

- Live 可以读取本地 Candidate Index；
- Live Resolver 不得因为索引 miss 自动调用 GMGN；
- 当前事件包含完整 CA 时，索引用于确定已知链；
- 未知 EVM CA 使用允许链 RPC `eth_chainId + eth_getCode` 唯一解析；
- 同名/别名只允许使用当前策略明确授权且本地唯一、可审计的候选。

### 3.3 P24 删除价格源但保留硬账本约束

P24 将 `user/info`、`gas_price` 和原生币 `token/info` 从执行上下文移除，`chain_live_readiness.balances_json` 又没有 `usd_value`。因此 `nativeUsd = null`。

随后发生矛盾：

- `execution-service.evaluateRisk()` 把 `NATIVE_USD_PRICE_UNKNOWN` 降为 warning；
- `trade-repository.createBuyAttempt()` 仍要求 `plannedUsd > 0`；
- 同一笔交易最终以 `USD_BUDGET_SNAPSHOT_REQUIRED` 拒绝。

P25 v1.1 原本试图用 GMGN `gas-price` 的 `native_token_usd_price` 补齐本地 USD 账本，这仍然把非交易字段变成了 Swap 前门槛。P25 v1.2 取消 USD 快照作为默认买入条件；交易金额直接使用策略保存的原生币 raw amount，USD 估值只用于可观测性，不能阻断 Swap。

### 3.4 P24 的 Security 处理不符合最新官方字段

GMGN 官方 `token security` 的 `is_honeypot` 使用 `"yes" / "no"`。当前 Boolean Adapter 只识别 `true/false/1/0`，会把官方正常值解析为 `null`。

P25 v1.1 原本要求：

- 正确解析 `yes/no`；
- 每个已触发买入会话调用一次 `token/security`；
- `is_honeypot = yes` 硬拒绝；
- `rug_ratio > 0.3` 在自动策略中硬拒绝，不能由系统替用户二次确认；
- Security 响应或关键字段不可解析时硬失败，不静默继续。

P25 v1.2 调整为：上述规则只在策略显式开启安全检查时生效；默认快速买入路径不调用 `token/security`，不因为该接口字段缺失阻断 GMGN Swap。

### 3.5 P24 测试固化了错误行为

当前测试明确断言：

- P20 Live 不读取 Candidate Index；
- 多 EVM 策略中的完整 CA 返回 Not Found；
- 执行不调用 Security/Gas。

这些测试与真实业务目标、GitHub 成交基线及 GMGN 最新官方契约冲突。P25 将替换为能力测试，不再把实现细节误当业务标准。

## 4. 三策略触发标准

### 4.1 固定 CA

输入事实：

- KOL；
- 项目关系或 Direct Source Rule；
- 已配置的 Chain、CA、预算、滑点、退出策略。

触发标准：

1. 6551 actor 必须是启用的 KOL。
2. 事件类型必须在关系或 Source Rule 的 `event_types` 中。
3. 评论/转发/引用/关注必须命中明确的目标账号；推文 CA-only 规则必须命中配置 CA。
4. 相同事件、KOL、Chain、CA 只创建一个 Signal。
5. 不调用 Grok，不查询 Candidate Index，不重新判断链。

### 4.2 P20 动态策略

输入事实：

- 当前 6551 内容事件；
- Actor Policy 的事件类型、Term 类型、允许链和预算；
- 本地 Candidate Index；
- 链 RPC。

解析顺序：

1. Intent Gate。
2. 提取作者正文中的完整 CA、Approved Name、Cashtag、Hashtag。
3. 完整 Solana CA 按地址格式确定 Solana。
4. 完整 EVM CA 先查本地 Index 的唯一已知 Chain；未知时对允许 EVM 链做 RPC 合约代码解析。
5. Approved Name/Cashtag/Hashtag 只能命中本地唯一、策略授权且有完整 `chain + CA` 的候选；多候选继续返回 Ambiguous。
6. Resolver 阶段 GMGN 调用数必须为 0。
7. 得到唯一结果后原子创建一个 Signal。

### 4.3 P21 关注发现

输入事实：

- 当前 6551 Follow 事件；
- Grok 4.5 + x_search 的人物、项目、官方账号和 CA 证据；
- Chain Hint；
- 链 RPC。

解析顺序：

1. Follow 行为去重和 TTL。
2. Grok 研究目标账号、官方项目、创始人/CEO/核心成员关系。
3. 提取完整 CA 和 Chain 证据。
4. 用 RPC 验证合约存在及链身份；Grok Hint 与 RPC 冲突时拒绝，不猜链。
5. 研究阶段 GMGN 调用数必须为 0。
6. 物化本地候选、策略快照和唯一 Signal。

## 5. 统一 GMGN ExecutionSession 标准

### 5.1 所有权

只有 `LiveExecutionQueue` 原子 Claim 成功的 Signal 可以创建 ExecutionSession。以下模块没有 GMGN 交易调用权：

- 6551 Inbox；
- 固定 CA Matcher；
- P20 Resolver；
- P21 Grok Researcher；
- 页面查询；
- Readiness 普通读取；
- 白名单 Activation；
- 后台 Warmup/Trenches。

### 5.2 触发后的官方请求集合

一次新买入会话按链适配器和实际交易参数决定请求集合，不再固定预留所有 Provider 查询：

```text
条件：GET  /v1/trade/gas_price      weight 1（当前链适配器需要动态 Gas 时）
可选：GET  /v1/trade/quote          weight 2（需要报价确认或显式审计时）
必要：POST /v1/trade/swap           weight 5
确认：GET  /v1/trade/query_order    weight 1（按订单状态退避）
```

以下不进入默认买入热路径：

- `token/security`（只有显式开启安全检查的策略才调用）；
- `token/info`（只有 GMGN 必需参数或结算确实缺失时调用）；
- `user/info`；
- `token/pool_info`；
- 原生币 `token/info`；
- `market/rank`、`hot_searches`、`trenches`；
- `wallet_activity`；
- `strategy/orders`。

### 5.3 快照和硬校验

创建 Attempt 前只硬校验交易提交所需的最小数据：

- Signal 的确定 Chain + CA；
- 本地 Execution Profile 的钱包地址；
- 原生币输入金额、滑点和链适配器所需的 fee fields；
- 唯一 Signal / ExecutionSession / Buy Attempt 约束。

缺少 GMGN 非交易字段不得阻断 Swap；GMGN 返回的交易错误仍须原样记录。安全检查、Quote 和结算字段的缺失只在对应功能明确开启时阻断对应功能。

### 5.4 限流与重试

- 所有策略共享同一个 API Key/IP Scope 和全局 Rate Gate。
- 每个买入会话按实际请求集合预留权重，不再无条件按 `Security 1 + Gas 1 + Quote 2 + Token 1 + Swap 5 = 10` 预留；默认只预留 Swap 的 5 weight，BSC/Base 缺少本地 Gas 时再预留 1 weight。
- 内部速率维持低于官方上限，多个 Signal 串行/有界执行。
- GET 在 Provider 明确给出短 `X-RateLimit-Reset` 时可以受控等待；不得高频立即重试。
- Swap 写请求不自动重发。
- Swap 响应不确定时只允许 Query Order + RPC Receipt 对账。
- `RATE_LIMIT_BANNED` 必须遵守 Reset/Cooldown；冷却期间 Signal 保持可恢复状态，不能伪装成策略失败。

## 6. 禁止的降级方案

P25 明确禁止：

- 用 Paper/Mock 代替真实链路验收；
- EVM 地址默认归到 Base、BSC、ETH 或 Robinhood；
- RPC 不可用时让 Grok 猜链；
- 在显式开启安全检查的策略中，Security 请求失败后继续 Swap；
- 在显式开启安全检查的策略中，无法解析关键 Security 字段后继续 Swap；
- 用固定常数或 0 伪造原生币 USD 价格；
- 用旧缓存伪装本次官方 Security/Quote；
- 429 后循环重试或切换成未审计的直连请求；
- Swap 超时后再次提交同一笔买入；
- 实盘暂时暂停时把待执行 Signal 永久改成 `signal_only`；
- 通过降低测试门槛制造“测试通过”。

## 7. 代码边界

### 7.1 Trigger Domain

- `domains/signal/*`：固定 CA 关系匹配。
- `domains/dynamic-signal/*`：P20 内容解析、本地 Index、RPC 链解析。
- `domains/follow-discovery/*`：P21 Grok/x_search、关系证据、RPC 链验证。

输出统一为不可变的 Signal 身份：

```text
source_event_id + strategy_kind + policy_revision + chain + contract_address
```

### 7.2 Trade Domain

- Local Context：Chain Registry、钱包地址、交易参数和去重状态。
- Provider Context：仅包含当前 GMGN 请求实际需要的参数和响应。
- Authorization：Signal Claim、ExecutionSession、Attempt 幂等和显式实盘状态。
- Submission：唯一 Attempt、Swap、Order ID。
- Settlement：Query Order、RPC Receipt、Position、Lot、PnL。

Provider Context 不允许被 Trigger Domain 调用。

### 7.3 Provider Boundary

- 业务代码只能通过 `gmgn-access-service`。
- `gmgn-http` 只负责官方签名、HTTP、429 观察和事件审计。
- 每个请求必须带 `source/stage/signal_id/policy_id/whitelist_id/trace_id/execution_session_id/rate_scope`。

## 8. 实施清单

### P25-M1 P20 能力恢复

- Live 恢复纯本地 Candidate Index。
- 多 EVM 完整 CA 接入 RPC 唯一链解析。
- 删除“只允许一条 EVM 链”的错误测试。
- Approved Alias/Cashtag/Hashtag 只使用本地确定候选，不在 Resolver 调 GMGN。

### P25-M2 Provider Context 重建

- 新建清晰的 Triggered Provider Context Builder。
- 默认只构造 GMGN Swap 所需的链、钱包、金额、滑点和 fee fields。
- Gas 仅在链适配器需要动态 Gas 时读取；Quote 和 Token Info 改为显式可选。
- Security 改为显式策略选项，不再作为默认买入门槛；启用时修复 `yes/no` Boolean Schema 并按配置硬失败。
- USD 估值只记录，不再作为 Attempt 或 Swap 的硬条件。

### P25-M3 Rate Gate 和状态机

- Trade Reservation 按本次实际请求集合计算，不再无条件预留 10 weight；默认 5，BSC/Base 的 Gas + Swap 最大 6。
- 多 Signal 使用同一全局 Gate。
- 429 保持 Provider Wait，可在 TTL 内恢复。
- 未创建 Attempt 的 Provider 读取失败不产生重复 Swap 风险。

### P25-M4 三策略回归测试

- 固定 CA：复现 Signal `797` 的关系匹配与 Robinhood 执行参数。
- P20：复现 Signal `804` 的动态策略，并覆盖五链策略中的 EVM CA。
- P21：复现 Event `19` 的 Robinhood CA 到统一 ExecutionSession。
- 验证三个 Trigger Domain 在 Signal 前 GMGN 调用数均为 0。
- 验证每个 Signal 只有一个 ExecutionSession 和最多一个 Swap。

### P25-M5 UI 与运维可观测性

- Signals/History 显示策略类型、Chain、CA、ExecutionSession、最后 Stage 和精确错误码。
- Settings 显示当前实盘 Scope、持久化状态和 GMGN Cooldown。
- 页面读取不得触发 GMGN。

## 9. 验收标准

### 9.1 静态与自动化

- 后端全量单元测试通过。
- 数据库集成测试通过。
- 前端 Production Build 通过。
- DOM 测试覆盖 Settings、Strategies、Signals、History。
- 静态审计证明 Trigger/页面/启动无 GMGN 直连。

### 9.2 Provider 契约

- GMGN 签名与 `gmgn-cli 1.5.6` 一致。
- Quote/Swap/Order/Robinhood 参数符合官方字段。
- Swap 必需参数和各链 fee fields 均有契约测试；可选 Quote、Security、Token Info 单独测试，不得被误标为默认买入必需项。
- Security `yes/no`、Quote Raw Amount、Order Report Decimals 和 Gas 字段有契约测试；Gas USD 字段只作为可观测性数据。
- 运行审计可以按 Signal 聚合完整请求序列。

### 9.3 三笔真实验收

在用户明确启动实盘后，各执行一笔新的小额事件：

1. 固定 CA 关系事件。
2. P20 动态完整 CA 或明确 Approved Alias 事件。
3. P21 新关注事件。

每笔必须得到：

```text
6551 Event
-> Signal
-> ExecutionSession
-> Security 200
-> Gas 200
-> Quote 200
-> 单一 Swap
-> GMGN Order ID
-> Tx Hash
-> RPC Receipt
-> Position / Lot
```

只有三笔都得到真实 Order/Receipt，P25 才能标记为完成。自动化测试通过但未真实成交时，只能标记“代码完成，真实验收待执行”。

## 10. P25-GMGN 终端执行补充审核

本次审核确认：三个策略之前都能生成事件或 Signal，但最终买入都汇入 GMGN 终端执行阶段；因此修复重点必须放在统一交易会话，而不是继续修改三个 Trigger Domain。

### 10.1 唯一执行会话契约

每个被 Live Queue 原子 Claim 的 Signal 只能创建一个买入执行会话：

```text
one Signal
-> one execution_session_id = signal:<signal_id>
-> one rate lease = actual request weight (default 5, gas + swap max 6)
-> one Provider Context
-> at most one Swap
-> one Order settlement
```

固定 CA、P20 动态策略和 P21 关注发现都必须调用同一个 `executeAutomatic()`，不得保留策略专属 GMGN 买入路径。Trigger Domain 只能输出确定的 `chain + contract_address` 和不可变 Signal，不能读取 Security、Gas、Quote 或 Swap。

### 10.2 GMGN 终端调用白名单

一次新的买入会话按实际参数只允许以下调用：

```text
条件 GET  trade/gas_price  1 weight，当前链适配器需要时
可选 GET  trade/quote      2 weight，需要报价确认或显式审计时
必要 POST trade/swap       5 weight
确认 GET  trade/query_order 1 weight，订单状态不确定时
```

默认不调用 `token/security`、`token/info`、`user/info`、`token/pool_info`、`market/rank`、`hot_searches`、`trenches`、`wallet_activity`、`strategy/orders`。Readiness Probe 和显式研究可以保留为运维功能，但实盘 Armed 时研究队列必须暂停，Probe 必须显式标记并纳入审计。

### 10.3 并发与 429 边界

- Live Queue 在数据库 Claim 后串行提交 Signal；同一 Signal 的数据库唯一约束和 `signal:<id>` 会话 ID 防止重复 Swap。
- 本地 Rate Gate 与 PostgreSQL 共享 Rate Gate 使用同一 `rate_scope`，共享桶容量至少为完整交易会话的 6 weight。
- 任一 GMGN 429 都记录到 `signal_id/execution_session_id/stage/rate_scope`，进入 Provider Wait；不得立即重试，更不得重新提交 Swap。
- 研究、Readiness Probe、缓存和市场扫描不允许绕过共享 Rate Gate。
- 429 不能被测试代码改写为成功，也不能用旧缓存、固定价格或 Paper 结果替代真实交易证据。

## 11. P25 三策略真实小额验收测试

这是实盘验收，不是模拟测试。代码、服务、环境和 GMGN 测试 API 均准备完成后，由执行代理按顺序执行三笔新的小额买入，每笔之间等待上一笔完成 Order/Receipt 对账，避免三笔同时争抢同一个 GMGN 配额。

### 11.1 测试样本

从已验证历史 CA 中分别选择：

1. 固定 CA：历史已确认的 Robinhood 固定 CA。
2. P20：历史已确认的动态 CA，优先使用 Signal `804` 对应样本。
3. P21：历史关注发现样本，优先使用 Event `19` 对应 CA；若已过 TTL，则由新的关注事件重新生成 Signal，但仍使用已验证 CA 作为核对样本。

### 11.2 每笔通过条件

每笔必须在数据库和链上同时满足：

```text
6551 Event / P21 Follow Event
-> Signal status = recorded
-> Live Queue Claim = exactly once
-> execution_session_id = signal:<id>
-> 按链适配器需要时 Gas HTTP 200
-> 按策略选项需要时 Quote HTTP 200
-> Swap HTTP 200
-> provider_order_id present
-> transaction hash present
-> RPC receipt.status = 1
-> managed wallet token delta confirmed
-> Position and Position Lot created
```

任何已启用步骤失败都记录精确阶段和错误码，不能判定为测试通过。验收期间额外检查 Provider Audit：三笔 Signal 的实际请求均带完整来源，且没有 Signal 前 GMGN 请求、重复 ExecutionSession 或第二次 Swap。

### 11.3 P25 最终完成定义

必须同时满足以下条件才标记 P25 完成：

- 三策略各一笔真实小额交易均得到 Order ID、Tx Hash 和 RPC Receipt；
- 三笔交易都落库为 Position/Lot，金额与链上余额变化一致；
- Provider Audit 没有 Trigger、页面、启动、研究或 Probe 的未授权交易阶段调用；
- 429 期间没有自动重试 Swap，冷却后只恢复未提交 Signal；
- 后端全量测试、前端构建和 DOM 测试全部通过。

### 11.4 真实验收的固定参数和执行责任

自动验收阶段由执行代理构造隔离的 6551/Grok 触发结果并监控，资金执行仍严格经过正式 Signal、Live Queue、GMGN 和链上回执，未直接调用内部交易函数。自动触发脚本在三策略通过后删除；后续只允许用户通过真实 X 行为开展人工事件实测。

| 顺序 | 策略入口 | 真实触发 | 已核验样本 | 单笔上限 |
|---|---|---|---|---:|
| 1 | 固定 CA | `@xueqiu88` 对白名单 `878` 的目标账号执行一次新的 reply、quote、retweet 或 follow | Robinhood `0x30db03a051205ccbeb1b6524ddf87fbc6c0127bc` | `0.001` |
| 2 | P20 动态 | `@wanshenme` 发布或回复一条包含完整 CA 的新内容 | Robinhood `0x9ca1cc0c90d97b4f36c5e2232d4fbd705a73c65d` | `0.001` |
| 3 | P21 关注发现 | `@xueqiu88` 关注一个此前未关注、可重新关联到已核验 CA 的项目或核心人员账号 | 由本次 Grok/x_search + RPC 结果确定，并与历史已核验样本逐字核对 | `0.001` |

固定 CA 白名单 `878` 当前历史配置的 `budget_per_trade` 为 `0.1`，不符合“小额验收”的含义。执行第一笔前必须通过正式配置服务将本次单笔预算收紧为 `0.001`，等待 Activation 回到 `live_ready`，重新生成并确认 Engine Scope；不得直接修改数据库绕过配置审计。

三笔必须严格串行。上一笔未得到 `Order ID -> Tx Hash -> RPC Receipt -> Position/Lot` 前，不触发下一笔。每笔开始前记录 Provider Audit 基线时间和计数，完成后按该 Signal ID 核对：

```text
security = 0（默认）或 1（显式安全模式）
gas = 按链适配器需要时 0 或 1
quote = 按策略选项需要时 0 或 1
token_info = 仅必需或结算缺失时 0 或 1
swap = 1
execution_session_id = signal:<signal_id>
trace_id 非空
rate_scope = P22_GMGN_RATE_SCOPE
```

### 11.5 2026-08-11 终端执行复核补充

本轮在真实交易前额外发现并修复两个不会被普通成交状态直接暴露、但会破坏 P25 审计闭环的问题：

1. 共享限流器读取 `P22_GMGN_RATE_SCOPE`，交易请求上下文却读取不存在的 `P24_GMGN_RATE_SCOPE`，导致 Provider Audit 中 `rate_scope = null`。现统一通过 `scopeKey()` 解析，并仅保留旧键兼容。
2. `executeAutomatic()` 已生成新的 Execution Trace，但 Provider Context 和 Swap 仍可能读取历史 Signal 的空 `trace_id`。现将同一个 Trace 贯穿 `provider lease -> security/gas/quote/token_info -> swap`；历史 Signal 没有 Trace 时使用稳定的 `signal:<id>` 标识。

完成上述修复后，三笔真实交易已经全部满足 11.2，P25 状态正式改为“完成”。

### 11.6 真实验收结果与收口

| 策略 | Signal | Attempt / Order | Tx Hash | 结果 |
|---|---:|---|---|---|
| 固定 CA | `820` | `130 / 44` | `0x320802ccf9a2b7cd9691c6d62f6e74cfc7d28dc7ea28f09c92724a023c271eac` | Receipt、Position `567`、Lot 均确认 |
| P20 动态 | `821` | `131 / 45` | `0x5ded7cccfca9f535f3e76522a852ab40e272524de929d05258e59e6372aa9d64` | Receipt、Position `568`、Lot 均确认 |
| P21 关注发现 | `822` | `132 / 46` | `0x11f825eabad55bc5d53a3becbf23de833043df1dc32f50f77231147c6b4ddf41` | Receipt、Position `569`、Lot 均确认 |

- 三笔交易各只有一次 Swap，GMGN 请求均为 HTTP `200`，没有 `429`。
- 后端全量测试 `505/505`、前端构建和六个核心页面 DOM 测试通过。
- 自动构造三策略触发并真实下单的脚本及其专用测试已删除，避免误执行；只读成交证据核验工具继续保留。
