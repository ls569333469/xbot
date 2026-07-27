# P12 生产可达性与保留清单

> 核对日期：2026-07-23
> 目的：区分生产主链路、显式回退、测试资产和不可达旧代码；本清单只决定后续治理顺序，不在 P12-B 资金状态机更新中删除文件。

## 生产主链路

| 范围 | 入口 | 结论 |
|---|---|---|
| 进程守护 | `backend/scripts/supervisor.js` | 启动 `ingestion` 与 `execution` 双进程，异常退出自动拉起 |
| X 实时采集 | `domains/x-monitor/6551-wss-consumer.js` | 6551 Max Watch + WSS 当前生产入口 |
| 信号持久化 | 6551 Inbox、Normalizer、Signal Matcher | Provider Event 到 Activity/Signal 的正式链路 |
| 自动买入 | `live-execution-queue.js` -> `execution-service.js` | 只消费满足 Live Policy 和 Readiness 的持久化 Signal |
| 平仓 | `close-service.js`、Strategy Reconciler、Wallet Activity | 人工平仓、保护策略触发和外部卖出恢复均进入统一 Sell Intent |
| 交易对账 | `reconciliation-service.js`、`chain-receipt-service.js` | GMGN Order、RPC Receipt、Position/Lot、预算和 PnL 的事实入口 |
| 明确失败重试 | `trade-retry-orchestrator.js` | 只领取 `retry_scheduled` Intent；所有链默认关闭重试 |
| 资金并发保护 | `wallet-write-lane.js`、`trade-circuit-breaker.js` | 同链同钱包隔离与链级新买入熔断，均持久化并可审计 |

## 显式回退或人工可达

| 范围 | 当前可达方式 | 保留原因 |
|---|---|---|
| TwitterAPI.io | 仅当 `X_DATA_PROVIDER=twitterapi`，可通过 Webhook/受控接口进入 | 6551 故障时的显式回退；不得与 6551 同时生成生产信号 |
| SocialData | 仅当 `X_DATA_PROVIDER=socialdata` 且显式调用旧轮询入口 | 历史回退和诊断，不是当前生产主链路 |
| Paper Engine | 仅 Paper Position 的 API 平仓和禁用 Cron Job | 与 Live 预算、Attempt、Position 明确隔离，暂不删除 |
| Shadow Evaluator | 环境开关显式启用且非 Live 模式 | Readiness/SLO 验证资产，不执行资金写请求 |

## 默认不可达的旧 Job

`backend/cron.json` 中以下任务全部 `enabled=false`：

- `x-poll-timeline`
- `x-poll-follows`
- `signal-matcher`
- `price-monitor`
- `order-sync`
- `budget-reset`

其中 `budget-reset` 已被不可变 Reservation/Ledger 周期替代；其余仍可能被人工诊断或显式回退使用。P12-D 只有在调用图、数据库迁移和等价测试同时证明无需保留后，才能独立提交删除。

## 测试专用

- `backend/tests/*.test.js`：纯单元测试，不进入生产加载路径。
- `backend/tests/*.integration.js`：只允许独立测试数据库，受 `integration-guard.js` 强制保护。
- Mock Provider、故障注入和并发领取 Fixture：只能在测试进程使用，不得由生产配置隐式启用。

## 当前治理结论

1. 本轮不删除 Paper、TwitterAPI.io、SocialData、Shadow 或 disabled Job。
2. P12 新资金状态机使用独立模块接入，暂不大规模拆分 `trade-repository.js` 和 `SettingsPage.tsx`。
3. 源码中的旧绝对路径注释和历史命名列入 P12-D 行为等价清理，不与资金语义变更混合。
4. Robinhood UI 和 Chain Manifest 必须保留；当前仅禁用真实执行和重试，不视为死代码。
