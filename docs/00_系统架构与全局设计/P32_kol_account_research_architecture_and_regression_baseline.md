# P32 KOL 账号投研架构与防回归基线

> 版本：v1.1
>
> 日期：2026-08-14
>
> 状态：HISTORICAL BASELINE / SUPERSEDED BY P33-P34
>
> 适用范围：`KOL -> 账号研究`、Grok 账号研究、关注策略历史表现、6551 帖子样本、GMGN K 线回测、研究结果展示与发布验收
>
> 继承关系：继承 P20 的历史量化指标和 P21 的 Grok 官方搜索能力；本文件取代 P31 对“账号研究算法保持不变”的临时描述。P31 的终态详情、失败可见性和 Research 调度修复仍然有效。
>
> 收口记录（2026-08-15）：P33/P34 已接管帖子表现、关注表现和账号画像的新任务。P32 只保留历史 GET 查询；旧组合 Worker、回测实现和写入 Repository 已从发布包移除。

## 1. 为什么必须单独建立 P32

XBOT 先后出现过三类名称相近但职责不同的研究能力：

1. P16 固定 CA 快速投研：从已知 `chain + CA` 出发，补充代币事实、官方账号和核心人物。
2. P20 账号清洗与历史回测：从 X Handle 出发，读取历史帖子，计算直接意图率、CA 解析率和历史表现。
3. P21 新关注发现研究：6551 只提供实时 Follow 事件，Grok 直接搜索目标账号、项目关系、CA、链和证据。

P21 将 P20 的账号清洗页面移动到 KOL 二级页签并命名为“账号研究”，但 P21 后续又为 Follow Resolver 建立了独立的 Grok 直接搜索链路。相同名称对应不同实现，导致后续维护发生以下混乱：

- 把 P20 的 6551 历史回测误认为 P21 的 Grok 账号发现；
- 把 6551 帖子样本作为 Grok 的主要输入，削弱 Grok 自己的 X 搜索能力；
- 只恢复 P20 回测结果可见性，却被误认为恢复了完整 KOL 投研；
- 只保留 Grok 搜索时又丢失样本数、解析率和历史胜率；
- GMGN K 线失败或 429 时，页面显示“完成”或“继续观察”，但实际没有有效量化数据。

P32 的目标不是继续叠加逻辑，而是固定一条长期可维护的产品和代码边界。

## 2. 最终产品定义

KOL 账号投研是一个只读、异步、三分支研究工具：

```text
输入一个或多个 X Handle
  |
  +-- 分支 A：Grok 直接账号研究
  |     -> 官方 xAI Responses API
  |     -> x_search + web_search
  |     -> 身份、项目关系、CA、链、内容特点、风险、证据和 citations
  |
  +-- 分支 B：关注策略表现
  |     -> 读取系统真实观察到的 Follow 事件和 P21 自然语言解析结果
  |     -> 按唯一 chain + CA 合并并过滤未满 24h 的样本
  |     -> GMGN 仅查询命中 CA 的历史 1m K 线
  |     -> 关注事件数、CA 触发率、24h 胜率和逐 CA 倍数
  |
  +-- 分支 C：帖子喊单表现
        -> 6551 获取账号历史帖子
        -> 本地 Intent / CA / 上下文解析
        -> GMGN 仅查询成功匹配 CA 的历史 1m K 线
        -> 样本数、直接意图率、CA 解析率、歧义率、24h 胜率和逐 CA 倍数
  |
  +-- 结果聚合
        -> 三个分支分别显示状态、结果和失败原因
        -> 生成研究建议，但不自动创建策略、Watch、Signal 或交易
```

三个分支可以分阶段并行执行，但不得互相冒充：

- Grok 分支失败，不得删除已经完成的量化结果；
- 关注事件、6551 或 GMGN 分支失败，不得删除已经完成的其他分支结果；
- 只有部分数据时，批次必须显示 `partial`，不能显示完整成功；
- 零有效量化样本时只能显示“数据不足”，不能显示“继续观察”或任何胜率结论。

## 3. Provider 职责边界

### 3.1 Grok / xAI

Grok 负责直接研究账号，不负责计算确定性历史收益：

- 生产环境只允许官方 `https://api.x.ai/v1/responses`；
- 默认模型 `grok-4.5`，`reasoning_effort=low`；
- 必须开放 `x_search + web_search`，并验证至少发生一次搜索工具调用；
- 输入以目标 Handle 和自然语言研究任务为主；
- 不把 6551 帖子语料作为 Grok 搜索的前置条件；
- 提示词不得包含 GMGN、交易授权、实盘执行或本地程序门禁；
- 多个 CA 必须全部返回并标明来源，不允许为了得到唯一结果而猜测或删除冲突候选。

