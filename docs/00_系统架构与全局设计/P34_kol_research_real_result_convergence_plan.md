# P34 KOL 账号研究真实结果收敛方案

> 状态：IMPLEMENTED / LOCAL LIVE READ-ONLY ACCEPTED / NOT DEPLOYED

> 范围：只修复 `KOL -> 账号研究` 的 6551 采样、Grok 语义识别、GMGN 历史行情结果分类和前端诊断。不读写交易信号、交易意图、持仓或 Engine 状态，不调用 GMGN Quote、Swap 或 Order。

## 1. 当前问题的证据

2026-08-15 本地实测 `@0xMoon` 30 天帖子分析：

- 界面选择 30 天，6551 实际只返回最新 100 条；
- 100 条仅覆盖 2026-08-13 11:01 至 2026-08-15 04:44；
- 样本中有 80 条回复、12 条原帖、8 条引用帖；
- 100 条全部被本地硬门槛标记为 `POST_CA_NOT_ACTIONABLE`；
- Grok 调用 0 次，GMGN 调用 0 次，最终返回 0 CA。

`@ltchives` 能从 100 条帖子解析 10 次 CA，去重后为 3 个 BSC CA，但 GMGN 返回空 K 线。资产已标记 `GMGN_KLINE_EMPTY`，批次却被错误标记为“已完成”。

因此问题不是单一前端渲染故障，而是采样覆盖、Grok 触发和终态语义同时不正确。

## 2. 必须保持的产品边界

1. **帖子喊单分析**：研究 KOL 自己发布、引用或回复的内容，定位可核验的 `chain + CA`，再回放历史价格。
2. **关注策略分析**：只统计系统真实观察并写入 `x_activities` 的 Follow 事件。已有 P21 解析结果优先复用；缺失时可对事件中已知目标账号调用 Grok，并做链上只读核验。没有事件必须明确显示“未观察到历史关注事件”，Grok 不得发现或猜测历史关注列表。
3. **Grok 账号画像**：保持独立手动入口，只输出身份、风格、关联项目和公开证据，不混入 CA 倍数分母。
4. 三条研究链路全部只读，不允许影响实盘策略、Engine 或 GMGN 交易。

## 3. 帖子采样收敛

### 3.1 时间窗口必须真实

`X6551Client.searchTweets` 必须透传 `sinceDate`、`untilDate`、`excludeReplies`、`excludeRetweets` 及互动阈值。

帖子源采用“主体完整采样 + 回复受控补采”两条只读通道：

1. 主体帖子按 7 天窗口查询 `fromUser` 的 Latest 内容，并设置 `excludeReplies=true`、`excludeRetweets=true`；
2. 主体窗口返回 100 条时才按 UTC 日期边界二分，最小分段为 1 天；
3. 回复只通过一次 `twitter_user_tweets` 做近期补采，不能驱动窗口二分；
4. 默认每次 6551 请求间隔 2.5 秒，单任务最多 16 次，研究调用关闭客户端密集自动重试；
5. 本地按精确 ISO 时间截断并按 tweet id 去重；
6. 达到 Provider 请求上限、单日仍满 100 条或中途限频时，保留已取得分段并标记“部分覆盖”，不得丢弃整批结果。

返回并保存：总查询次数、主体查询/成功次数、回复补采次数、窗口起止、最早/最晚样本、原帖/引用/回复数、饱和分段数、覆盖是否完整，以及准确的 6551 错误和 `Retry-After`。

### 3.2 Grok 不再被本地硬门槛关闭

- 完整 CA 仍由本地精确提取，不浪费 Grok 调用；
- 其余帖子使用“资产术语 + 喊单语义 + 来源类型”软排序，不再由 `strongCall()` 一票否决；
- 原帖和引用帖优先，回复保留独立配额，防止大量回复挤出原帖；
- 候选帖子按批发给 Grok，一次返回每个 tweet id 的 `resolved/no_match`、CA、链和证据；
- 全量帖子先做本地完整 CA 解析；剩余自然语言候选按相关度选前 10 条，并在一次批次中完成 Grok 研究；
- Grok 使用“公开搜索 -> 严格结构化”两阶段协议，规避 `grok-4.5` 在搜索工具和 JSON Schema 同请求时跳过搜索的问题；
- 单任务固定最多 2 次 xAI 请求，并记录 Grok 批次数、帖子数和真实搜索工具调用数；
- Grok Provider 失败必须进入“部分完成”或“失败”，不得降级为“暂无样本”。

## 4. 历史行情终态

批次终态收敛为：

