# P12 交易可靠性、架构治理与 Robinhood 接入统一迭代方案

> 编制日期：2026-07-23
> 复核日期：2026-07-23
> 归档状态：P12 资金状态机和 Robinhood 接入设计证据；2026-07-24 起未完成验收与发布工作由 [P14](./P14_p13_acceptance_robinhood_live_and_release_closure_plan.md) 接管，本文件不再作为 Active Plan
> 当前状态：P12-A/P12-B 核心代码与前端已实现；后端单元测试 146/146、数据库集成测试 21/21、独立测试库 Migration 013 历史回填演练和前端 lint/build 已通过；生产 Migration、四链更新后真实回归、生产观测和 Robinhood 真实闭环尚未验收
> 适用链：Solana、BNB Smart Chain、Base、Ethereum；Robinhood 按独立门禁接入
> 核心原则：真实资金写请求只提交一次；只有上一笔已经证明“明确失败且未成交”，才允许创建下一次真实提交

---

## 一、目标、工作流与边界

P12 不再只是一份“四链重试方案”，而是接下来唯一的执行总纲，统一收敛三个尚未完成的需求和一个稳定收尾阶段：

| 工作流 | 目标 | 为什么按此顺序 |
|---|---|---|
| P12-A 架构与文档治理 | 固定生产链路、建立最小 Chain Manifest/Provider 边界、清理状态冲突 | 先消除第五条链继续复制条件分支的风险，但不把大规模重构和资金状态机混在一起 |
| P12-B 明确失败重试 | 为现有四链实现 Trade Intent、多 Attempt、失败证据和安全重试 | Robinhood 必须复用这套交易内核，不能另建一套重试逻辑 |
| P12-C Robinhood 接入 | 在 GMGN + Robinhood EVM 上完成配置、Quote、Swap、Receipt、策略和平仓闭环 | 只在公共内核稳定后增加 Chain Manifest 和链级参数 |
| P12-D 稳定运行与受控清理 | 生产观测、行为等价拆分大模块、清理已证明不可达的 legacy | 只在真实回归通过后收结构债，避免同时改变资金语义和文件结构 |

P12-B 要解决的不是普通 HTTP 重试，而是热门项目拥堵时真实 Swap 首次失败后的安全续单。P12-C 负责把 Robinhood 作为 GMGN Provider 下的第五条链接入，不把它错误建模成独立交易 Provider。

目标：

1. SOL、BSC、Base、ETH 的真实买入和真实平仓都支持“明确失败后重试”。
2. 网络超时、5xx、非 JSON、缺少 `order_id` 等不确定结果绝不自动重发。
3. 一个逻辑交易可以包含多条物理 Attempt，但本金预算、白名单买入次数和持仓只结算一次。
4. 多个 KOL 同时命中同一个 `chain + wallet + CA` 时，只允许一个活动买入意图。
5. 每次重试重新获取 Quote、Gas 和余额，但只读请求本身不能触发 Swap。
6. 所有链共享同一状态机，链上失败证据和费用升级使用各自 Chain Manifest/Adapter。
7. 前端与后端读取同一份链级重试配置，并展示每一次真实提交和失败证据。
8. Robinhood UI 保留并完善；Binance 只作为未来已上币现货 Provider，不作为 Robinhood CA 的备用路由。
9. 任一资金提交状态不确定时，冻结同链同钱包的新买入写入，而不是只锁定当前 CA。
10. 任一已提交 Attempt 的晚到成交都必须被恢复和结算，即使 Intent 已标记为 `cancelled/exhausted/rejected`。

P12 不做：

- 不给 `POST /v1/trade/swap` 增加 HTTP 层自动 retry。
- 不在超时后猜测未成交并重新下单。
- 不把 Paper、Shadow 或构造订单当作真实链验收证据。
- 不故意制造一笔状态不确定的真实交易来测试重试。
- 不在 P12-A/B 阶段直接开放 Robinhood 实盘；P12-C 必须按只读、最小真实买入、真实平仓逐级解锁。
- 不为 Robinhood 复制 `execution-service`、`close-service`、预算或 Reconciler。
- 不因某个 Robinhood CA 无法 Quote 就自动改走 Binance。

---

## 二、2026-07-23 真实状态基线

本次重新直接核对生产数据库得到：

| 链 | confirmed Buy | confirmed Sell | confirmed Receipt | Live Position | 当前结论 |
|---|---:|---:|---:|---:|---|
| SOL | 4 | 4 | 8 | closed 4 | 已完成四次真实买卖闭环；另有 2 条 rejected Sell Attempt，无资金订单 |
| BSC | 2 | 2 | 4 | closed 2 | 已完成两次真实买卖闭环 |
| Base | 1 | 1 | 2 | closed 1 | 已完成真实买卖闭环 |
| ETH | 1 | 1 | 2 | closed 1 | 已完成真实买卖闭环 |
| Robinhood | 0 | 0 | 0 | 0 | GMGN 只读契约已通过，尚未充值和真实交易 |

同时确认：

- 四链全部真实 Position 均为 `closed`，当前没有未平仓 Live Position。
- 四链 Buy/Sell Order 与 Receipt 数量一致，全部为 `confirmed`。
- `chain_readiness_evidence` 仍只有 `contract_probe`，没有从真实闭环自动生成的 `manual_e2e` 证据；这是 P12-A/B 必须补齐的事实治理缺口。
- 当前 `live_policy` 是运行时策略快照，不代表五链长期启用状态；方案文档不得再用某一次快照推导永久能力。
- Robinhood GMGN 钱包、Gas Price、Trenches、Token、Security、Pool、Quote 和 Strategy List 已实测成功；官方 RPC 返回主网 `chainId=4663`。
- Robinhood GMGN 钱包当前链上余额为 `0 ETH`，任何真实 Swap 前都必须先充值并重新核对余额。
- Robinhood 当前数据库配置仍错误写为 `USD / 2 decimals / CEX`，且后端门禁只允许原四链，现阶段无法实盘。

因此，原 P12 中“Base 尚未平仓、ETH 尚未测试”的结论已经失效；本节是后续实施使用的新基线。

---

## 三、代码审计结论

### 3.1 当前具备的能力

1. `execution-service.js` 和 `close-service.js` 对每次买入或卖出只调用一次 GMGN Swap。
2. Swap 返回 `order_id` 后，`reconciliation-service.js` 按 GMGN Order 和链上 Receipt 持续确认。
3. EVM 已具备 Tx Hash 替换恢复逻辑，SOL 与 EVM 都能读取真实 Receipt。
4. 当前幂等键能够阻止同一 Signal 或同一 Prepare Token 被直接重复提交。
5. 当前预算在提交前预留，确认后提交，失败后释放。
6. 当前 429 调度器会进入冷却，不会在限流期间持续轰炸 GMGN。

### 3.2 当前不能直接增加重试的原因

1. 买入幂等键固定为 `signal:<signal_id>:buy`，一个 Signal 无法合法创建第二条 Attempt。
2. 卖出幂等键绑定单个 Prepare Token，同一平仓意图也没有 Attempt 序号。
3. `failOrder()` 看到 GMGN `failed/expired` 后立即释放预算并结束 Signal，没有链上“未成交”验证步骤。
4. 当前所有 GMGN HTTP 4xx 都被归为明确写入拒绝，分类粒度不足。
5. `submission_uncertain` 虽会调用 Wallet Activity，但查询结果尚未自动匹配到具体交易。
6. 预算预留绑定 `attempt_id`，直接复制 Attempt 会重复占用本金预算。
7. 当前 BSC/Base Gas 优先读取 `average`，没有按 Attempt 升档。
8. 当前 ETH 只使用固定 `gas_level`，没有重试费用上限和升级审计。
9. `consecutive_failure_lock` 存在配置，但尚未接入新的实盘 Attempt 状态机。
10. GMGN 请求里的随机 `client_id` 是鉴权防重放字段，不是 Swap 幂等键，不能依靠它防止重复成交。
11. 当前不确定状态主要锁定 Signal/CA，没有同链同钱包的资金写入队列；其他 CA 仍可能改变 nonce 和余额，使失败证据无法唯一解释。
12. 当前 Attempt 没有不可变的提交前 nonce/slot、区块、精确余额、Quote 和配置版本快照，无法可靠证明“无 Hash 且未成交”。
13. 当前没有统一定义已取消或已耗尽 Intent 的晚到成交恢复规则，旧 Attempt 可能在业务终态后继续链上确认。