Grok 输出至少包含：

```text
account_type
summary
project_name / project_handle
relationship
candidate_contracts[]
  chain_id
  address
  confidence
  evidence_ids[]
evidence[]
citations[]
style_tags[]
strengths[]
risks[]
prompt_version / model / duration_ms / usage
```

设置页必须可以维护 KOL 账号研究提示词。KOL 账号研究提示词与 Follow 快速发现提示词可以共享底层配置和审计机制，但必须有独立字段和版本，避免修改关注策略提示词时无意改变历史投研结果。

### 3.2 6551

6551 在 KOL 投研中只负责提供可回放的历史帖子样本：

- 按 Handle 获取历史帖子和原始时间；
- 保留原创、回复、引用和转发的作者边界；
- 由本地代码判断 Intent、完整 CA、Cashtag、Hashtag 和项目词条；
- 不负责账号身份结论、项目关系推测或历史收益计算；
- 投研查询不创建远端 Watch，不影响已有 Watch 计划；
- 6551 分页、漏帖、限流和时间范围必须成为量化分支的显式证据状态。

P21 对 Follow Resolver 的限制保持不变：Follow CA 发现主路径不能重新退回 6551 Tweets。P32 允许 6551 历史帖子仅因为 KOL 页面需要量化回测，两者不是同一业务路径。

### 3.3 GMGN

GMGN 在 KOL 投研中只负责成功匹配样本的历史市场数据：

- 允许调用历史 K 线接口；
- 按 `chain + CA + event_time + interval` 去重和缓存；
- 不调用 Token Info、Security、Pool、Gas、Quote、Swap、Order 或交易查询；
- 不为没有完整 CA 或链仍歧义的帖子发起 K 线请求；
- 不为同一批次重复查询相同的历史样本；
- 所有请求经过共享调度器，优先级低于真实交易；
- 真实交易队列、Trade Lease 或 GMGN 429 冷却存在时暂停新 K 线研究，不阻塞交易。

默认每个账号最多尝试 `12` 个历史收益样本，可配置范围为 `1-30`。达到上限必须显示“本次样本上限”，不能假装已经覆盖账号全部历史。

## 4. 量化指标契约

所有指标必须记录 `metric_version`、时间范围、样本上限、分母和 Provider 覆盖状态。任何分母、阈值、收益窗口或推荐算法变化都必须升级版本，不能静默修改旧结果。

### 4.1 当前必须保留的指标

| 字段 | 定义 |
|---|---|
| `sample_size` | 6551 返回并通过基础规范化的帖子总数 |
| `asset_posts` | 本地解析到 CA、Ticker、Hashtag 或项目词条的帖子数 |
| `explicit_ca_posts` | 正文中包含完整 CA 的帖子数 |
| `direct_intent_rate` | 明确直接意图帖子数 / `max(1, sample_size)` |
| `ca_resolution_rate` | 唯一解析成功帖子数 / `max(1, sample_size)` |
| `ambiguity_rate` | 多候选未消歧帖子数 / `max(1, sample_size)` |
| `provider_coverage_rate` | 找到历史候选覆盖的帖子数 / `max(1, sample_size)` |
| `return_samples` | 成功取得有效历史 K 线并计算收益的样本数 |
| `win_rate_24h` | `return_24h_pct > 0` 的样本数 / `return_samples` |
| `median_return_24h_pct` | 有效样本 24 小时收益中位数 |
| `median_max_gain_24h_pct` | 有效样本 24 小时内最大涨幅中位数 |

### 4.2 “胜率”的准确含义

当前代码字段 `executable_win_rate` 实际计算的是：

```text
24 小时收盘收益为正的样本数 / 有效 K 线样本数
```

它不是按账号当前止盈止损模板、滑点、Gas 和分批离场计算的真实策略净胜率。P32 实施时必须执行以下二选一，不允许继续模糊显示：

1. 保留当前算法，API 使用 `win_rate_24h`，前端显示“24h 胜率”；
2. 新增真实策略回放后，另行提供 `strategy_win_rate` 和 `strategy_net_return`。

第一阶段采用方案 1，避免在本轮修复中暗中扩大交易模拟范围。

### 4.3 推荐结论

推荐结论只用于人工研究，不是交易授权。第一阶段保持版本化基线：

