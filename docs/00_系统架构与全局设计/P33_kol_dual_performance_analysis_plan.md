# P33 KOL 双独立表现分析方案

> 状态：IMPLEMENTED / LOCAL LIVE READ-ONLY ACCEPTED / GITHUB AND XIEXIU RELEASE PENDING

> 范围：`KOL -> 账号研究` 的产品重构。P33 只改只读投研、历史行情回放和展示契约；不改变固定 CA、动态喊单、关注策略的实时交易链路，不调用 Quote、Swap、Order，不修改 Engine 状态。

> 实施记录（2026-08-14）：已新增 P33 迁移 `050_p33_kol_performance_analysis.sql` 并应用到本地 `xbot` 数据库；帖子喊单、关注策略和账号画像已拆为独立 API/Worker。P32 仅保留历史只读查询，不再保留前端写入口。专项与完整后端测试、前端 lint/build、正式页面三入口和 390px 窄屏布局均已验证。
>
> 收口记录（2026-08-15）：P34 真实只读验收完成后，已移除 P32 不再可达的组合 Worker、旧帖子/关注回测和写入 Repository；历史 P32 GET 查询与 Grok 画像能力继续保留。帖子、关注和画像均已完成真实本地只读验收，当前只待 GitHub 发布与 xiexiu 部署。

## 1. 决策

现有 P32 将 Grok 账号画像、帖子喊单回测和关注发现回测放进同一批次。三个数据源、完成条件和结果口径不同，导致页面的“部分完成”“发现 CA”无法表达实际含义。

P33 将账号研究拆成三项独立工具，其中前两项是独立的可选回测，不会同批执行：

1. **帖子喊单分析**：分析 KOL 自己发布的帖子中出现的 CA。
2. **关注策略分析**：分析该 KOL 被系统实际观察到的“关注新账号”事件所解析出的 CA。
3. **账号画像**：保留 Grok 账号身份、关联项目和公开证据研究，作为独立手动动作，不参与任何收益统计。

默认入口为两个分段选项：`帖子喊单分析` 和 `关注策略分析`。用户选择哪一个，后端只启动对应模式的任务；Grok 画像不会被自动附带执行。

## 2. 两种分析的业务口径

| 项目 | 帖子喊单分析 | 关注策略分析 |
|---|---|---|
| 研究对象 | KOL 自己的帖子 | KOL 实际关注的新账号 |
| 触发时间 | 6551 返回的帖子创建时间 | `follow_discovery_events.provider_created_at` |
| CA 来源 | 帖子中的作者自有完整 CA；必要时由针对该帖的 Grok 自然语言证据补齐 | `x_activities` 中已观察的 Follow 事件；优先复用 P21 `follow-research-v1`，缺失时只对已知目标账号调用 Grok，并做链上只读核验 |
| 去重规则 | 同一 `chain + CA` 保留最早一次有效喊单 | 同一 `chain + CA` 保留最早一次真实关注触发 |
| 入场价格 | 事件时间后的首个可用 1m K 线收盘价 | 事件时间后的首个可用 1m K 线收盘价 |
| 最高价格 | 从触发时间到本次回测截止时间的最高 K 线 `high` | 从触发时间到本次回测截止时间的最高 K 线 `high` |
| 实际最高倍数 | `最高价格 / 入场价格` | `最高价格 / 入场价格` |
| 胜率 | `最高倍数 > 1.00x` 的有效唯一 CA 数 / 有效唯一 CA 数 | 同左 |

### 2.1 为什么胜率使用 `最高倍数 > 1.00x`

用户要求保留胜率，但不应设置 2x、50% 等人为阈值。因此 P33 的胜率是一个纯事实指标：触发之后是否曾出现过高于触发价的价格。每个 CA 的真实最高倍数完整展示，胜率不筛除、不修正、不替代倍数。

### 2.2 回测截止时间

“后续最高点”必须有审计边界。每次运行创建不可变 `as_of_at`：

```text
触发时间 -> 首个 1m 收盘价（入场价）
          -> 从触发时间至 as_of_at 的最高价（最高倍数）
```

默认 `as_of_at` 是启动任务时的当前时间。重新回测创建新批次，而不是静默改写旧结果。页面显示“截至时间”和每个 CA 的最高价出现时间。

## 3. 数据与自然语言链路

### 3.1 帖子喊单分析

```text
用户选择“帖子喊单分析”并输入 KOL
  -> 6551 读取该 KOL 的原帖、回复、引用帖历史快照
  -> 本地内容提取器识别作者自有完整 CA
  -> 对没有完整 CA、但具有明确项目喊单语义的帖子：
       Grok 只读取该帖、Bio、置顶、官方关联账号和官网
       返回 chain + 完整 CA + 原始证据链接
  -> 合并、链校验、按 chain + CA 去重
  -> GMGN 只读 K 线回放
  -> 保存帖子、CA、价格、倍数和证据
```