### 3.3 架构与文件管理审计

依据《XBOT 系统架构与交易链路图》反查实际代码，当前存在以下管理问题：

1. 链能力分散在 `lib/chain-config.js`、`chain-adapters/index.js`、`config/service.js`、Readiness、Receipt 和前端类型中，新增链需要修改多组常量，容易遗漏。
2. `chain-config.js` 的 Robinhood 仍是早期券商/CEX 占位，与当前 Robinhood EVM L2 事实冲突。
3. `trade-repository.js` 已超过 2200 行，订单、预算、仓位、策略、证据和历史回填职责混合；P12 继续直接堆入 Intent 会进一步失控。
4. `SettingsPage.tsx` 已超过 1300 行，环境变量、实盘门禁、链预算、Provider 状态和密钥操作混在单页组件。
5. `ENGINEERING_LOG.md`、P1/P4/P5 与 P9-P11 同时描述“当前状态”，其中仍保留旧路径、Mock、SocialData 和“实盘冻结”等历史结论，缺少 Active/History 边界。
6. 根目录没有项目 README，`frontend/README.md` 仍是 Vite 模板，无法作为真实启动和架构入口。
7. `cron.json` 中所有旧轮询/模拟 Job 均禁用，但对应文件仍与生产代码平级；必须先做调用可达性分类，再决定归档或删除。
8. 多个源码文件仍有 `D:\AI_Projects\xbot` 旧绝对路径注释，容易误导维护者，但不能与交易状态机更新混在同一提交中机械清理。
9. PEM、`.env` 已被 `.gitignore` 正确排除；后续重构不得改变这一安全边界，也不得在测试快照中写入密钥或钱包完整输出。

P12-A 只做可验证的最小边界收敛，不进行大规模 Repository/Page 搬迁、无关重命名或全仓格式化。Intent 使用独立新模块并由现有 facade 接入；完整拆分推迟到 P12-D，避免结构重构与资金状态机同时扩大回归面。

### 3.4 Robinhood 实测审计

已完成且不涉及资金写入的证据：

1. Robinhood 官方网络：Arbitrum EVM L2、`chainId=4663`、Gas 币 `ETH`、18 位精度。
2. GMGN `/v1/user/info` 返回唯一 `robinhood` 钱包。
3. GMGN `/v1/trade/gas_price?chain=robinhood` 返回有效区块和 Gas 档位。
4. GMGN `/v1/trenches` 返回 Robinhood 的 Bankr、Virtuals 和 Uniswap V3/V4 等市场数据。
5. 已毕业池和 `new_creation` 代币均能完成 Token/Pool/Quote 只读调用。
6. GMGN Strategy open/history 查询支持 `robinhood` 并正常返回。

尚未完成：Swap 写入、Query Order、Robinhood RPC Receipt、Token Delta、保护策略创建/触发、真实卖出和 PnL。截图中的 Noxa.fun、Flap、Trench、Bow.fun、Pons 等平台也不能只凭 UI 标签宣布全部可交易，应持续用代表 CA 建立 Quote 能力矩阵；但该矩阵不是整条 Robinhood 链的全局硬门禁，链级首轮验收只要求一个已毕业高流动性 CA 和一个 `new_creation` CA 通过只读契约，每笔真实交易仍以目标 CA 的实时 Quote 为最终门禁。

---

## 四、不可违反的安全规则

### 4.1 查询重试与资金重试必须分离

下列只读请求可以由限流调度器重试：

- `GET /v1/trade/quote`
- `GET /v1/trade/query_order`
- `GET /v1/trade/gas_price`
- Wallet Activity、Token Balance、RPC Receipt

只读请求只用于获取参数和证明状态，不得直接增加真实下单次数。

下列资金写请求禁止在 HTTP Client 内自动重试：

- Swap Buy
- Swap Sell/Close
- Strategy Create
- Strategy Cancel

Swap 的下一次提交只能由 P12 Retry Orchestrator 在数据库状态机允许后创建。

### 4.2 宁可错过，不可重复买入

以下任一情况存在时，系统必须进入 `submission_uncertain`，并锁定对应交易范围：

- 请求超时或网络中断。
- HTTP 500/502/503。
- 响应不是合法 JSON。
- Swap 响应没有可靠 `order_id`。
- GMGN 状态与链上状态冲突。
- Tx Hash 在当前 RPC 暂时查不到。
- EVM 交易可能被替换，但尚未找到替换 Hash。
- Wallet Activity、Token Balance 或 Receipt 无法唯一匹配本次交易。

`submission_uncertain` 永远不自动创建下一条 Swap。

### 4.3 Wallet Write Lane 与 Wallet Quarantine

`scope_key` 负责去重业务意图，不能代替钱包资金写入隔离。新增数据库持久化的 Wallet Write Lane：

```text
wallet_lane:<chain>:<wallet_address>
```

规则：

1. 同链同钱包的 Swap、Strategy Create/Cancel 必须先取得该 Lane；资金写请求按 Lane 串行提交。
2. 任一 Attempt 处于 `submission_uncertain` 或 `reconciliation_required` 时，该 Lane 进入 `wallet_quarantine`。
3. Quarantine 期间暂停该钱包所有 CA 的新 Buy 和 Buy Retry；不得用另一个 CA 的余额变化证明原 Attempt 未成交。
4. 已提交的 Sell/Strategy Attempt 继续对账，但不得自动创建下一 Attempt。
5. 已有仓位退出默认也受 Quarantine 阻断；只有经过显式的 Exit Lane Override，重新核验 EVM pending nonce/SOL 签名游标、精确余额和未决 Attempt 后，才允许创建一条有完整关联审计的退出提交。
6. 只有 Reconciler 形成确定结论，或管理员执行带原因、证据和身份记录的人工解除，才可释放 Quarantine；进程重启不能自动释放。
7. Quarantine 是钱包级状态，链级熔断是链级状态，两者独立展示和审计。

### 4.4 429 不是交易失败重试信号

GMGN Swap 权重为 5，Quote 权重为 2，Order Query 和 Gas Price 权重为 1。所有重试都必须经过现有 Rate Scheduler。

遇到以下错误时停止该 Intent 的自动重试：

- `RATE_LIMIT_EXCEEDED`
- `RATE_LIMIT_BANNED`
- `ERROR_RATE_LIMIT_BLOCKED`
- 任意 HTTP 429

系统等待 `X-RateLimit-Reset/reset_at`，但不会在冷却结束后自动补发已经过期的 Swap。

---

## 五、统一 Trade Intent 状态机

### 5.1 逻辑交易与物理提交分离

新增 `trade_intents`：一条记录代表用户真正想完成的一次买入或平仓。

一条 Intent 可以拥有：

```text
Intent #1001
  Attempt #1 -> definitive_failed_no_fill
  Attempt #2 -> definitive_failed_no_fill
  Attempt #3 -> confirmed
```

“最多重试 2 次”明确表示：

```text
首次提交 1 次 + 失败后最多重试 2 次 = 最多 3 次真实 Swap
```

### 5.2 Intent 状态

```text
created
  -> submitting
  -> awaiting_result
  -> retry_verifying
  -> retry_scheduled
  -> confirmed
  -> exhausted
  -> rejected
  -> uncertain
  -> cancelled
```