- 唯一解析数为 `0`，或有效收益样本少于 `3`：`insufficient_data`；
- CA 解析率至少 `30%` 且有效收益样本至少 `5`：`approve_for_record`；
- 其余有有效数据的账号：`watch`；
- Grok 发现的风险和项目关系作为独立证据展示，不得悄悄改写量化结论；
- 任何结论都不能自动进入 Record、Paper 或 Live。

## 5. 统一结果契约

前后端只依赖一份账号研究结果，不再把历史字段散落在顶层：

```json
{
  "handle": "example",
  "status": "completed|partial|failed",
  "grok": {
    "status": "completed|failed",
    "result": {},
    "error": null
  },
  "follow_performance": {
    "status": "completed|deferred|failed",
    "metric_version": "follow-performance-v1",
    "metrics": {},
    "return_snapshot": {},
    "error": null
  },
  "performance": {
    "status": "completed|deferred|failed",
    "metric_version": "kol-post-performance-v2",
    "sample_window": {},
    "metrics": {},
    "return_snapshot": {},
    "provider_state": {},
    "error": null
  },
  "recommendation": "approve_for_record|watch|insufficient_data",
  "completed_at": "ISO-8601"
}
```

旧 `x_actor_screening_*` 表可以作为历史数据保留，但新运行时必须通过独立 Account Research 服务投影稳定契约。旧 P20 结果不得混入新版本批次统计；若继续复用旧表，必须用 `research_revision` 隔离并只通过 Repository 访问。

## 6. 前端展示标准

KOL 页面的“账号研究”保持左侧批次、右侧结果结构，每个账号必须显示三个独立区域。

### 6.1 顶部摘要

- 输入账号数；
- 完成账号数；
- 找到 CA 的账号数；
- 批次状态。

### 6.2 Grok 账号研究

- 账号类型和身份；
- 项目名称及关联官方账号；
- 候选 `chain + CA`；
- 内容特点、优势和风险；
- 原始证据摘录和可点击 citations；
- 模型、提示词版本和耗时；
- 无结果、证据冲突和 Provider 错误分别显示。

### 6.3 关注策略表现

- 真实关注事件、解析 CA、唯一 CA 和有效 K 线样本；
- CA 触发率、24h 胜率、24h 收盘倍数中位数和最高倍数中位数；
- 每个目标账号、完整 `chain + CA`、入场价、24h 价格、收盘倍数和最高倍数；
- 未满 24h、重复 CA、GMGN 冷却和样本上限分别显示。

### 6.4 帖子喊单表现

- 帖子样本、资产内容、完整 CA 和有效 K 线样本；
- 直接意图率、CA 解析率、歧义率和 Provider 覆盖率；
- 24h 胜率、24h 收盘倍数中位数和最高倍数中位数；
- 每个有效帖子的完整 `chain + CA`、入场价、24h 价格、收盘倍数和最高倍数；
- 研究时间范围、样本上限、实际 K 线尝试次数；
- GMGN 冷却时显示预计续跑时间，不能显示为完整成功。

页面读取只访问本地 REST 和 PostgreSQL，不在页面刷新、切换批次或展开详情时调用 Grok、6551 或 GMGN。

## 7. 已发现问题与禁止事项

### 7.1 已发现问题

1. P20“账号清洗”和 P21“账号研究”同名，导致模块职责混淆。
2. P31 只修复结果详情契约和调度，却被误认为恢复了完整研究算法。
3. Grok 曾只接收 6551 帖子样本并据此分析，没有形成真正独立的 X 搜索研究。
4. 6551 零帖子或零 CA 时仍生成 `watch`，用户看到“继续观察”但没有任何有效证据。
5. GMGN K 线 429、超时或空结果时，父批次状态和前端提示不够准确。
6. Grok Promise 提前失败时曾可能产生未处理 rejection，或等待 K 线结束后才暴露错误。
7. 摘要对象曾被前端当成详情对象，终态批次显示完成但结果表为空。
8. Engine 运行状态曾被错误当成 Research 永久门禁，使只读投研在实盘期间永远不领取。
9. “胜率”字段名称没有解释 24h 正收益口径，容易被理解为真实策略胜率。

### 7.2 明确禁止