Grok 提示词不包含 GMGN、买入、交易、风控或本地程序指令。它仅解决自然语言实体识别问题：这条帖子是否在表达该项目，以及可证实的 `chain + CA` 是什么。

建议提示词：

```text
分析 X 账号 @{kol_handle} 在以下原帖中的项目喊单信息。
只提取作者明确关联、且有公开证据支持的代币完整合约地址和所属链。
优先使用原帖、Bio、置顶、项目官方账号和官网；如帖子只包含名称或代号，
必须通过官方来源交叉确认。无法确认时返回 no_match，禁止猜测。
返回：tweet_id、chain、contract_address、token_name、symbol、evidence_url、evidence_excerpt。
```

### 3.2 关注策略分析

```text
用户选择“关注策略分析”并输入 KOL
  -> 从 x_activities 读取该 KOL 已落库的 Follow 行为
  -> 优先复用 P21 follow-research-v1 的 chain + CA + Grok 证据
  -> 对尚无解析结果的已观察目标账号：
       Grok 研究其公开项目关联、CA 和链
       RPC 做合约/代币只读核验
  -> 按 chain + CA 去重，保留最早触发
  -> GMGN 只读 K 线回放
  -> 保存关注目标、CA、价格、倍数和原始证据
```

该模式分析的是系统实际看到并记录的关注事件。Grok 只能研究事件中已经明确的目标账号，不负责发现、猜测或补齐 KOL 未被系统监听的历史关注列表。没有事件时正常完成并显示“暂无已观察到的关注事件”。

### 3.3 账号画像

账号画像保留独立入口，使用现有 KOL 自然语言研究提示词。它只产出身份、角色、关联项目和 citations；候选 CA 只在画像中展示，永远不进入帖子或关注表现的分母。

## 4. GMGN 历史价格回放

P33 将历史价格回放抽为一个只读、可缓存的服务，两个模式共用，但不共享任务或统计结果。

1. **入场价**：一次小窗口 `1m` K 线请求，取触发后首个可用收盘价。
2. **最高价**：从入场 K 线开始到 `as_of_at` 查询长周期 K 线。使用 K 线的 `high` 字段，聚合最大值；首日保持 `1m` 精度，后续可使用小时 K 线分段回放，避免把触发前同一根 K 线的高点计入结果。
3. **长区间**：按 GMGN 返回上限分段请求，所有分段以 `chain + CA + from + to + resolution` 缓存和审计。
4. **回放结果**：必须保存 `entry_price`、`entry_candle_at`、`peak_price`、`peak_candle_at`、`peak_multiple`、`as_of_at` 和 Provider 请求版本。

GMGN 调用边界：

- 一个模式的一个唯一 CA 最多需要一次入场查询和一组受限的峰值查询；
- 同一批次先由数据库按 `run_id + chain + CA` 去重，只保留最早触发事件进入价格回放；
- 同资产、同触发时间、同截止时间只复用缓存，不重复请求；
- 缓存命中直接返回；真实 Provider 请求默认全局至少间隔 `1000ms`，同一 `chain + CA` 至少间隔 `2000ms`；
- 间隔可通过 `KOL_PERFORMANCE_GMGN_GLOBAL_INTERVAL_MS` 和 `KOL_PERFORMANCE_GMGN_CA_INTERVAL_MS` 保守增大，不能绕过共享 Weighted Scheduler 和跨进程共享限流；
- 出现 429、网络异常或超时后，本模式本轮立即停止剩余 GMGN 请求，保持 `行情待重试`；
- 实盘交易、平仓和保护订单始终高于研究队列优先级；
- 绝不调用 GMGN Quote、Swap、Order、Wallet 或 Token Security 接口。

## 5. 数据模型与 API

P33 不再向 `x_actor_screening_*` 继续叠加三分支 JSON。新增独立、模式明确的运行时对象：

```text
kol_performance_runs
  id, mode(post_calls|follow_discovery), actor_handle,
  sample_started_at, sample_ended_at, as_of_at,
  status, metrics, created_at, completed_at

kol_performance_events
  run_id, source_type, source_id, source_occurred_at,
  source_url, target_handle, extraction_status, evidence_json

kol_performance_assets
  run_id, first_event_id, chain_id, contract_address,
  token_name, token_symbol, entry_price, entry_candle_at,
  peak_price, peak_candle_at, peak_multiple, price_status,
  provider_snapshot, created_at
```

建议 API：

| API | 用途 |
|---|---|
| `POST /api/kol-performance/post-runs` | 创建帖子喊单分析 |
| `POST /api/kol-performance/follow-runs` | 创建关注策略分析 |
| `GET /api/kol-performance/runs?mode=` | 读取当前模式批次列表 |
| `GET /api/kol-performance/runs/:id` | 读取统计、事件和逐 CA 回放 |
| `POST /api/kol-performance/runs/:id/retry-price` | 只重试缺失的价格回放 |
| `POST /api/kol-research/profile-runs` | 独立创建 Grok 账号画像 |