规则：

- `confirmed`：任一 Attempt 已真实成交，Intent 永久结束。
- `retry_scheduled`：上一 Attempt 已有完整未成交证据，且仍在重试窗口内。
- `exhausted`：重试次数用完或重试窗口过期。
- `rejected`：鉴权、余额、参数、钱包等不可重试错误。
- `uncertain`：无法证明成功或失败，锁定并持续对账。
- `cancelled`：买入重试等待期间用户停止 Engine、关闭链或触发紧急停止；只表示禁止创建新 Attempt，不表示已提交 Attempt 确定未成交。

`cancelled`、`exhausted` 和 `rejected` 都只是“不再创建新 Attempt”的业务终态，不是 Reconciler 终态。任一已提交 Attempt 后续出现可信 `confirmed` 时，晚到成交优先于上述状态：系统必须原子恢复 Intent 为 `confirmed`，补记预算、Position/Lot、Receipt 和白名单计数，发布高优先级告警，并保留原终态到恢复状态的追加式审计记录。只要存在已提交 Attempt，Reconciler 就不能因为 Intent 已进入业务终态而停止查询。

若一个 Intent 已有其他 confirmed Attempt，旧 Attempt 又晚到 confirmed，则进入 `multiple_fill_incident`：保留并结算每一笔真实 Receipt、Token Delta、Gas 和 Lot，不得把多笔真实成交折叠成一笔，也不得自动反向交易“纠正”。系统立即冻结同链同钱包、记录预算超额/仓位差额并发出最高优先级告警，等待明确的处置决策。晚到成交结算不能因 Principal Reserve 已释放或当前预算不足而失败；应先按链上事实落账，再记录 `budget_reconciliation_deficit`。

### 5.3 Attempt 状态

在现有状态基础上增加：

```text
definitive_failed_no_fill
retry_blocked
superseded
```

每条 Attempt 必须保存：

- `intent_id`
- `attempt_no`
- `retry_of_attempt_id`
- `failure_class`
- `failure_evidence_json`
- `retry_eligible`
- `retry_decided_at`
- 不可变的提交前快照：Quote ID/响应哈希、input/min output、Token/Native 精确余额、EVM pending/latest nonce 或 Solana slot/signature 游标、区块号、Gas 参数、Chain Config/Live Policy/代码版本
- GMGN Order ID、Tx Hash、Receipt 和 Wallet Activity 匹配结果

`superseded` 只能用于尚未调用资金写 API 的预提交 Attempt 或从未提交的失效调度任务。一旦进入 Swap/Strategy 调用边界，即使没有拿到 `order_id/tx_hash`，也必须保留真实的 submitted/uncertain 状态，禁止用 `superseded` 掩盖。

### 5.4 来源唯一键与活动范围锁

每个 Intent 增加稳定的 `source_key`：

```text
buy:signal:<signal_id>
sell:position:<position_id>:close:<close_generation>
```

- 数据库使用 `UNIQUE(source_key)`，不能只依赖应用层检查。
- 同一 Position 的重复平仓点击必须恢复原活动 Sell Intent；只有上一轮平仓已形成可解释终态且确实需要新一轮关闭剩余仓位时，才增加 `close_generation`。
- Buy 活动 `scope_key` 为 `buy:<chain>:<wallet>:<normalized_ca>`，Sell 活动 `scope_key` 为 `sell:<position_id>`。
- `scope_key` 使用只覆盖活动状态的 partial unique index，历史 Intent 可以保留相同 scope。
- `(intent_id, attempt_no)` 继续作为物理提交唯一键；`source_key`、`scope_key`、Wallet Write Lane 分别解决来源重复、活动业务冲突和钱包资金并发，三者不能互相替代。

幂等键改为：

```text
intent:<intent_id>:attempt:<attempt_no>
```

数据库唯一约束 `(intent_id, attempt_no)` 保证进程重启或双进程并发时，同一次重试只能创建一条 Attempt。

---

## 六、明确失败判定

### 6.1 可以进入自动重试

必须满足“GMGN 终态”和“链上未成交证据”，不能只看一条错误消息。

#### 情况 A：存在 Tx Hash

同时满足：

1. GMGN Order 为 `failed/expired`，或 GMGN 已返回对应失败信息。
2. Receipt 来自正确链、正确钱包和正确 Tx Hash。
3. EVM `receipt.status=0`，或 Solana `transaction.meta.err` 非空。
4. Receipt 中没有成功的目标 Token 到账或卖出扣减。
5. 对应输入本金没有被成功交换；失败交易实际 Gas 单独记账。

可标记为 `definitive_failed_no_fill`。

#### 情况 B：GMGN 终态但没有 Tx Hash

同时满足：

1. 提交前不可变快照已记录：EVM `pending/latest nonce` 或 Solana slot/signature 游标、原生币与目标 Token 精确余额、区块号、Quote 和 Activity 查询游标。
2. 同一 `order_id` 在固定证据观察窗口内持续保持 `failed/expired`；“连续两次查询”只能作为辅助条件，不能替代时间窗口。
3. 观察窗口结束后，EVM pending/latest nonce 未出现无法解释的推进；Solana 从提交前 slot/signature 游标开始没有无法解释的新签名。
4. EVM RPC 区块扫描或可信 Indexer/Explorer 的地址交易历史，以及 Solana 签名扫描，均没有发现原交易、替换交易或同等资金变化；不得假设标准 EVM RPC 原生支持按地址查询历史。
5. 没有与该 Attempt 唯一匹配的 Wallet Activity，GMGN 也没有返回替换 Tx Hash。
6. 目标 Token 精确余额没有增加；卖出时输入 Token 精确余额没有减少；原生币变化也能由已知 Gas 或其他已审计交易完整解释。
7. 已经过该链配置的固定证据观察窗口，窗口起止使用数据库时间记录。

证据齐全后才能标记为 `definitive_failed_no_fill`；nonce、余额、Activity、地址交易历史或时间窗口任一缺失、冲突或不能唯一解释，都进入 `uncertain` 并触发 Wallet Quarantine。失败判断只能引用该 Attempt 的不可变提交前快照，禁止用当前配置或当前余额倒推过去状态。

### 6.2 明确拒绝但不自动重试

以下错误说明请求无法按当前参数执行，应直接结束或等待用户修复：

- API Key、签名、时间戳或 IP 白名单错误。
- GMGN Wallet 与 `from_address` 不匹配。
- 参数错误或链不支持。
- 原生币或 Token 余额不足。
- 白名单、预算、持仓数、亏损限制或 Gas Reserve 不满足。
- 429 和错误计数封禁。

第一版不对裸 HTTP 4xx 设置自动重试白名单。后续只有获得 GMGN 官方明确语义并有测试样本后，才允许按具体 `error_code` 增加。

### 6.3 永远不重试的不确定状态

| 现象 | 状态 | 动作 |
|---|---|---|
| Swap 超时 | `uncertain` | 锁定并对账，不重发 |
| 500/502/503 | `uncertain` | 锁定并对账，不重发 |
| 非 JSON 或缺少 Order ID | `uncertain` | 锁定并对账，不重发 |
| GMGN confirmed、RPC 未确认 | `awaiting_result` | 继续查 Receipt |
| RPC confirmed、GMGN 未知 | `uncertain` | 保存链上证据并人工复核 |
| EVM Hash dropped、replacement 未排除 | `uncertain` | 查询 nonce、GMGN Order 和替换 Hash |
| 余额变化但无法唯一匹配 | `uncertain` | 禁止重试 |

---

## 七、买入重试流程