- 禁止把 KOL 投研改成只有 Grok、删除量化指标；
- 禁止把 KOL 投研改成只有 6551/GMGN、删除 Grok 账号研究；
- 禁止将 6551 帖子作为 Grok 搜索的必需前置输入；
- 禁止让 Grok 计算或编造历史胜率；
- 禁止把 GMGN K 线失败解释成账号表现差；
- 禁止页面刷新触发任何外部 Provider 请求；
- 禁止账号投研调用 Quote、Swap、Order 或改变 Engine；
- 禁止零样本显示 `watch`、`approve` 或百分比 `0%`；
- 禁止研究任务失败停止固定 CA、动态喊单、关注策略或全局 Engine；
- 禁止在没有版本升级和回归样本的情况下修改指标分母、推荐阈值或收益窗口。

## 8. 429、重试和性能标准

1. Grok 与关注策略表现并行启动；关注分支结束后再分配帖子分支 K 线预算，任何分支失败都要保存其他分支结果。
2. Grok 快速搜索最多一次，证据缺失或歧义时最多补充一次；同一重试任务复用已经成功的 Grok 结果。
3. GMGN K 线按唯一历史样本去重，单账号单轮总计最多 `12` 次尝试；存在关注 CA 时按关注 `8`、帖子 `4` 分配，没有关注 CA 时帖子可使用 `12` 次。
4. GMGN 429、共享冷却和容量等待进入 `deferred + retry_at`，不忙循环。
5. 续跑只执行未完成的 K 线样本，不重新拉取已经固化的 6551 样本，也不重复调用 Grok。
6. 真实交易优先级始终高于 Research；Research 暂停不能阻塞 Signal、Quote、Swap、Order Query 或平仓。
7. 投研日志记录 Provider、阶段、耗时、调用数和错误码，不记录 API Key、完整 Provider 响应或用户 Secret。

## 9. 历史代码所有权目标

P32 当时的模块边界为：

```text
backend/domains/account-research/
  service.js              批次、详情、重试和统一结果契约
  worker.js               三分支编排、Provider 预算、租约和状态聚合
  grok-research.js        直接官方 xAI 搜索，不接 6551 帖子语料
  follow-performance-research.js 真实 Follow 事件、P21 解析结果和 GMGN K 线
  performance-research.js 6551 帖子样本、本地解析和 GMGN K 线
  return-metrics.js       两个市场分支共享的 1m 价格和倍数算法
  repository.js           隔离旧表名和持久化细节
  routes.js               /api/account-research
```

P34 收口后，`account-research` 只保留历史 GET 查询、Repository 隔离和 Grok 画像；两种表现分析、K 线工具和新 Worker 均归属 `domains/kol-performance/`。上述 P32 组合 Worker 结构仅作历史设计记录。

共享能力仍复用：

- `domains/research/xai-client.js`：xAI HTTP、错误分类、usage 清洗；
- `follow-discovery/prompt-service.js` 的版本化配置模式；
- 6551 Client 的历史帖子读取；
- GMGN 共享 Scheduler、Rate State 和 K 线 Cache；
- 本地 Intent、CA 和 chain 解析器。

旧 `actor-screening` 运行模块在新链路验收后退出 Server、路由和前端引用。历史 Migration 和数据不做破坏性删除。

## 10. 测试与验收标准

### 10.1 自动化

- Grok 请求体只包含 Handle 和自然语言研究任务，不包含 6551 帖子语料；
- Grok 必须配置 `x_search + web_search` 并校验工具调用；
- 量化分支在没有 Grok 时仍能完成；
- Grok 分支在 6551 或 GMGN 失败时仍能展示；
- 零帖子、零 CA、歧义 CA、无 K 线、部分 K 线和达到样本上限均有明确状态；
- 24h 胜率计算、收益中位数、分母和最小样本阈值有固定夹具；
- GMGN 调用数不超过上限，重复 CA 样本命中缓存；
- 429 后保存 Grok 和已完成 K 线结果，按 `retry_at` 续跑；
- Route、类型和前端字段使用同一契约；
- 测试期间 Quote、Swap、Order 调用次数必须为 `0`；
- 后端全量、前端 lint/build、`git diff --check` 和 Release Audit 通过。

### 10.2 DOM

- 桌面和移动端均显示三个研究分支；
- 长 Handle、完整 Solana/EVM CA、长错误文案和 citations 不溢出；
- 运行、部分完成、失败、数据不足和 GMGN 延迟续跑状态不重叠；
- 切换历史终态批次后结果不消失；
- 页面刷新不产生 Provider 调用增量。

### 10.3 真实只读验收

选择至少一个历史已知答案账号：