| 状态 | 含义 |
|---|---|
| `completed` | 所有唯一 CA 都获得完整入场价和最高价，且没有未说明的源失败 |
| `no_samples` | 数据源读取成功且覆盖完整，但没有可确认 CA |
| `partial` | 已有部分可用结果，但采样、Grok 或部分价格不完整 |
| `price_retry` | GMGN 超时、网络异常或 429，本轮熔断并等待重试 |
| `price_unavailable` | 有可确认 CA，但 GMGN 成功响应后没有可用 K 线；不冒充“已完成” |
| `failed` | 数据源或 Grok 完全失败，没有任何可用结果 |

GMGN 仍使用去重、缓存、全局调度和每 CA 间隔。空 K 线不进行紧密自动重试，429 必须遵循 `reset_at`。

### 4.1 关注事件解析边界

关注模式的数据源与解析源必须分开：

1. 事件列表只来自 `x_activities` 中系统已经观察并落库的 Follow 行为；
2. 对应目标已有 P21 `follow-research-v1` 结果时直接复用，不新增 Provider 调用；
3. 仅当已观察目标缺少解析结果时，才允许 Grok 研究该目标公开资料中的项目、链和 CA，并由 RPC 完成只读核验；
4. Grok 不提供 Following List、关注时间或新增关注关系，不能用来补采 Baseline 以前的历史关注；
5. 该流程只写研究表，不生成 Signal、Trade Intent、Order 或 Position。

## 5. 前端必须可解释

每个批次除收益指标外，必须显示：

- 真实采样起止和覆盖完整性；
- 原帖、引用帖和回复的数量；
- 本地直接解析 CA 数、送入 Grok 帖子数和 Grok 批次数；
- 无 CA、Grok 失败、GMGN 超时和 GMGN 空行情的不同原因；
- 关注模式的文案明确为“已监听关注表现”，不暗示可以回溯未监听的关注历史。

账号画像必须与帖子/关注分析使用相同的持久化体验：

- 后端提供按创建时间倒序的画像历史列表；
- 前端进入画像页后自动恢复最新批次，并允许切换历史批次；
- 新建、轮询完成和整页刷新后都重新读取持久化结果；
- 已完成、进行中和失败结果均不得只保存在 React 内存中。

## 6. 验收标准

### 6.1 自动化

1. 6551 日期参数透传、饱和窗口分割、本地精确截断和去重。
2. 明确 CA 不调用 Grok；自然语言项目帖子会进入 Grok 批量分析。
3. 原帖不会被回复挤出 Grok 候选。
4. Provider 失败、无 CA、空 K 线、429/超时对应不同终态。
5. 后端完整测试、前端 lint/build 和页面 DOM 回归全部通过。

### 6.2 真实只读验收

至少使用 3 组真实账号/模式：

1. 一个无有效 CA 的高活跃账号：必须展示真实采样诊断，Grok 实际参与，结果可解释。
2. 一个有明确 CA 的帖子账号：必须产出唯一 CA 明细，并正确显示 GMGN 价格成功或不可用原因。
3. 一个已有真实 Follow 落库事件的账号：必须从 Follow 事件进入唯一 CA 和价格回放。
4. 至少一次独立 Grok 账号画像真实返回身份、摘要和公开证据。

验收过程必须核对 GMGN 审计：只允许 `GET /v1/market/token_kline`，不得出现 Quote、Swap、Order，不得改变 Engine 状态或产生真实交易。

## 7. 2026-08-15 本地真实只读验收

### 7.1 真实 Provider 批次

| 模式 | 账号 / 批次 | 真实结果 |
|---|---|---|
| 高活跃无 CA 帖子 | `@0xMoon` / `10` | 7 天内 155 条真实帖子；6551 3 次；Grok 10 帖、2 次 xAI 请求、10 次真实搜索；Provider 失败 0；正确终态 `no_samples` |
| 明确 CA 帖子 | `@ltchives` / `11` | 30 天内 177 条真实帖子；16 次 CA 提及、6 个唯一 BSC CA；6 个均完成 GMGN 回放；胜率 100%，平均 `1.69x`，中位 `1.27x`，最高 `3.56x`；终态 `completed` |
| 已监听关注事件 | `@xueqiu88` / `2` | 读取真实 Follow 事件 `@xueqiu88 -> @juggernautrh`；Robinhood CA `0xd7321801caae694090694ff55a9323139f043b88`；入场价 `0.002207601`、最高价 `0.0050382403`、最高倍数 `2.282x`；终态 `completed` |
| 独立账号画像 | `@cookerflips` / `1` | Grok 画像真实搜索完成；账号类型 `kol`；12 条公开证据；返回摘要、关联关系和风险评级；终态 `completed` |