1. 新 Signal 按 `buy:signal:<signal_id>` 创建唯一 Buy Intent，并锁定 `chain + wallet + normalized CA`。
2. Intent 只预留一次本金，同时按“首次提交 + 最大重试次数”预留 Retry Fee Envelope。
3. Attempt 1 获取 Quote、余额和费用参数后提交一次 Swap。
4. 有 `order_id/tx_hash` 后只进入 Order 和 Receipt 对账，不创建新 Attempt。
5. 上一 Attempt 被证明为 `definitive_failed_no_fill` 后，Retry Orchestrator 才能创建下一条 Attempt。
6. 重试前强制刷新 Quote、Gas、原生币余额和目标 Token 余额，不能复用 5-10 秒缓存中的旧 Quote/Gas。
7. 重试沿用原 Intent 的本金和白名单滑点上限，不因失败自动增加买入金额或突破滑点。
8. 当前预算、链开关、Engine、Emergency Stop 或信号时效任一不通过，只取消后续买入 Attempt；所有已提交 Attempt 继续对账并接受晚到成交恢复。
9. 任一 Attempt confirmed 后，其他调度任务全部失效，只创建一个 Position/Lot，并且白名单买入次数只增加一次。
10. 同 CA 的其他 KOL Signal 在 Intent 活动期间只记录为“重复触发已合并”，不创建第二个 Buy Intent。
11. 提交前必须取得 Wallet Write Lane；同钱包任一 CA 存在不确定资金写入时，新 Buy 和 Buy Retry 全部暂停。

---

## 八、平仓重试流程

平仓比买入更敏感，因为策略可能已经取消，且可能出现部分卖出。

1. 用户点击平仓后按 `sell:position:<position_id>:close:<close_generation>` 创建唯一 Sell Intent，并按 `position_id` 加锁；重复点击恢复原 Intent。
2. 首次 Attempt 先取消并核验 TP/SL Strategy，再提交 Sell Swap。
3. 如果 Sell 明确失败且 Token 未减少，创建下一次 Sell Attempt。
4. 重试时不重复盲目取消 Strategy；先读取 Strategy 状态，已取消则直接继续，仍活动才执行受控取消和读回核验。
5. 每次重试重新读取 Lot Remaining 和钱包 Token Balance，卖出量取两者较小值。
6. 如果发生部分卖出、外部卖出、Strategy 同时触发或余额不一致，进入 `close_uncertain`，禁止按原数量重试。
7. 即使 Engine 已停止新买入，已有 Sell Intent 仍允许完成明确失败后的退出重试。
8. 重试耗尽后仓位标记 `open_unprotected` 并发出高优先级告警，不能伪装成已平仓。
9. 同钱包处于 Quarantine 时，不得自动新建 Sell Attempt；Exit Lane Override 必须显式记录它与未决 Attempt 的 nonce/slot、余额和人工授权关系。

Strategy Create/Cancel 不复用 Swap 的重试次数。它们继续采用“写一次、读回验证、状态不确定则停止”的独立状态机，防止重复创建保护单。

---

## 九、链级费用与失败证据策略

| 链 | 明确链上失败 | 重试费用升级 | 保护要求 |
|---|---|---|---|
| SOL | `transaction.meta.err`；或 GMGN `expired` 无 Hash且余额/Activity 均无变化 | 刷新 blockhash/Quote；按 Attempt 提高 `priority_fee`、`tip_fee`，受绝对上限约束 | `anti-MEV=true` |
| BSC | 正确 Hash 的 EVM Receipt `status=0`；无 Hash 时使用 GMGN 双终态和余额证据 | `average -> high`，必要时使用显式 Gas/EIP-1559 参数，受 Gwei 上限约束 | `anti-MEV=true` |
| Base | 与 BSC 相同，并排除 replacement | 刷新 provider high Gas，受 Gwei 上限约束 | 不发送 Base 不支持的 anti-MEV 字段 |
| ETH | Receipt `status=0`，并完成 nonce/replacement 核验 | `average -> high` 或显式 EIP-1559 上限；不得同时发送互斥的 `gas_level` 与 `gas_price` | `anti-MEV=true` |
| Robinhood | EVM Receipt `status=0`，并完成 nonce/replacement 核验 | 只有完成真实 Contract Test 后才能定义升级字段；首单不得猜测复用 ETH/Base 的链限定参数 | GMGN 文档未完整定义 Fee/anti-MEV 组合，未验证前保持重试关闭 |

统一限制：

- 费用升级不能绕过用户在前端配置的绝对上限。
- 费用达到上限仍无法重试时，Intent 进入 `exhausted`，不能偷偷使用更高费用。
- Slippage 使用白名单当前值或 Intent 快照中的更小值，不跟随重试次数自动增加。
- 首次失败实际消耗的链上 Gas 计入费用 Ledger，但本金预留继续供下一 Attempt 使用。
- Principal Reserve 只预留一次；Retry Fee Envelope 按 `首次提交 + max_retries` 的最坏费用绝对上限预留，二者必须分账。
- 每条 Attempt 记录估算费用、实际 Gas 和差额；Intent confirmed/exhausted/cancelled 后释放未使用的 Fee Envelope，但已提交 Attempt 未完成对账前不得释放。
- Daily/Weekly Limit 同时计入成交本金和所有已发生的失败 Gas，不能因为交易未成交就忽略链上费用。
- 已有仓位退出不受买入本金预算阻断，但必须保有独立的 Exit Gas Reserve；Exit Gas 不得被新买入耗尽。

---

## 十、重试时间与 GMGN 限流

建议初始值：

| 链 | 最大重试次数 | 明确失败后的调度延迟 | Intent 重试窗口 |
|---|---:|---|---:|
| SOL | 2 | 250ms、500ms | 8 秒 |
| BSC | 2 | 250ms、500ms | 10 秒 |
| Base | 2 | 250ms、500ms | 12 秒 |
| ETH | 2 | 500ms、1000ms | 30 秒 |
| Robinhood | 0（初始） | 不调度 | 30 秒配置占位；完成正常 Buy/Close 后再启用 0-2 次 |

解释：

- 延迟从“明确失败证据完成”后开始，不是从第一次请求超时后开始。
- 无 Hash 的固定证据观察窗口独立于 `250ms/500ms` 调度延迟，通常更长；观察窗口未结束前绝不创建下一 Attempt。
- `250ms/500ms` 是最早调度时间，不代表绕过 Rate Scheduler。
- Quote、Gas、Order Query 和 Swap 的权重统一由 Scheduler 排队，宁可晚一点也不能触发 429。
- 买入 Intent 还必须满足 `live_policy.max_signal_age_seconds`；信号已过期时不追单。
- 平仓没有 Signal 时效，但受自身重试窗口、余额和仓位状态约束。
- 目标为证据完成后内部调度不超过 100ms，在额度可用时 1 秒内发出下一次 Swap；链上确认时间不计入内部延迟。
- Robinhood 首轮真实闭环只验证单次提交语义；其失败重试必须在正常 Buy/Close、Receipt 和 Fee 契约全部通过后单独解锁。
- `due_at`、证据窗口和过期判断全部使用数据库时间，Worker 不依赖单个进程的本机时钟。
- 已提交 Attempt 在 Intent 业务终态后进入低频 Terminal Audit，不再高频占用 Query 配额；审计间隔和保留期按链配置。保留期结束只能停止主动轮询，不能拒绝后续 Wallet Activity、Receipt 或人工导入的晚到成交证据。

---

## 十一、数据库与并发设计

### P12-M1：新增 Trade Intent

新增 `trade_intents`，至少包含：

```text
id, side, signal_id, position_id, whitelist_id,
chain, wallet_address, contract_address, source_key, scope_key,
close_generation, wallet_lane_key,
status, max_retries, retry_count, expires_at,
principal_amount_raw, slippage_cap,
config_snapshot_json, last_error_code,
created_at, updated_at, completed_at
```

约束：