1. Grok 真实调用返回身份、项目关系、CA、链和 citations；
2. 6551 返回非零历史样本或明确的 Provider 空结果；
3. GMGN 只查询命中样本的 K 线，不产生 Quote、Swap 或 Order；
4. 页面显示样本数、解析率、24h 胜率和 Grok 证据；
5. GMGN 审计确认调用数量有界、没有新增异常 429；
6. Engine 和三策略运行意图不因创建、重试或查看投研任务而变化。

## 11. 发布边界

P32 会修改后端领域、REST 契约和前端，因此按 P29 **B 类完整应用发布**执行：

- 本地完整测试、前端构建和 DOM 回归；
- 最终 SHA Release/Secret Audit；
- GitHub 分支和不可变 production tag；
- xiexiu 备份、预构建、Schema Audit、原子切换和双角色验收；
- 部署不等于启动实盘，发布流程不得擅自恢复 Engine；
- 生产账号研究只读验收不能调用真实交易。

## 12. 当前状态

截至 2026-08-14：

- 三分支 Account Research 领域、统一 REST 契约、前端结果面板和旧表 Repository 隔离已经完成；
- xAI 官方接口支持可选 `XAI_PROXY_URL` 传输代理；代理只作用于 xAI，不影响 6551、GMGN 或交易请求；
- xAI 在严格结构化请求中跳过搜索时，自动进入“公开搜索 -> 结构化整理”两阶段流程；两阶段仍由 Grok 完成，且必须验证真实搜索调用；
- 真实只读账号 `@cookerflips` 验收完成：Grok 搜索调用 `27` 次、证据 `14` 条、候选 CA `2` 个；历史分支复用 `100` 条帖子；
- 本次真实验收没有调用 GMGN K 线、Quote、Swap 或 Order，没有修改 Engine 和三策略运行意图；
- 后端全量测试 `582/582`、前端 lint/build、DOM 回归和 `git diff --check` 已通过；
- 当前分支尚未提交、推送或部署到 xiexiu，不能作为生产发布版本。

## 13. P32.1 关注策略表现与精确 CA 倍数修订

### 13.1 修订原因

P32 v1.0 将“账号研究”的量化部分定义为 KOL 历史帖子回测，但实际产品的主要用途是判断该 KOL 是否适合启用“新关注发现策略”。帖子喊单表现可以保留，但不能代替以下问题：

```text
该 KOL 被系统真实观察到多少次新关注
  -> 其中多少目标账号经 P21 Grok 自然语言研究解析出唯一 CA
  -> 去重后有多少个唯一 CA
  -> 这些 CA 在关注触发后 24h 的收盘倍数、最高倍数和胜率是多少
```

因此账号研究正式调整为三个相互独立的只读分支：

1. `Grok 账号研究`：研究 KOL 本人的身份、公开活动、关联项目和证据；
2. `关注策略表现`：复用已落库的真实 Follow 事件和 P21 解析结果，计算关注触发 CA 表现；
3. `帖子喊单表现`：保留 6551 历史帖子、意图、CA 解析和市场表现回测。

### 13.2 历史自然语言提示词

关注事件的目标账号解析继续复用 P21 `follow-research-v1`，默认任务是：

```text
请快速检索 X 账号 @{{target_handle}} 的项目关联信息，找出最可信的完整 CA、所属区块链、代币名称和官方来源。

优先查看该账号的 Bio、置顶、原创内容和官网。如果它是创始人、CEO 或核心成员，请追溯关联的官方项目账号，再从官方来源确认 CA。如果发现多个 CA，请列出来源并区分主次；证据不足时不要猜测。
```

账号历史统计不得再次批量调用 Grok。它只读取 `follow_discovery_events` 中已经由该提示词生成并审核过的事件结果；这既保持历史审计口径，也避免重复 xAI 请求。

### 13.3 关注策略统计口径

| 指标 | 定义 |
|---|---|
| `follow_event_count` | 系统在选定时间范围内真实观察并进入关注策略处理的 Follow 事件数 |
| `resolved_ca_event_count` | 状态为 `resolved` 且存在规范化 `chain + CA` 的事件数 |
| `unique_ca_trigger_count` | 按 `chain + CA` 去重后的触发资产数 |
| `ca_trigger_rate` | `resolved_ca_event_count / follow_event_count` |
| `return_samples` | 已满 24h 且取得有效 GMGN K 线的唯一 CA 数 |
| `win_rate_24h` | `return_24h_pct > 0` 的样本数 / `return_samples` |
| `close_multiple_24h` | 24h 收盘基准价 / 统一入场基准价 |
| `max_multiple_24h` | 24h 窗口最高价 / 统一入场基准价 |

