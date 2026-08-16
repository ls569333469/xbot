# P31 研究链路可见性与调度收敛方案

> 文档状态：`LOCAL_ACCEPTED / PENDING_DEPLOYMENT`（本地已实现并验收，待部署）
>
> 发现日期：2026-08-13
>
> 范围：账号研究 REST 契约、固定 CA 快速投研调度、批次状态聚合、前端详情加载和失败可观测性
>
> 非目标：不修改研究算法和 Provider 调用步骤，不修改三策略、Engine 或真实交易配置

> 后续修订：P31 只负责结果可见性和 Research 调度。KOL 账号研究的完整算法边界、双分支 Provider 职责、指标口径和防回归要求，以 [P32 KOL 账号投研架构与防回归基线](./P32_kol_account_research_architecture_and_regression_baseline.md) 为准。

## 1. 生产问题与证据

用户在 xiexiu 的账号研究页面创建了 `@riley_gmi` 批次。页面显示“输入账号 1、完成分析 0、批次已完成”，结果表为空。

2026-08-13 生产只读核查确认：

| 项目 | 生产事实 |
|---|---|
| 批次 ID | `2` |
| 创建时间 | `2026-08-13 18:54:12`（Asia/Shanghai） |
| 账号 | `@riley_gmi` |
| 子任务状态 | `completed` |
| 样本 | `63` 条 |
| 直接意图率 / CA 解析率 | `0% / 0%` |
| 建议 | `watch` |
| 错误 | 无 `error_code`，无 `last_error` |
| 执行时间 | 约 2.6 秒 |

结论：6551 读取、Worker 分析和 PostgreSQL 持久化均已完成。故障发生在前端读取契约，不是研究任务没有返回。

固定 CA 快速投研的生产截图同时显示：任务成功创建、Job 为 `pending`、Item 为 `queued`，页面长期停留在“等待启动”。代码审计确认 P26 新增的 Engine 全局隔离在 `desired_running/running/armed` 任一状态下拒绝领取全部研究任务。生产 Engine 长期实盘运行时，这个条件不会自然解除，因此固定 CA 投研被永久饿死，根本没有进入 GMGN、Grok 或 6551 阶段。

## 2. 根因

### 2.1 摘要对象被当成详情对象

`GET /api/actor-screening` 只返回批次字段和聚合计数，不返回 `results`。页面却使用 `selectedRun.results || []` 计算完成数和渲染表格，所以历史批次固定可能显示为 0 和空表。

### 2.2 详情请求只服务于运行中轮询

页面仅当批次状态为 `pending/running` 时请求 `GET /api/actor-screening/:id`。批次进入终态后，页面清空已取得的详情，再刷新不含 `results` 的列表摘要，导致刚完成的结果也会消失。

### 2.3 父批次终态不精确

当前 Worker 只要发现一个失败子任务就把父批次写为 `partial`。当所有账号都失败时也不会标记为 `failed`，前端状态和重试语义不准确。

### 2.4 失败原因不可见

详情对象虽包含 `error_code/last_error`，前端类型缺少 `last_error`，结果表也不展示失败行的具体原因。用户只能看到空结果或汇总状态，无法判断是 6551、输入、历史候选还是内部错误。

### 2.5 Engine 状态被误当成 Research 永久门禁

P16 的既定规则是：固定 CA 投研使用 GMGN 最低优先级，只有真实交易队列、有效 Trade Lease 或 429 冷却存在时暂停。P26 将这一动态调度错误扩大为“Engine 只要运行就不得领取研究任务”，导致正常实盘期间所有人工投研永久停在 `queued`。

该硬门禁并不能提供额外交易安全：GMGN 请求已经统一进入共享 Weighted Scheduler，Quote/Swap、订单恢复和策略动作具有更高优先级，研究请求为 `CACHE_WARMUP` 最低优先级。正确边界是按实际 Provider 占用让路，而不是按 Engine 长期状态永久关闭产品功能。

## 3. 目标契约

### 3.1 列表接口是摘要

`GET /api/actor-screening` 返回：

- `result_count`
- `completed_count`
- `failed_count`
- `recommended_count`

列表用于左侧批次导航和详情尚未加载时的稳定汇总，不承载账号明细。

### 3.2 详情接口是唯一明细来源

选择任何批次后都立即请求一次 `GET /api/actor-screening/:id`，无论批次处于运行态还是终态。只有 `pending/running` 状态继续每 3 秒轮询；进入终态后保留最后一次详情，不再退回摘要对象。

### 3.3 父批次状态真值表

| 子任务集合 | 父批次状态 |
|---|---|
| 存在 `pending/running` | `running` |
| 全部 `completed` | `completed` |
| 全部 `failed` | `failed` |
| 同时存在成功和失败 | `partial` |

失败或部分失败时，父批次 `last_error` 保存首个子任务错误摘要；账号级完整错误仍以详情接口为准。

### 3.4 固定 CA 投研调度契约