- `source_key` 全局唯一；Buy 使用 `buy:signal:<signal_id>`，Sell 使用 `sell:position:<position_id>:close:<close_generation>`。
- 活动状态下 `scope_key` 使用 partial unique index，终态历史不占用活动锁。
- Buy Scope：`buy:<chain>:<wallet>:<ca>`。
- Sell Scope：`sell:<position_id>`。
- 新增 `wallet_write_lanes`/`wallet_quarantines` 持久化 Wallet Lane 状态、占有者、原因、证据、开始与释放时间。

### P12-M2：扩展 Attempt 与 Evidence

- 给 `trade_attempts` 增加 Intent、序号和失败证据字段。
- 增加 `(intent_id, attempt_no)` 唯一索引。
- 给 `trade_orders.normalized_status` 增加 `failure_verifying` 和 `definitive_failed_no_fill`；GMGN `failed/expired` 必须先进入前者，完成证据验证后才能进入后者。
- 将 `failure_verifying` 加入 Reconciler Due Index，避免进程重启后失败验证任务丢失。
- 增加 `trade_retry_decisions` 追加式审计表，保存判定输入、结果和代码版本。
- 增加 `trade_reconciliation_incidents` 追加式审计表，记录 Late Confirmation、Multiple Fill、预算差额和人工处置。
- 失败证据不可覆盖，只能追加新版本。
- 提交前快照不可修改；证据表引用具体 `attempt_id + snapshot_version`，不能读取实时配置替代历史值。
- `superseded` 仅允许用于从未调用资金写 API 的记录，数据库状态迁移和测试必须阻止 submitted/uncertain Attempt 转入该状态。
- Migration 先允许 `intent_id` 为空，再为现有 Attempt 按原 Signal/Close 事实生成一对一的已完成历史 Intent；核对数量和金额后，才对新记录启用非空约束。

### P12-M3：预算改为 Intent 级

- `budget_reservations` 关联 `intent_id`，一个 Intent 只有一个 Principal Reserve 和一个 Retry Fee Envelope。
- 每条 Attempt 可以记录自己的实际失败 Gas。
- 成交时只提交一次本金；Intent 最终失败、拒绝或取消时才释放本金预留。
- 重启恢复时根据 Intent 状态恢复预留，不能因为上一 Attempt failed 就提前释放。
- 已提交 Attempt 未全部形成确定结论前不释放 Fee Envelope；所有实际失败 Gas 都写入 Daily/Weekly Ledger。
- 为已有仓位保留独立 Exit Gas Reserve，买入预算检查不得占用或阻断该余额。
- Late Confirmation 即使发生在预留已释放后也必须按真实成交落账；差额进入 `budget_reconciliation_deficit`，不能因预算校验失败丢弃 Receipt 或 Position/Lot。

### P12-M4：事务与进程锁

- 创建下一 Attempt 时 `SELECT ... FOR UPDATE` 锁定 Intent。
- Retry Worker 使用数据库 `due_at`，通过 `FOR UPDATE SKIP LOCKED` 领取任务；不以“必须单实例”作为正确性前提。
- execution 进程的 advisory lock 只减少重复扫描，唯一索引、行锁和 compare-and-swap 状态迁移才是并发正确性保障。
- Attempt 插入、Intent 序号增加、预算引用和事件写入必须在同一事务完成。
- 进程在 POST 后、保存 Order ID 前崩溃时只能恢复为 `uncertain`，不能根据没有 Order 记录推断未提交。
- 取得 Wallet Write Lane、写入 Attempt submitting 边界和记录 outbox 必须形成可恢复的事务协议；任一阶段崩溃后都不能由第二进程直接重发。

### P12-M5：迁移、兼容与数据核验

- Robinhood 接入必须迁移以下仍限制四链的 CHECK：`trade_attempts`、`position_lots`、`chain_receipts`、`budget_reservations`、`budget_ledger`、`chain_live_readiness`、`shadow_trade_evaluations`、`chain_readiness_evidence`。
- Migration 前后分别核对每张受影响表的行数、金额汇总、外键、状态分布、Receipt/Order 对应关系和未决预算，生成可审计报告。
- Migration 必须 additive-first；部署前验证旧代码版本仍能读取新 schema。若旧版本不兼容，发布流程必须明确禁止代码回滚，只允许前向修复或数据库恢复到实施前快照。
- 历史回填不得重新触发 Outbox、预算结算、白名单计数、Strategy 或任何资金动作。
- 故障注入和并发测试只允许使用独立测试数据库，连接生产数据库时测试进程必须 fail closed。

---

## 十二、代码更新范围

### 架构与目录治理

1. 新增唯一 `ChainManifest` 注册表，集中维护 `gmgnId`、地址格式、原生币、精度、EVM Chain ID、RPC 环境变量、确认数、Fee 能力、Receipt Verifier 和 Address Activity Provider。
2. `TradingProvider` 只表达 GMGN/Binance/Jupiter 等交易场所；Robinhood 放在 Chain Manifest，不再出现 `RobinhoodProvider`。
3. P12-B 前只新增独立 Intent/Attempt Repository，并通过现有 `trade-repository.js` facade 接入；不预先搬迁全部 Order/Budget/Position/Strategy 方法。完整 Repository 拆分在四链真实回归后移入 P12-D。
4. P12-B/C 只为 `SettingsPage.tsx` 增加独立 Retry 和 Robinhood 配置组件；不在资金状态机上线前重排整页。完整页面拆分在 P12-D 做行为等价清理；所有组件继续读取同一后端 API，不生成前端第二份默认值。
5. 新增 `docs/README.md` 作为唯一文档入口；P12 标记 Active，P9-P11 标记 Historical Evidence，P1-P8 标记 Historical Design。
6. 对 disabled Job、Paper、SocialData/TwitterAPI.io 和 legacy compatibility 做“生产可达/显式回退/测试专用/可删除”清单；只有调用图、测试和数据库迁移均证明不可达后才能删除。
7. 架构治理单独提交并保持行为等价；禁止顺手修改预算、风控、信号语义或真实下单参数。

### 后端

