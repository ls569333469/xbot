# P23 三策略执行链路修订说明

> 状态：架构修订，待代码实施
>
> 范围：固定 CA、P20 动态喊单、P21 新关注发现
>
> 原则：保留 P20-P23 历史文档作为审计记录；本文件只定义当前实现与收敛后的目标链路。

## 1. 修订结论

当前系统把三种策略都接入了同一套 P19/P12 资金执行内核，但在进入该内核之前，动态和关注策略又复用了固定 CA 的白名单激活流程。结果是同一个事件被多个模块分别处理，造成：

- P21 研究阶段、白名单激活阶段和交易执行阶段重复访问 GMGN；
- 钱包、原生币和 Gas 等静态或可缓存数据被按事件重新读取；
- GMGN 429 冷却时间可能大于 Signal TTL，冷却结束后事件已经过期；
- P23 的内部限流和 readiness 已生效，但无法替代跨实例、跨 API Key/IP 的 Provider 配额治理。

目标不是为每个策略再创建一套交易代码，而是收敛为：

```text
策略触发 -> 策略专属解析/匹配 -> 本地授权快照
  -> 一个交易执行会话 -> Quote -> Swap
  -> Order/Receipt 对账 -> Position/Exit
```

每个策略只能有一个模块拥有该事件的 Provider 执行权。研究模块、Watch 模块、白名单模块不能各自触发交易请求。

## 2. 三个策略的当前实际链路

### 2.1 固定 CA 策略

```text
用户录入 CA、链、预算、滑点和退出模板
  -> 保存 ca_whitelist 与关系/Watch 配置
  -> Watch 同步
  -> whitelist activation outbox
  -> 钱包、RPC、GMGN 只读检查和 Quote
  -> live_ready
  -> 6551 事件进入 Inbox
  -> 固定 CA / 关系匹配
  -> trade_signal
  -> live-execution-queue
  -> execution-service
  -> Quote/风险检查/创建 Attempt
  -> Swap
  -> Order 查询、Receipt、Position、Exit
```

固定 CA 的激活是配置级动作，理论上只应发生在 CA、链、预算或策略模板变化时。它不应在每一条触发事件上重复执行。

### 2.2 P20 动态喊单策略

```text
6551 Tweet/Quote/Reply 事件
  -> dynamic event queue 去重
  -> 内容提取、作者归属和 intent gate
  -> 候选 CA / 项目解析
  -> Candidate Index 或 GMGN 候选验证
  -> dynamic target 物化为 ca_whitelist
  -> whitelist activation outbox
  -> activation Quote、Watch、RPC 和配置快照
  -> live_ready
  -> dynamic Signal
  -> live-execution-queue
  -> execution-service
  -> Quote/风险检查/Attempt/Swap
  -> Order/Receipt/Position/Exit
```

P20 的主要问题是：新候选被当成固定白名单配置处理，解析、激活和交易执行之间有重复 Provider 检查。Candidate Index 的验证快照应属于候选资产，而不是每次事件都重新激活。

### 2.3 P21 新关注发现策略

```text
6551 Follow 事件
  -> actor/target 去重、Baseline 和行为键
  -> Follow Discovery Worker
  -> Grok Responses API + x_search
  -> 目标项目/人员关系和 CA 证据提取
  -> P21 Resolver 调用 GMGN token/info、security、pool_info
  -> ca_whitelist 物化
  -> whitelist activation outbox
  -> activation user/wallet/RPC/GMGN 检查
  -> follow_discovery Signal
  -> live-execution-queue
  -> execution-service
  -> user/token/gas/wallet/quote 等 Context 请求
  -> Attempt/Swap
  -> Order/Receipt/Position/Exit
```

P21 当前链路最不合理：6551 只负责 Follow 事件是正确的，Grok 负责搜索 CA 也是正确的，但 CA 识别后的 GMGN 验证、白名单激活和执行 Context 被拆成了三次 Provider 访问。

## 3. 问题解决后的统一链路

### 3.1 固定 CA 目标链路

```text
用户保存 CA/链/预算/退出模板
  -> 本地保存固定授权快照
  -> 仅在配置变化时执行一次 Activation
  -> Watch 同步完成
  -> 6551 事件
  -> 本地固定 CA/关系匹配
  -> Signal
  -> Follow/Fix Execution Session
  -> 使用本地钱包配置、链配置和缓存
  -> GMGN Quote
  -> 风险与预算门禁
  -> GMGN Swap
  -> Order/Receipt/Position/Exit
```

固定 CA 已经是用户明确授权的资产，不再因为每条事件重复调用 GMGN Token Info、User Info 或 Activation Quote。

### 3.2 P20 动态喊单目标链路

```text
6551 内容事件
  -> 去重、作者归属、intent gate
  -> 从候选索引读取已验证资产
  -> 新 CA 只在首次成为候选时完成一次 Provider 验证并保存快照
  -> 本地策略预算和链授权
  -> Signal
  -> Dynamic Execution Session
  -> GMGN Quote
  -> 风险与预算门禁
  -> GMGN Swap
  -> Order/Receipt/Position/Exit
```

同一个 `chain + CA` 的后续喊单只复用候选快照和资产授权，不再次走白名单激活。候选快照过期时，更新候选资产本身；不能让交易事件重复触发整套解析和激活。

### 3.3 P21 新关注发现目标链路