- Engine 停止且 Provider 空闲：最多并发 `3` 个 CA。
- Engine 处于实盘意图或 Armed：允许投研继续，但最多并发 `1` 个 CA。
- 实盘领取前至少保留 `9` 权重：`6` 给五链中最重的受控交易租约，`3` 给本次投研首段 Token Info/Security/Pool。
- 存在 Trade Lease、Quote/Swap、订单恢复、策略动作等高优先级 GMGN 请求：不领取新的投研 Item，等待高优先级请求完成。
- GMGN 处于共享 429 冷却：不领取新的投研 Item，等待 `reset_at/cooldownUntil`。
- 已领取的研究请求仍使用 `CACHE_WARMUP` 最低优先级；新的交易请求由 Scheduler 优先执行。
- API 返回 `queue_status`，前端展示明确等待原因，不再用“等待启动”掩盖永久阻断或 429 冷却。

## 4. 实施内容

1. 前端将“列表摘要”和“当前批次详情”拆成独立状态。
2. 切换历史批次、创建新批次、重试失败批次时都主动加载详情。
3. 轮询完成后将终态详情保留在页面，并同步更新左侧摘要计数。
4. 详情加载中显示明确状态；接口失败时显示加载错误，不伪装成“没有结果”。
5. 失败账号仍作为结果行展示，直接显示 `error_code` 和 `last_error`。
6. 后端列表补齐失败数和建议记录数。
7. Worker 使用一个明确的状态聚合函数生成父批次状态，补充全部成功、全部失败、部分失败和运行中测试。
8. 增加前端源代码契约测试，防止以后再次只轮询运行态或在终态清空详情。
9. 删除 Research Queue 对 `desired_running/running/armed` 的永久拒绝，保留 Engine 恢复后再启动 Queue 的启动顺序。
10. 实盘模式把固定 CA 投研并发降为 `1`；只由共享 Scheduler 的真实 Lease、高优先队列和 429 冷却暂缓领取。
11. 固定 CA Job 详情返回 `queue_status`，页面显示“交易请求优先”“GMGN 冷却”或“前一项投研处理中”。

## 5. 性能与 Provider 边界

- 每次选中批次新增一次本地 REST + PostgreSQL 详情查询，最多聚合该批次 50 个账号，成本可控。
- 轮询频率仍为 3 秒，只在 `pending/running` 期间存在。
- 页面刷新、批次切换和历史详情加载不调用 6551。
- 账号研究可见性修复不增加任何 Provider 调用。
- 固定 CA 投研恢复其 P16 已有的显式人工 GMGN + Grok + 6551 链路，不新增调用步骤；实盘时并发从 `3` 收敛为 `1`。
- 投研 GMGN 请求继续使用最低优先级，并在 Trade Lease、高优先队列和 429 冷却期间暂停，不进入买入热路径。
- 研究 Worker 的既有 6551 调用次数和研究算法保持不变。

## 6. 自动验收

本地已通过：

1. 后端账号研究定向测试。
2. 后端全量测试。
3. 前端 lint 和 production build。
4. 前端契约测试：历史终态批次也请求详情；终态结果不被清空；失败原因可见。
5. DOM 回归：桌面和移动视口选择历史批次后，统计和表格一致，无溢出和遮挡。
6. `git diff --check`。
7. Research Queue 回归：Engine Live 且 Scheduler 空闲时以并发 `1` 领取；Trade Lease、高优先队列和 429 冷却时领取数为 `0`。
8. 固定 CA DOM 回归：pending Job 显示实际等待原因，进入 GMGN/Grok/6551/终态后状态正常更新。

验收证据：后端定向测试 `31/31`、后端全量测试 `560/560`、前端 lint/build、桌面与移动 DOM 回归以及 `git diff --check` 均通过。这些是本地证据，不代表 xiexiu 已部署。

## 7. xiexiu 部署验收

P31 代码通过本地验收后，发布仍按 P29 工作手册执行。部署后只读复核：

1. `xbot.service`、ingestion、execution 保持单实例健康。
2. Engine 和三策略运行意图不因本次发布被改写。
3. 打开批次 `2` 后显示 `@riley_gmi`、`63` 条样本和 `watch`，完成分析为 `1`。
4. 创建一个无资金影响的账号研究批次，运行态可轮询，完成后结果不消失。
5. 页面操作期间 GMGN 审计无增量、无新增 429。
6. 在无交易请求的窗口创建一个只读固定 CA 投研任务，确认 `queued -> gmgn -> grok -> verification -> completed/failed` 能收敛，且没有 Swap 调用。
7. 投研运行期间如出现真实交易请求，确认交易优先且 Research 不产生 GMGN 429。

## 8. 完成定义

只有代码、自动测试、DOM 回归和 xiexiu 页面复核全部通过，P31 才能标记为 `COMPLETED`。本地完成但尚未部署时，必须明确写为“已实现、待部署”，不得声称生产问题已经修复。