1. 新增数据库 migration 和 Trade Intent Repository。
2. 新增 `gmgn-write-error-classifier.js`，按 HTTP 状态、GMGN `error_code`、Order 状态和链上证据分类。
3. 新增 `trade-failure-evidence-service.js`，统一验证 Receipt、Wallet Activity 和精确 Token Balance。
4. 新增 `trade-retry-orchestrator.js`，只处理 `retry_scheduled` Intent。
5. 新增 Wallet Write Lane/Quarantine Repository 与 Service，按 `chain + wallet` 串行化资金写入并持久化不确定状态。
6. 重构 `execution-service.js`，首次买入和重试共用同一个提交函数；提交前原子保存不可变快照。
7. 重构 `close-service.js`，支持同一 Sell Intent 下的多 Attempt、稳定 `source_key` 和 Strategy 状态复核。
8. 修改 `reconciliation-service.js`：GMGN `failed/expired` 先验证失败证据，不能直接 `failOrder()`；所有已提交 Attempt 持续参与晚到成交恢复。
9. 修改预算、Signal、Position 和白名单计数，使其按 Intent 最终结果结算；Late Confirmation 使用同一原子结算路径，防止重复 Position/Lot。
10. 扩展 Chain Manifest/Adapter，根据 Attempt 序号生成链级费用参数并执行费用上限；禁止散落 `if (chain === ...)`。
11. 给 Fast Context 增加强制刷新 Quote/Gas/Balance 的接口；重试不得读取旧缓存。
12. 将 `consecutive_failure_lock` 接到链级实盘熔断，只停止故障链的新买入，不影响其他链和已有平仓对账。
13. 保持 `gmgn-http.js` 的 POST 单次发送语义，禁止在 Transport 层加入写请求 retry loop。
14. `config/service.js` 必须显式校验重试次数、证据窗口、重试窗口、费用开关、链级费用上限和 Exit Gas Reserve，不能依靠保留未知字段的宽松行为。
15. 前端统一使用 Gwei/SOL/BNB 等用户单位，后端适配器集中转换为 GMGN 请求字段所需单位，并用 Contract Test 防止把 Gwei 当成 Wei 或反向放大。
16. 从真实 confirmed Buy+Sell Order、Receipt、Position 和 Lot 自动生成追加式 `manual_e2e` 证据；不能用单独布尔值标记链已验收。
17. 将 Robinhood 修正为 `ETH / 18 decimals / chainId 4663 / EVM / DEX`，增加 `ROBINHOOD_RPC_URL` 和独立确认数。
18. 逐表迁移 P12-M5 列出的八个四链 CHECK，并同步 `config/service.js`、`chain-adapters/index.js`、前端 `ChainConfig` 类型和持仓单位；迁移遗漏任一处都不得开放 Robinhood。
19. 将 Robinhood 纳入地址校验、钱包选择、Token/Pool/Security/Quote、预算、Readiness、Receipt 和 Reconciler，但初始 `enabled=false/retryEnabled=false`。
20. Robinhood 官方 Public RPC 仅用于 Contract Probe 和初始测试；生产 Live 必须配置支持 `chainId=4663` 的独立私有 RPC/Indexer。Alchemy、QuickNode、dRPC 等只作为候选，接入前必须实测该网络确实可用。Readiness 校验 Chain ID、延迟、最新区块新鲜度和连续可用性。
21. Readiness 同时读取 GMGN Wallet Balance 与 RPC Balance；地址或余额不一致时前端显示双方值并阻断真实测试，不能静默选择其中一个。
22. Robinhood Swap 首单不猜测发送 GMGN 文档未声明支持的 `gas_level`、`gas_price`、`auto_fee` 或 anti-MEV 字段；真实 Contract Test 决定最终请求模型。
23. 对截图中的平台维护 `platform label -> representative CA -> Token/Pool/Quote result -> tested_at` 能力矩阵；交易执行仍按 CA，不把平台名称写入路由分支，也不因未测试平台阻断其他已通过实时 Quote 的 CA。
24. Binance 不进入 Robinhood fallback；后续若增加 Binance，只实现独立现货 Symbol Provider 和独立持仓/余额语义。

### 前端

设置页每条链新增“失败重试”区域：

- 自动重试开关。
- 最大重试次数，范围 `0-2`。
- 重试有效时间。
- 费用加速开关。
- 该链对应的绝对费用上限。
- 当前生效值、是否与后端同步。

信号、历史和持仓页新增：

- Trade Intent ID。
- 当前第几次 Attempt。
- 上一次失败原因和证据来源。
- 本次 Quote、Gas/优先费和是否升档。
- 剩余重试次数与重试窗口。
- `成交状态不确定，已锁定，禁止自动重试`。
- Wallet Quarantine 的链、钱包脱敏标识、阻断范围、开始时间和解除证据。
- Principal Reserve、Retry Fee Envelope、已用失败 Gas 和 Exit Gas Reserve。
- 晚到成交恢复标记及原 `cancelled/exhausted/rejected` 状态。
- 最终成交 Attempt 和被终止的 Attempt 时间线。

前端只展示和修改后端 `chain_configs` 中的正式值，不维护第二份默认参数。

Robinhood UI 要求：

- 保留现有白名单、KOL、ChainIcon 和 ChainId 入口。
- 设置页按 ETH 显示单位，但明确标注“Robinhood Chain”，不得显示 USD 预算语义。
- 在 Contract、余额、最小买卖闭环未完成前展示具体阻断原因，不允许只显示模糊的“尚未开放”。
- 分别展示 Public Probe RPC 与 Production RPC 状态、`chainId`、延迟、最新区块时间，以及 GMGN/RPC 两侧余额核对结果。
- 平台支持矩阵只用于验收与诊断；用户正常添加白名单仍只需要 CA、项目 X 和交易参数。

---

## 十三、测试方案

### 13.1 自动化测试

自动化故障注入用于证明状态机，不替代真实链成交验收。

必须覆盖：

1. Attempt 1 Receipt 明确失败，只创建一条 Attempt 2。
2. Attempt 1 超时，但 GMGN 后续 confirmed，永远不创建 Attempt 2。
3. HTTP 502 后链上出现成交，不重试并恢复原订单。
4. 429、鉴权、余额不足和参数错误不重试。
5. GMGN failed 但链上 confirmed，进入 uncertain，不重试。
6. 无 Hash 的 failed/expired 只有一条证据时不重试；证据完整后才重试。
7. EVM dropped 但存在 replacement Hash 时继续原 Attempt 对账。
8. 多进程同时扫描同一 Intent，只能创建一个下一 Attempt。
9. 两个 KOL 同时命中同一 CA，只产生一个活动 Buy Intent。
10. 重启发生在 POST 前、POST 后、Order 持久化后等边界时均不重复提交。
11. 三次 Attempt 只占用一份本金预算，只增加一次白名单买入次数。
12. Retry Fee Envelope 覆盖最坏三次提交，失败 Gas 正确进入 Daily/Weekly Ledger，未把失败本金计为已花费，未使用额度在确定终态后释放。
13. 平仓首次失败后按最新 Lot/Wallet Balance 重试，不超卖。
14. Strategy 在取消过程中触发时，Sell Intent 进入 uncertain，不重复卖出。
15. SOL/BSC/Base/ETH 四个费用适配器不会发送互斥或该链不支持的参数。
16. Rate Scheduler 在 Quote + Gas + Query + Swap 组合流量下不主动触发 429。
17. Chain Manifest 缺字段时启动失败关闭，新增 Robinhood 不需要在五处维护重复链枚举。
18. Repository 拆分前后相同查询和结算 fixture 输出一致，兼容 facade 不改变现有四链行为。
19. Robinhood 地址、Chain ID、RPC、18 位金额、Quote、Gas 和 Receipt Contract Test 全部通过。
20. Robinhood 不发送未经验证的 Fee/anti-MEV 字段，服务端 `400` 不会被分类为可重试失败。
21. Binance Provider 不会被 Robinhood CA 或 GMGN Quote 失败自动调用。
22. 同钱包 CA-A 进入 uncertain 后，CA-B 的 Buy/Retry 被 Wallet Quarantine 阻断；余额变化不能跨 CA 充当失败证据。
23. Quarantine 在进程重启后仍存在，只有确定对账或带审计的人工解除才能释放。
24. Intent 已 `cancelled/exhausted/rejected` 后旧 Attempt 晚到 confirmed，能够原子恢复为 confirmed，并且预算、Receipt、Position/Lot、白名单计数各只结算一次。
25. Reconciler 不会因为 Intent 业务终态而停止扫描任何已提交 Attempt。
26. 无 Hash 失败测试覆盖 EVM pending/latest nonce、地址交易历史、原生币/Token 精确余额、replacement 和固定证据窗口；任一证据无法唯一解释时保持 uncertain。
27. SOL 无 Hash 失败测试覆盖提交前 slot/signature 游标和后续签名扫描，不使用 EVM nonce 逻辑。
28. `UNIQUE(source_key)` 阻止重复 Signal/重复平仓点击创建新 Intent；活动 `scope_key` partial unique index 不阻断历史记录。
29. 已调用 Swap 的 Attempt 不能迁移为 `superseded`；只有未提交调度记录允许该状态。
30. 两个 Worker 使用 `FOR UPDATE SKIP LOCKED`/CAS 并发领取任务时不重复创建 Attempt；进程时钟漂移不改变数据库 `due_at` 结果。
31. Migration 前后行数、金额、外键、状态分布和 Receipt/Order 对账一致，历史回填不触发 Outbox 或资金动作。
32. 测试进程连接生产数据库时 fail closed；故障注入只在独立测试数据库运行。
33. Robinhood Production RPC 缺失、`chainId` 错误、区块过旧、延迟超限或 GMGN/RPC 余额冲突时均 fail closed。
34. Robinhood 链级验收不因某个平台为 `not_tested` 而全局失败，但目标 CA 实时 Quote 失败时该笔交易必须阻断。
35. 旧版本读取 additive schema 的兼容测试通过；若不兼容，部署测试验证禁止代码回滚并可从实施前数据库快照恢复。
36. 一个 Intent 两条 Attempt 均晚到 confirmed 时进入 `multiple_fill_incident`，每笔真实 Fill/Receipt/Lot/Gas 均完整落账、钱包被冻结，且不会自动反向交易。
37. Late Confirmation 发生在 Principal Reserve 已释放或预算不足后仍能完成事实结算，并生成 `budget_reconciliation_deficit`。
38. Terminal Audit 降频后不再高频消耗 Query 配额，保留期结束后仍可接收 Wallet Activity/Receipt 导入并触发晚到成交恢复。