```text
6551 Follow 事件
  -> actor/target 去重、Baseline、行为键
  -> Grok 4.5 + x_search 发现项目/人员关系和 CA
  -> 本地从证据摘录提取完整 CA，并校验链、关系和唯一性
  -> P21 Policy 生成一次不可变交易授权快照
  -> 不创建 Provider Activation 任务
  -> Signal
  -> Follow Execution Session 统一接管
  -> GMGN Quote
  -> 风险与预算门禁
  -> GMGN Swap
  -> Order/Receipt/Position/Exit
```

Grok 阶段不调用 GMGN，也不判断交易授权。GMGN 的地址、链和可交易性检查折叠到同一个执行会话中：Quote 是第一道 Provider 交易校验，Swap 是唯一写操作。

## 4. GMGN 调用边界

### 4.1 事件热路径允许的调用

| 策略 | 候选首次验证 | 触发交易 | 交易后 |
|---|---|---|---|
| 固定 CA | 配置变化时一次，可复用快照 | Quote -> Swap | Order/Receipt 对账 |
| P20 动态 | 新 `chain + CA` 首次出现时一次 | Quote -> Swap | Order/Receipt 对账 |
| P21 Follow | 不单独验证；由执行会话处理 | Quote -> Swap | Order/Receipt 对账 |

Quote 和 Swap 是两个不同的 GMGN HTTP 接口，但必须属于同一个执行会话、同一个 trace 和同一个 Provider 预算。不能由不同 Worker 分别重复发起。

### 4.2 事件热路径禁止的调用

- 6551 监听阶段调用 GMGN；
- Grok/x_search 阶段调用 GMGN；
- P21 每次事件调用白名单激活；
- 每次事件调用 `user/info` 获取固定钱包；
- 每次事件调用原生币 `token/info` 获取符号或精度；
- 每次事件调用 GMGN `gas_price`，Gas 应来自链 RPC、静态配置或受控短时缓存；
- Provider cooldown 期间发起低价值 readiness、activation 或 cache warmup 请求；
- 任何 Swap 已提交后的盲目重试。

### 4.3 安全检查模式

为了兼顾速度和风险，策略保留两个明确模式：

- **快速模式**：Grok/本地证据、Quote、预算门禁后 Swap；适用于用户明确接受更少 Provider 风险字段的测试。
- **完整检查模式**：首次候选额外读取 Security/Pool，并将结果保存为候选快照；后续触发复用快照，过期时更新候选，不在每条事件上重复激活。

模式必须属于策略配置快照的一部分，不能在 Worker 中隐式改变。

## 5. 兼容性和最小改动边界

1. 固定 CA、P20、P21 继续共享 P19/P12 的 Quote、Swap、Order、Receipt、Position、Exit 和资金一致性代码。
2. `ca_whitelist` 在第一阶段继续作为内部兼容授权记录，但 P20/P21 不再把它当作需要 Provider Activation 的固定 CA 配置。
3. 新增一个统一的 `ExecutionSession`/访问契约，负责一次事件的 Provider 预约、Quote、Swap 和 trace；不新增第二套交易引擎。
4. P21 Resolver 的返回值改为 `chain + CA + evidence + policy_snapshot`，不再返回“已完成 GMGN 交易资格验证”的隐式状态。
5. 交易执行只接受当前 Policy Revision、唯一 CA、有效授权快照和未过期事件；冷却超过事件 TTL 时明确放弃本次交易，不延迟买入旧事件。
6. 固定 CA 的历史 Position、Order、Receipt、预算和退出策略不迁移、不重放、不回写。

## 6. 验收标准

### 固定 CA

- 配置未变化时，连续触发不会重复 Activation；
- 每次新交易只有 Quote、Swap 和交易后对账请求；
- 固定 CA 的预算、止盈止损、平仓和持仓链路不变。

### P20 动态

- 同一 CA 首次候选验证一次，后续事件只复用快照；
- 不因每条事件重新创建 Activation Quote；
- Record/Paper 不调用 Swap，Live 才进入 Quote/Swap。

### P21 Follow

- 6551 只产生 Follow Event；
- Grok 使用 x_search 找 CA，Grok 阶段 GMGN 调用数为 `0`；
- P21 事件不产生 Activation GMGN 请求；
- 一次 Live 事件的 GMGN 调用按快速模式最多为 `Quote + Swap`，完整检查模式的额外读请求必须有明确审计记录；
- 429 冷却期间不重复发起低价值请求；
- 冷却结束但事件已过期时，Signal 明确 `expired`，不买入旧事件；
- 任意事件只能创建一个 Signal、一个 Trade Intent 和一个 Attempt。

### 全局

- 本地、服务器和其他 Worker 的 API Key、出口 IP 与 `P22_GMGN_RATE_SCOPE` 边界可审计；
- Provider 请求审计必须显示 `source`、`process_role`、`policy_id`、`whitelist_id`、`signal_id` 和 `trace_id`；
- 固定 CA、P20、P21 的资金执行最终都进入同一 P19/P12 状态机。

## 7. 后续实施顺序

1. 先补齐统一 `ExecutionSession` 的调用契约和 P21 无 Activation 路径；
2. 再将 P20 候选验证快照与交易授权解耦；
3. 最后把固定 CA 的 Activation 调整为配置级动作，并补充三策略 GMGN 调用计数测试；
4. 在专用测试库完成 Record/Paper/Mock 429 回归后，才允许新的单次小额 Live 验收。