两个模式分别维护 `status`。禁止再生成跨模式的“部分完成”总状态。

## 6. 状态和统计

### 6.1 状态

| 状态 | 含义 |
|---|---|
| `准备中` | 已创建，尚未读取数据源 |
| `解析 CA` | 正在解析帖子或已落库关注事件 |
| `回放价格` | 正在读取 GMGN K 线 |
| `已完成` | 数据源和所有可回放 CA 已完成 |
| `暂无样本` | 数据源读取成功，但没有符合当前模式的事件或 CA |
| `行情待重试` | 有 CA，但 GMGN 当前不可用；保留已完成结果，停止后续调用 |
| `失败` | 本地数据或 Provider 契约出现不可恢复错误 |

### 6.2 汇总指标

每个模式统一显示：

- 原始事件数；
- 解析成功 CA 数；
- 去重后唯一 CA 数；
- 有效价格 CA 数；
- 胜率：`peak_multiple > 1.00`；
- 平均最高倍数、中位最高倍数、最高最高倍数；
- 当前批次 `as_of_at`；
- 缺失价格数量和原因。

逐 CA 列表必须展示来源、触发时间、链、CA、入场价、最高价、最高倍数、最高点时间和证据链接。不能用“发现 CA”混指 Grok 画像候选、帖子 CA 或关注 CA。

## 7. 前端设计

入口仍在 `KOL -> 账号研究`，但页面顶部改为稳定的分段控制：

```text
[ 帖子喊单分析 ] [ 关注策略分析 ]                         [ 账号画像 ]
```

- 每个模式有自己的左侧历史批次，不互相混合；
- 中间工作区仅展示当前模式的输入、状态和统计；
- 统计区采用紧凑的八项指标网格；
- 下方采用可排序逐 CA 表格，倍数以视觉上升/回撤标记辅助扫描，但完整数字不缩写；
- “账号画像”是单独页面或抽屉，只显示自然语言研究和 citations；
- “暂无样本”和“行情待重试”是明确结果，不显示“部分完成”。

静态设计审核阶段曾使用两张 P33 HTML 预览页。正式 React 页面验收后已删除这些临时预览资产，不进入 GitHub 正式代码或服务器发布包。

## 8. 迭代顺序

1. 审核两张 P33 HTML 预览，确认统计、胜率定义、列顺序和术语。
2. 新增 P33 迁移、Repository、两种模式的独立 Worker 和 REST 契约。
3. 将 P32 的 Grok 画像抽出为单独动作；历史 P32 批次只读保留，不迁移为 P33 统计。
4. 实现历史价格回放缓存、分段 K 线和 GMGN 异常熔断。
5. 实现前端双模式页面和逐 CA 可审计表格。
6. 覆盖 CA 去重、入场价、最高价、胜率、零样本、价格重试、GMGN 上限和无交易调用的自动化测试。
7. 已完成两种模式和独立账号画像的真实本地只读验收；确认没有 Quote、Swap、Order 或 Engine 状态写入后，进入 GitHub 与 xiexiu 发布流程。

## 9. 验收条件

### 9.0 当前已验证

- 本地数据库已应用 `050_p33_kol_performance_analysis.sql`；迁移仅新增 P33 研究和缓存表；
- `node --test --test-concurrency=1`：599/599 通过；P33 专项及 P31/P32 边界：20/20 通过；
- `npm.cmd run lint` 与 `npm.cmd run build` 通过；
- 正式 `KOL -> 账号研究` 页面三入口均可切换，P33 API 不再返回 404；
- 390px 宽度下没有页面横向溢出，指标区域按两列排列；
- 已完成帖子模式 6 个 BSC CA、关注模式 1 个 Robinhood CA 的真实 GMGN K 线只读回放；调用仅为 `GET /v1/market/token_kline`，429 为 0；
- 自动测试证明真实请求默认全局间隔不低于 `1000ms`、同一 CA 不低于 `2000ms`，配置只能增大间隔，缓存命中不占用等待窗口；

- 帖子模式与关注模式不会同批执行，也不会互相污染统计；
- 胜率只以 `peak_multiple > 1.00` 计算，分母只包含有完整价格回放的唯一 CA；
- 每个 CA 的倍数能追溯到触发时间、入场 K 线、最高 K 线和 `as_of_at`；
- 无关注事件显示“暂无样本”，不是失败或部分完成；
- GMGN 异常时每个模式本轮最多一次失败请求，且不影响三策略交易；
- 账号画像不会自动产生 GMGN K 线请求；
- P33 全程只读，零真实交易。