### 13.2 真实交易验收

真实验收继续使用真实 6551 Signal、真实 GMGN Order 和真实链上资金，不使用构造 Provider Event。

每条链至少保留：

```text
Provider Event ID
Signal ID
Trade Intent ID
每条 Attempt ID
GMGN Order ID
Tx Hash
RPC Receipt
失败证据（若自然发生）
Position / Lot / Strategy
Sell Intent / Sell Order / Sell Receipt
实际 Token 和 Native Delta
实际 Gas、PnL 和全链路时间线
```

不故意制造超时或未知状态的真单。重试状态机由自动化故障测试覆盖；真实链验收证明更新后的正常 Buy/Close 路径仍然使用真实资金并正确结算。生产中首次自然出现的明确失败重试，应自动形成追加式审计报告。

### 13.3 部署、回滚与生产观测

部署门禁：

1. 先备份生产数据库，再执行 additive migration 和只读回填；Migration 期间自动重试保持全链关闭。
2. 回填后运行 P12-M5 数据核验并保存报告；任一金额、外键或状态不一致立即停止发布。
3. 应用版本、Migration 版本和 Chain Config 版本写入每条新 Attempt 快照。
4. 先部署只读查询和前端展示，再部署 Retry Worker；最后逐链打开 `retryEnabled`，禁止五链同时首开。
5. 明确代码/数据库回滚矩阵：只有 schema 向后兼容时才允许回滚应用；否则恢复数据库快照或前向修复。

生产必须提供以下指标和告警：

- `trade_attempt_uncertain_total` 与当前未决数。
- `wallet_quarantine_active`、持续时间和阻断写入数。
- `retry_scheduled_total`、`retry_success_total`、`retry_exhausted_total`。
- `late_confirmation_total` 及其原 Intent 状态。
- `multiple_fill_incident_total` 和 `budget_reconciliation_deficit`。
- `duplicate_funds_write_total`，目标值必须永久为 0。
- 各链 GMGN/RPC 延迟、429、证据观察耗时、Receipt 确认耗时和 Worker backlog。
- Principal Reserve、Retry Fee Envelope、失败 Gas、Exit Gas Reserve 与 Ledger 差额。

生产首次自然发生的重试、Late Confirmation 或 Wallet Quarantine 必须自动生成不可修改审计报告，并由人工复核后才扩大该链重试范围。

---

## 十四、实施与真实验收顺序

### P12-A0：冻结事实与建立唯一状态入口

- [x] 重新核对四链 Attempt、Order、Receipt 和 Position，确认四链真实 Buy/Close 已闭环且当前无 Live Open Position。
- [x] 完成 Robinhood GMGN/RPC 只读探针，确认钱包存在但余额为 `0 ETH`。
- [ ] 实施前导出数据库安全快照，记录 Migration 版本、Git diff、预算 Ledger 和未决状态。
- [x] 新增 `docs/README.md`，规定 P12 为唯一 Active Plan；历史文档不得继续覆盖当前状态。
- [x] 在根入口或 `docs/README.md` 补齐启动方法、测试边界和生产/测试数据库隔离说明。
- [x] `ENGINEERING_LOG.md` 只记录事实时间线，不再承担多份并行计划的职责。

退出标准：任何维护者从根 README 或 `docs/README.md` 都能找到当前架构图、P12、启动方法、测试边界和历史证据。

### P12-A1：Chain/Provider 边界收敛

- [ ] 建立最小单一 Chain Manifest，并让后端配置、Adapter、Receipt、Readiness 和前端 Chain 元数据从同一事实源派生；后端 Registry 已落地，前端元数据统一派生仍待 P12-D 兼容拆分。
- [x] 保持 GMGN 为当前 TradingProvider；Robinhood 只增加禁用状态的 EVM Chain Manifest。
- [x] 只新增 Intent/Attempt Repository 与 Retry/Robinhood 前端组件，通过现有 facade/API 接入；此阶段不搬迁全部旧 Repository 方法，也不重排整个 Settings 页面。
- [x] 生成 production reachability 清单，暂不删除 disabled Job、Paper 和备用 X Provider。

退出标准：新增一个禁用状态的新链不再需要手工修改五组链枚举；新模块可以不改写旧结算逻辑地接入；现有四链单元测试、集成测试和前端构建无回归。

### P12-B0：Intent 数据模型只读部署

- [x] 在独立空测试库执行 additive-first Migration 013，并通过可重复的 `npm.cmd run test:migration:p12` 历史数据回填演练。
- [ ] 停止新交易并备份生产库后执行 additive-first Migration 013；尚未触碰生产数据库。
- [x] 新增稳定 `source_key`、活动 `scope_key` partial unique index、Wallet Write Lane/Quarantine、Principal Reserve 和 Retry Fee Envelope。
- [x] 独立迁移库已验证旧 Attempt 一对一 Intent 回填；13 张历史业务表的旧字段和行数保持不变，Order、Receipt、Position/Lot、Strategy、预算、Ledger 与 Outbox 未被改写。
- [x] 独立迁移库已核对 Intent/Attempt 外键、预算/Ledger 关联、Outbox 和八张 Robinhood 链 CHECK；演练结果为通过。
- [ ] 生产发布时执行 Migration 前后行数、金额、外键、状态和 Ledger 对账；验证旧版本读取兼容性或明确禁止代码回滚。
- [x] 自动重试默认全链关闭，迁移与离线测试不提交任何 Swap。

退出标准：新旧查询结果一致，所有历史 confirmed/rejected 记录可解释，数据库不存在孤儿 Intent。

### P12-B1：明确失败重试内核

- [x] 完成 Error Classifier、不可变提交前快照、Failure Evidence、Retry Orchestrator、Intent 级预算、Wallet Write Lane/Quarantine 和进程/事务锁。
- [x] Buy/Close 复用同一 Adapter 与单次写入语义，Transport 层保持零写请求重试。
- [x] Reconciler 将 failed/expired 先转入证据验证，不再立即释放预算或结束 Signal。
- [x] Reconciler 覆盖已取消/已耗尽/已拒绝 Intent 的 Late Confirmation，并使用同一原子结算路径恢复。
- [x] Multiple Fill 不折叠、不自动反向交易；按事实结算后冻结钱包，并记录预算差额和最高优先级事故。
- [x] 接入链级连续失败熔断、429 冷却、`uncertain` Wallet Quarantine 和独立 Exit Gas Reserve。

退出标准：第十三节自动化故障、并发、崩溃恢复、预算和限流测试全部通过。

### P12-B2：前端与四链真实回归

- [x] 设置、信号、历史和持仓页显示 Intent、Attempt、证据、剩余次数、费用档位和锁定原因。
- [ ] SOL、BSC、Base、ETH 每条链分别执行最小金额真实 Buy/Close 回归，使用用户当前前端配置，不使用隐藏测试金额。
- 每次真实写入前单独确认目标链、CA、金额、滑点和费用上限；不得一次性打开四链同时测试。
- [x] 代码已支持从 confirmed 事实自动生成不可修改的 `manual_e2e` Evidence；实际证据须由更新后真实回归产生。
- [ ] 单链回归通过后才允许该链 `retryEnabled=true`，其余链保持关闭；当前全部保持关闭。