`@ltchives` 示例 CA `0x244b112cf746e62a5df723cbde9906a6defd7777`：入场价 `0.0012033806`，最高价 `0.0042888599`，最高倍数 `3.564x`。

### 7.2 前端恢复验收

1. 重启本地 P26 supervisor 后整页刷新 `http://127.0.0.1:5182/kol`。
2. 重新进入“账号研究 -> 账号画像”，页面自动恢复画像批次 `1`。
3. DOM 中可见 `@cookerflips`、`KOL`、摘要、关联关系和公开证据，不再显示空白初始态。
4. 帖子批次 `11` 的 177 条帖子、6 个 CA、`3.56x`，以及关注批次 `2` 的 Robinhood CA、`2.28x` 均在重启后重新读取成功。
5. 桌面视口截图通过，历史侧栏、统计区和逐 CA 表格无明显重叠。

### 7.3 安全与调用审计

- Schema 只读审计：`SCHEMA_AUDIT_OK=xbot;MODE=production-readonly`。
- 12 小时审计窗口内，`kol_performance_replay` 共记录 23 次请求，全部为 `GET /v1/market/token_kline`。
- 前期本地网络问题留下 2 次无 HTTP 状态记录，网络恢复后 21 次为 HTTP 200；GMGN 429 为 0。
- 全局审计将这 23 次请求全部归类为 `research`；未知请求、未授权买入、Swap 幂等异常均为 0。
- 未调用 Quote、Swap、Order；未创建交易信号、意图、订单或持仓。
- 验收结束时数据库状态为 `status=stopped`、`desired_running=false`；页面显示“已停止”。

## 8. 逐 CA 进度协议与终态消歧

### 8.1 持久化协议

运行进度写入 `kol_performance_runs.metrics.progress`，不新增表、不修改交易域，也不增加 Provider 请求。Worker 在本地阶段边界写入：

- `source_loading` / `event_loading`：正在读取帖子或已监听关注事件；
- `ca_extraction`：正在完成本地 CA 提取与 Grok 识别；
- `pricing`：按资产顺序写入当前 `current_asset_index`、链、完整 CA、Token 和开始时间；
- 每个 CA 结束后写入 `processed_assets`、`successful_assets`、`unavailable_assets` 和最后结果；
- `paused` / `finished`：清空当前 CA，并保存最终数量和结束时间。

重试行情前必须清除旧 `metrics.progress`，避免把上一次当前 CA 误显示为本次进度。缓存命中仍按相同顺序更新本地进度，但不得为了让动画停留而延迟任务或重复调用 GMGN。

### 8.2 前端语义

1. `pending`、`extracting`、`pricing` 才属于运行态，显示 Spinner、已运行时间和最后更新时间。
2. 采样与识别阶段只显示“阶段 1/2”，使用不定进度动画，不展示伪造百分比。
3. 行情阶段显示真实的 `处理中 N/总数`、成功/缺失数量、链和完整 CA；逐 CA 表格同步高亮当前行。
4. `completed`、`partial`、`no_samples`、`price_unavailable`、`failed` 都是终态，必须显示完成时间、总耗时和“任务已结束，不会继续运行”。
5. `price_retry` 是已暂停终态，必须由用户明确发起“重试行情”后才重新进入队列。

### 8.3 2026-08-15 进度验收

- 真实帖子批次 `@trixina731 / 14`：29 条帖子、3 个唯一 CA；先显示采样阶段，再显示 `正在处理 CA 1/3`、Solana 和完整 CA；最终 2 个 CA 回放成功、1 个无有效行情，终态 `partial`。
- 批次创建于 `16:19:06`，完成于 `16:20:15`，真实总耗时约 1 分 8 秒；页面明确显示完成时间、总耗时和任务不会继续运行。
- 同一窗口 GMGN 审计只有 3 次 `GET /v1/market/token_kline`，全部 HTTP 200，429 为 0；没有 Quote、Swap 或 Order。
- 自动化验证 Worker 严格按 `1/3 -> 2/3 -> 3/3` 持久化当前 CA，完成后 `processed=3` 且 `current_asset_id=null`。
- 清理 P32 不可达 Worker/回测后，后端当前全量测试 `603/603`、前端 lint/build、生产只读 Schema 审计和 `git diff --check` 全部通过。
- Schema Drift 检查使用 `/api/kol` 路径边界，不再把 `/api/kol-performance` 或 `/api/kol-research` 误判为 `KolAccount` 响应。