Baseline 中没有真实 Follow 时间的当前关注列表不得进入收益统计。未满 24h 的事件显示等待窗口，不得使用当前价格冒充完整 24h 样本。相同 CA 由多个目标账号关联时只保留最早一次触发，避免重复项目关系放大胜率分母。

### 13.4 精确倍数基准

帖子和关注策略两个市场表现分支统一使用单次 GMGN `1m` K 线请求：

```text
事件时间
  -> 事件所在分钟的首个可用 1m 收盘价作为入场基准
  -> 事件后 24h 窗口最后一个可用 1m 收盘价作为 24h 收盘价
  -> 同一窗口最高价作为 24h 最高价
```

每个有效样本必须持久化并向前端返回 `entry_price`、`close_price_24h`、`high_price_24h`、`entry_candle_at`、`close_candle_at`、`close_multiple_24h`、`max_multiple_24h`、收益百分比和完整 `chain + CA`。页面同时显示每个 CA 的收盘倍数和最高倍数，不再只显示聚合中位数。

该口径是统一的市场基准，不是实际成交滑点后的净收益；若后续需要真实策略净胜率，必须另建基于 Trade/Receipt 的指标版本，不能静默改写本口径。

### 13.5 GMGN 调用边界

- 有关注触发样本时，关注分支优先，最多查询 `8` 个唯一 CA；帖子分支最多查询 `4` 个样本；单账号单轮总上限仍为 `12` 次；
- 没有关注触发样本时，关注分支调用 GMGN `0` 次，帖子分支可使用原有 `12` 次上限；
- 重试复用已保存的事件快照和有效 K 线结果，只续跑缺失样本；
- 429 进入共享冷却和 `deferred + retry_at`，不得阻塞真实交易；
- 页面查看、刷新和切换批次只读取本地 REST，不调用 Grok、6551 或 GMGN；
- 账号研究仍然禁止 Quote、Swap、Order 和 Engine 状态修改。

### 13.6 P32.1 验收增量

- 固定夹具覆盖乱序 1m K 线、入场价、24h 价格、收盘倍数和最高倍数；
- 固定夹具覆盖 Follow 事件总数、解析率、重复 CA 合并、未满 24h 和胜率分母；
- 三分支任一失败时，另外两个已完成分支仍持久化并显示；
- 分支持久化异常时必须收束并行 Promise，不允许产生未处理 rejection；
- 桌面与移动端显示关注策略主分支，以及 Grok 和帖子两个辅助分支；
- P32.1 在真实只读复验和 DOM 验收完成前不得部署到 xiexiu。

### 13.7 GMGN 异常熔断

- 关注策略表现与帖子喊单表现遇到首个可重试的 GMGN 超时、网络错误或限流后，必须立即停止本轮剩余 K 线请求；
- 已成功的 K 线样本继续落库；未请求样本记为 `kline_deferred`，后续自动续跑时复用成功样本；
- 单个 Provider 异常窗口内，每个研究分支每轮最多产生一次失败请求，禁止按 CA 数量连续打满样本预算；
- 前端使用“等待行情”描述该状态，不能把网络超时一概显示为“容量繁忙”。

### 13.8 真实只读复验记录

2026-08-14 使用 `@xueqiu88` 完成关注策略主分支复验：

- 真实关注事件 `40` 条，解析出唯一 CA 的事件 `15` 条，按 `chain + CA` 合并为 `13` 个唯一资产；
- Grok 账号研究正常完成并返回身份、关联项目和公开证据；
- 本机当时对 `openapi.gmgn.ai` 的 DNS/网络路径异常，GMGN K 线和策略订单查询均为 `GMGN_REQUEST_TIMEOUT`，没有出现 429；因此本轮不能伪造 24h 胜率或 CA 倍数；
- 熔断前关注/帖子分支分别连续尝试 `8/4` 次；熔断后人工重试分别只尝试 `1/1` 次，并明确显示剩余样本停止请求；
- 本次复验没有调用 Quote、Swap 或 Order，没有改变 Engine 和三策略运行意图；
- 后端全量测试 `586/586`、前端 lint/build、Release Audit、桌面 DOM 和控制台检查通过。

GMGN 网络恢复后，必须重新重试该批次，确认逐 CA 的 `entry_price`、`close_price_24h`、`high_price_24h`、收盘倍数和最高倍数真实返回，才能完成市场表现分支验收。