退出标准：更新后的四链仍各自形成 Signal -> Intent -> Attempt -> GMGN Order -> RPC Receipt -> Position/Lot -> Close/PnL 完整证据。

### P12-C0：Robinhood 禁用状态接入

- 修正 Robinhood Chain Manifest 和数据库默认配置，分别接入 Public Probe RPC 与 Production RPC，并校验 `chainId=4663`。
- 逐表迁移 `trade_attempts`、`position_lots`、`chain_receipts`、`budget_reservations`、`budget_ledger`、`chain_live_readiness`、`shadow_trade_evaluations`、`chain_readiness_evidence` 的四链 CHECK。
- 将 Robinhood 纳入白名单、KOL、预算、Readiness、GMGN Wallet/Quote、Receipt 和前端设置。
- 默认保持 `enabled=false`、`retryEnabled=false`，且不加入 `live_policy`。
- Public RPC 只用于 Contract Probe；配置 Production RPC 并校验 `chainId=4663`、延迟、区块新鲜度、连续可用性和 GMGN/RPC 余额一致性。
- 先用一个已毕业高流动性 CA 和一个 `new_creation` CA 完成链级只读门禁；对 Noxa.fun、Flap、Flap PVE、Trench、Bow.fun、Pons、o1.exchange、Circus、ArrowFinance、Long.xyz、Motion、Stoxes RWA 持续保存代表 CA 的能力矩阵，没有可用 CA 的平台标记 `not_tested`，但不阻断其他实时 Quote 已通过的 CA。

退出标准：Robinhood 页面可完整配置和诊断，所有只读检查可重复执行，仍然没有资金动作。

### P12-C1：Robinhood 最小真实闭环

用户侧前置条件：

1. 向 GMGN 返回的 Robinhood 钱包充值少量 Robinhood Chain ETH。
2. 提供一个用户认可的 Robinhood 白名单 CA、项目 X 和 KOL 关系。
3. 在前端确认 maxPerTrade、每日/每周预算、滑点、TP/SL 和 Gas Reserve。

执行顺序：

1. 重新验证钱包余额、RPC、Token、Pool、Security、Quote 和最小到账量。
2. 只开放唯一 Robinhood 白名单，使用一次真实 6551 事件触发最小金额 Buy。
3. Swap 首次请求不发送未经验证的 Robinhood Fee/anti-MEV 参数。
4. 保存 GMGN Order、Tx Hash、Robinhood Receipt、Token Delta、Position、Lot 和 Strategy。
5. 从前端真实平仓，核对 Sell Order、Receipt、余额、费用和 PnL。
6. 正常闭环通过后，再用自动化证据测试验证 Robinhood Retry Adapter；不故意制造真实失败。

退出标准：Robinhood 至少完成一次真实 Buy/Close，且与现有四链使用相同 Intent、预算、Reconciler 和前端时间线。

### P12-D：稳定运行与受控清理

- 五链按链独立启用；新链或单链故障不影响其他链已有仓位退出和对账。
- 连续运行期间核对 429、GMGN/RPC 冲突、未决 Intent、Wallet Quarantine、Late Confirmation、预算/Fee Envelope、Outbox 和 Supervisor 重启恢复。
- 四链真实回归稳定后，再通过兼容 facade 分步拆分 `trade-repository.js`，并把 `SettingsPage.tsx` 拆成链资金、实盘策略、X Provider、GMGN/系统和运行状态组件；每一步做行为等价测试。
- 根据 A1 的 reachability 清单删除已证明不可达的 legacy 文件；保留显式回退能力，并把历史设计文档移入 History 索引。
- 删除动作必须独立提交，测试文件保留；测试不进入生产运行路径，本身不会影响实盘。

---

## 十五、完成定义

P12 只有满足以下条件才算完成：

- [ ] `docs/README.md`、架构图和 P12 构成唯一当前状态入口，P1-P11 不再与当前事实冲突。
- [ ] Chain Manifest 与 TradingProvider 边界落地，Robinhood 不再是 USD/CEX 占位或独立 Provider。
- [ ] Intent/Attempt 与 Retry/Robinhood 先通过最小新模块接入；四链回归后过大 Repository/Settings 模块已兼容拆分，生产可达与 legacy 文件清单已形成。
- [ ] 五链使用统一 Trade Intent、多 Attempt 和数据库唯一锁。
- [ ] `source_key`、活动 `scope_key` partial unique index 和 `(intent_id, attempt_no)` 分别阻止来源、业务范围和物理提交重复。
- [ ] Swap HTTP 层保持单次写入，没有隐藏自动 retry。
- [ ] 只有 `definitive_failed_no_fill` 可以创建下一 Attempt。
- [ ] timeout、5xx、429、missing order ID 和链上冲突均不会自动重发。
- [ ] 无 Hash 失败同时核对不可变前置快照、nonce/slot、地址交易历史、Wallet Activity、精确余额、replacement 和固定证据观察窗口。
- [ ] 任一不确定资金写入会触发同链同钱包 Wallet Quarantine，其他 CA 不会继续改变 nonce 或余额。
- [ ] 已提交 Attempt 在 Intent `cancelled/exhausted/rejected` 后仍持续对账，Late Confirmation 能原子恢复并只结算一次。
- [ ] 同一 Intent 多个 Attempt 成交时完整记录所有真实 Fill，进入 `multiple_fill_incident` 并冻结钱包，不自动反向交易掩盖差额。
- [ ] 买入和卖出都支持安全重试，部分成交和策略竞态不会重复交易。
- [ ] 三次 Attempt 只预留一份本金和受上限约束的 Retry Fee Envelope，只结算一次持仓、只增加一次买入次数；失败 Gas 和 Exit Gas Reserve 分账正确。
- [ ] SOL/BSC/Base/ETH 费用升级参数合法并受前端绝对上限控制；Robinhood 只发送已由真实契约验证的参数。
- [ ] 连续失败熔断已经接入实盘执行链路。
- [ ] SOL/BSC/Base/ETH 更新后均完成最小金额真实回归。
- [ ] Robinhood 完成钱包充值、最小真实 Buy/Close、GMGN Order 和 `chainId=4663` Receipt 验收。
- [ ] Robinhood 八张四链 CHECK 表、后端门禁和前端类型/单位均完成迁移；Production RPC 和 GMGN/RPC 余额一致性通过 Readiness。
- [ ] Robinhood 平台 CA 矩阵记录真实 `passed/failed/not_tested`，不以 UI 标签替代 API 证据，也不把未测试平台错误设为整链门禁。
- [ ] 五链重试配置、Attempt 时间线和失败证据在前端可见；Robinhood 正常闭环前保持重试关闭。
- [ ] 自动化故障、并发、重启、Migration、预算、Wallet Quarantine、Late Confirmation 和 429 测试全部通过，且只使用独立测试数据库。
- [ ] 生产指标可以发现 uncertain、wallet quarantine、retry success/exhausted、late confirmation、重复资金写入和 Fee Envelope/Ledger 差额。
- [ ] Terminal Audit 能在控制查询配额的同时继续接收晚到链上证据，预算已释放也不会阻止事实结算。
- [ ] 生产数据库不存在无法解释的未决或重复 Intent。
- [ ] `.env`、PEM、API Key、钱包完整地址和真实响应敏感字段没有进入 Git 或测试 fixture。

最终结论只能写为：

> **XBOT 已在 SOL、BSC、Base、Ethereum、Robinhood 上通过统一 GMGN 交易内核完成真实买卖闭环，并能在上一笔已被证明明确失败且未成交后，受次数、时效、费用、预算和并发锁约束地安全重试；任何成交状态不确定的交易均不会自动重发，新增链不再复制交易状态机。**
