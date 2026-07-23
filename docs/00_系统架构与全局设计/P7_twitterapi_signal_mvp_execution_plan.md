# P7 TwitterAPI.io 真实信号 MVP 执行方案

> 文档编号：P7  
> 创建日期：2026-07-21  
> 更新日期：2026-07-21  
> 文档状态：P7 Followings 真实 MVP 已完成，待付费 Tweet Stream 与 Tweet 类真实事件验收  
> 上位方案：[P6 从快速原型到真实运行的更新迭代方案](./P6_real_operation_iteration_plan.md)  
> 核心目标：先完成真实 X 行为到交易信号的可验证闭环，不触发真实买入

---

## 一、这份方案解决什么问题

P1-P5 是项目历史交接、开发规范和审计文档，其 `DONE` 只表示原型代码已经形成，不等于真实运行已经验收。P6 是从原型走向真实运行的长期路线，本 P7 是基于 2026-07-20 至 2026-07-21 的实际 API 测试，为下一轮开发整理出的短周期执行方案。

本轮只解决一条核心链路：

```text
白名单 CA + 项目 X
  -> 真实检测 KOL 行为
  -> 标准化 x_activities
  -> 匹配 trade_signals
  -> 前端可查看和审计
  -> signal 模式不创建持仓、不调用交易 API
```

本轮不以“代码存在”为完成标准，而以真实行为能够稳定、唯一、可解释地生成信号为完成标准。

### 1.1 2026-07-21 执行进度

| 里程碑 | 代码状态 | 真实验收状态 |
|---|---|---|
| M0 安全锁定 | 已完成 | `signal + locked` 已由数据库和自动化测试确认 |
| M1 模式隔离 | 已完成 | Signal-only 已验证；Paper/Live 仍需后续连续运行验收 |
| M2 TwitterAPI.io Provider | 已完成 | Key 可用；当前 Provider 仍为 `socialdata`，未产生付费请求 |
| M3 Followings 闭环 | 已完成 | 真实 baseline、首次新增关注、取消与重关去重全部通过 |
| M4 Tweet Webhook | 核心闭环已完成 | 标准 payload、`fast_tweet`、鉴权、时间窗、重放幂等已测试；Stream 套餐、公开回调和断线补偿待验收 |
| M5 自动化与可观测性 | 已完成本地部分 | 后端 14 项测试、前端构建、schema/env 自检通过；24 小时运行待执行 |
| M6 真实 MVP | 进行中 | Followings 延迟、成本和幂等已实测；Tweet Stream 套餐与真实 Tweet 类事件待执行 |
| M7 交接 | 未开始 | 在 M6 真实验收后执行 |

`X_DATA_PROVIDER` 已人工切换为 `twitterapi`，但不会启用 Stream/Follow Cron，也不会调用 GMGN。当前仅允许有界人工请求；持续 API 消费必须单独确认预算后再开启。

---

## 二、当前已验证状态

### 2.1 运行与安全状态

| 项目 | 当前状态 | 说明 |
|---|---|---|
| 前端 | 运行于 `http://127.0.0.1:5173` | 生产构建、页面请求和 API 代理通过 |
| 后端 | 运行于 `http://127.0.0.1:3011` | 默认仅监听本机；健康 200，未授权 API/WS 均返回 401 |
| PostgreSQL | 正常 | KOL、白名单可读写 |
| `TRADING_MODE` | `signal` | Signal-only 终态不创建持仓 |
| `X_DATA_PROVIDER` | `twitterapi` | 已切换正式 Provider；周期 Follow Cron 仍关闭 |
| 交易引擎 | `armed=false` | 在 P7 全部完成前禁止 Arm |
| 真实交易 | 禁止 | 不测试广播、买入、卖出或 TP/SL |

本轮启动后的黑盒结果：`mode=signal`、`armed=false`、TwitterAPI.io `credits=1036/50000`、估算 `$0.01036`、`circuit_open=false`。只注册了每日 Budget Reset，Timeline、Follow、Matcher、Price 和 Order Cron 继续关闭。

### 2.1.1 真实 Followings 验收记录

2026-07-21 已通过正式 Provider 完成以下步骤：

1. 关系探针确认 `wanshenme -> neet_sol=false`，响应约 `967ms`。
2. Profile 返回 `following_count=66`，确认完整 baseline 只需 1 页。
3. 完整 baseline 写入 66 条 `x_follow_seen`，使用 198 Credits；Activity、Signal、Position 均为 0。
4. 随后每 60 秒执行增量检查，前两次 `new_count=0`，第三次发现 `neet_sol`。
5. 新增一条 Follow Activity 和一条 `NEET` Signal；Signal 为 `execution_mode=signal/status=signal_only`，Position 为 0。
6. 观察窗口为 `09:24:04.440Z -> 09:25:06.173Z`；本次只能证明在一个 60 秒轮询窗口内发现，不能把观察结束时间当作真实关注时间。
7. Live/Paper 的预算和买入次数均保持 0，无 GMGN 调用、签名、广播或资金变化。
8. 取消关注后关系探针返回 `false`，取消后的增量快照为 `new_count=0`。
9. 重新关注后关系探针返回 `true`，后续三个真实增量周期均为 `new_count=0/matched_signals=0`。
10. 最终数据库保持 Activity=1、Signal=1、`x_follow_signal_once`=1、Position=0，证明取消后重关不会重复触发。

当前真实请求合计 13 次、1036 Credits、估算 `$0.01036`、0 个 Provider 错误。Followings 真实 MVP 已完成。

### 2.2 已配置的测试数据

| 类型 | 数据 | 状态 |
|---|---|---|
| KOL | `wanshenme` | 已入库，enabled |
| 项目 1 | `blackbullsol` | 已绑定白名单 |
| CA 1 | `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump` | Solana，symbol=`ANSEM` |
| 项目 2 | `neet_sol` | 已绑定白名单 ID `2` |
| CA 2 | `Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump` | Solana，symbol=`NEET` |

测试预算沿用当前开发配置：单次 `0.005 SOL`、每条白名单总额 `0.02 SOL`。这些预算在本轮不会用于真实交易。

### 2.3 TwitterAPI.io 实测结果

已验证接口：

```http
GET https://api.twitterapi.io/twitter/user/check_follow_relationship
X-API-Key: <secret>

source_user_name=wanshenme
target_user_name=neet_sol
```

实测结论：

- API Key 有效，返回结构包含 `data.following`。
- 单次响应约 `0.8-1.2s`。
- 免费层限制为每 5 秒最多一次请求。
- 连续按 5.2 秒调用仍可能偶发 `HTTP 429`。
- 测试脚本已调整为默认 6 秒，并对 `429` 自动退避。
- `wanshenme -> blackbullsol` 保留原探针结果；`wanshenme -> neet_sol` 已从 `false` 变为真实关注并生成一次 Signal-only 信号。

成本与性能判断：

- 关注关系接口每次 100 credits，即 `$0.001/次`。
- 免费层适合验证 1-2 个关系的 MVP，不适合几十个账号长期运行。
- 单关系按 6 秒全天轮询约 14,400 次请求，生产成本和限流风险不可接受。
- 官方给出的 REST API 平均响应时间约 700ms；付费自助账户按余额最高 20 QPS，但这不等于 Follow 数据刷新延迟。
- 官方未公布 Follow 数据源刷新 SLA，因此目标延迟 300ms-1s 不能依靠关注关系轮询承诺。

### 2.4 最终 Provider 架构决策

P7 不再把 `check_follow_relationship` 逐关系高频轮询作为生产方案。最终采用“推送为主、按 KOL 聚合轮询为辅、本地匹配”的混合架构：

```text
TwitterAPI.io Tweet Stream/Webhook
  -> 仅订阅 enabled KOL
  -> tweet/retweet/reply/quote 到达时推送
  -> XBOT 本地匹配项目账号、完整 CA 和完整关键词

TwitterAPI.io Get User Followings
  -> 每个 enabled KOL 建立一次完整基线
  -> 运行期默认每 60 秒拉取最新 Followings
  -> XBOT 本地与所有项目账号和 CA 绑定关系做差异匹配
```

生产决策：

- Tweet、Retweet、Reply、Quote 和直接发帖提及使用 Webhook，静默期间不轮询。
- Webhook 不提供 Follow 事件；Follow 使用 `/twitter/user/followings`，按 KOL 聚合查询，不按 `KOL × 项目账号` 逐关系查询。
- `check_follow_relationship` 仅保留为探针、人工复核和 Provider 合约测试，不进入生产高频主链路。
- Provider 监控名额按 KOL 计算；项目账号、CA 和绑定关系均在本地匹配，不占 Stream 名额。
- 当前默认 Follow 间隔为 60 秒；完成真实刷新延迟测试后，才允许评估 30 秒。不得配置为 1 秒高频生产轮询。
- Follow 发生时间只能记录为两次观察之间的时间区间，不伪造 X 的真实关注时间。

已核实的速度与费用基线：

| 能力 | 官方指标/价格 | 当前决策 |
|---|---|---|
| REST API | 平均响应约 700ms；付费自助最高 20 QPS | 不作为 Follow 刷新 SLA |
| Tweet Stream | 50% 小于 500ms；80% 小于 1s；99.9% uptime | Tweet 类生产主链路 |
| Stream Starter | `$29/月`，最多 6 个 KOL | 当前 MVP/初期正式方案 |
| Followings 最新 20 条 | 最低 60 credits，即 `$0.0006/次` | 每 KOL 默认 60 秒一次 |
| 当前 1 个 KOL 的 Follow | 60 秒轮询约 `$25.92/月` | 设置 Credits 硬上限 |
| 当前合计 | Stream `$29` + Follow 约 `$25.92` | 约 `$54.92/月` |

若 Follow 改为 30 秒，当前 1 个 KOL 的预计总成本约 `$80.84/月`。增加项目账号或 CA 不增加上述费用；增加 KOL 会增加 Follow 请求量，Stream 则按套餐名额扩容。

官方依据：

- [TwitterAPI.io QPS Limits](https://twitterapi.io/qps-limits)
- [TwitterAPI.io Pricing](https://twitterapi.io/pricing)
- [TwitterAPI.io Tweet Stream](https://twitterapi.io/twitter-stream)
- [Check Follow Relationship](https://docs.twitterapi.io/api-reference/endpoint/check_follow_relationship)
- [Get User Followings](https://docs.twitterapi.io/api-reference/endpoint/get_user_followings)

### 2.5 本地多对多匹配与幂等决策

- 一个项目 X 账号允许绑定多个 CA；一个 CA 也允许绑定多个项目 X 账号。
- 一个 Provider 事件先标准化为一条 `x_activity`，再按所有命中的 distinct CA fan-out 为多条 `trade_signal`。
- Tweet 类信号使用 `provider_event_id + ca_id + match_type` 作为幂等边界；同一条推文可以命中多个 CA，但同一 CA 不重复生成相同信号。
- Follow 关系第一次从未见变为新见时才生成活动；取消关注不生成信号，取消后重新关注也不重新生成。
- 为避免多个项目账号绑定同一个 CA 导致重复买入，Follow 信号额外按 `kol_id + ca_id` 永久去重。
- 初始基线内已经存在的所有 Followings 只登记为 `seen`，不生成历史活动或信号。

---

## 三、代码现状与阻塞项

### 3.1 可复用能力

- `ca_whitelist.project_x_handles` 已支持一个 CA 绑定多个项目 X 账号。
- `x_activities` 已能保存 `follow/tweet/retweet/quote/reply` 等活动。
- Matcher 已支持三种匹配：项目 handle、CA、symbol 关键词。
- 推文解析已支持 mention、retweet 原作者、quote 原作者和 reply 对象。
- 数据库已有活动和信号唯一约束，可继续加固幂等。

### 3.2 原阻塞项关闭情况

原审计发现的 11 项阻塞已在本轮代码中关闭：TwitterAPI.io 已成为正式 Provider；Follow 与 Webhook 都可直接写活动并即时匹配；`signal/paper/live` 已分流；Signal-only 不进入 Risk/GMGN；Paper 使用独立预算；生产模块中的随机交易和 Mock fallback 已移除；危险 Cron 默认关闭；前端与 `check-env` 已支持 TwitterAPI.io。

当前剩余阻塞不是代码主链路，而是外部运行条件：Stream 套餐、公开 HTTPS Webhook、Webhook Secret、Provider 切换、每日 Credits 预算，以及真实 X 行为的延迟/稳定性验收。

---

## 四、按依赖排序的执行计划

## M0：恢复检查与安全锁定

**目标**：确认开发恢复后不会误触发交易。

工作项：

- [ ] 启动前先冻结 Timeline、Follow、Matcher、Price 和 Order Cron，只按 M0-M5 逐项恢复。
- [ ] 检查前端、后端、PostgreSQL 状态。
- [ ] 检查 `TRADING_MODE`，只输出模式，不输出任何密钥。
- [ ] 确认 `engine_armed=false`。
- [ ] 确认两条白名单和 KOL 数据仍存在。
- [ ] 确认没有遗留的监控测试进程。
- [ ] 备份数据库结构和当前关键配置清单，密钥正文不进入文档或 Git。

退出标准：引擎未武装、无真实交易进程、测试数据完整。

预计时间：30 分钟。

---

## M1：实现 `signal/paper/live` 最小模式隔离

**目标**：任何真实 X 事件进入系统时，都不可能因为已有 GMGN Key 而调用真实交易。

工作项：

- [ ] 新增统一的运行模式读取与校验模块。
- [ ] `TRADING_MODE` 只允许 `signal`、`paper`、`live`。
- [ ] 默认模式改为 `signal`，未知值启动失败。
- [ ] 为信号增加不可执行的 Signal-only 终态和 `execution_mode`；历史 Signal-only 信号切换模式后也不得被执行。
- [ ] `signal-matcher` 按模式分流：
  - `signal`：生成并保留信号，不创建持仓。
  - `paper`：调用 `paperEngine`。
  - `live`：只有 Readiness 通过且 Armed 时才调用 `tradeEngine`。
- [ ] `price-monitor` 按持仓 `execution_mode` 分流，不再根据 GMGN Key 判断。
- [ ] `signal` 模式完全绕过 Risk Manager、GMGN 行情/报价和所有交易方法。
- [ ] Matcher 只领取当前模式明确允许执行且未过期的状态，不再扫描全部 `recorded` 信号。
- [ ] Paper 使用独立预算和计数，不修改 Live 的 `spent_budget/current_buy_count`。
- [ ] 配置保存或 Provider 变化后自动 Disarm。
- [ ] 服务重启后 Live 默认保持 Locked。
- [ ] 为三个模式添加自动化测试。

退出标准：

- `signal` 模式下即使 GMGN Key 存在，也不会调用任何交易方法。
- `paper` 持仓不会进入真实卖出方法。
- `live` 未通过门禁时无法执行。

预计时间：2-4 小时。

---

## M2：将 TwitterAPI.io 接入正式 X Provider

**目标**：从独立测试脚本升级为同时支持 Followings REST 和 Tweet Webhook、可计费、可限流、可观测的正式 Provider。

工作项：

- [ ] 新增 `TwitterApiIoXClient`，封装 Followings、关系探针和必要的补偿查询，复用统一的 handle 规范化逻辑。
- [ ] 支持 `X_DATA_PROVIDER=twitterapi`。
- [ ] 缺少 Key 时失败关闭，禁止自动回退 Mock。
- [ ] 前端 Provider 下拉框、配置保存白名单和 `check-env` 同步支持 `twitterapi`。
- [ ] 实现统一请求超时、错误分类、延迟记录和 JSON Schema 检查。
- [ ] 限流按整个 API Key 全局执行：免费层默认最小间隔 6 秒；付费层按配置 QPS 且不得超过账户实际额度。
- [ ] 增加每小时/每日 calls、credits 和 USD 估算指标，并设置软告警、硬上限和自动熔断。
- [ ] 对 `401/403/429/500/timeout` 分别处理。
- [ ] `429` 读取 `Retry-After`，否则执行递增退避。
- [ ] 日志只记录 endpoint、HTTP 状态、延迟和账号，不记录 API Key。
- [ ] 保留独立探针脚本用于 Provider 合约回归测试。

退出标准：正式 Provider 能返回 Followings 快照和可审计的计费指标，错误、超额或限流时不产生虚假活动。

预计时间：2-4 小时。

---

## M3：Followings 快照到信号的真实 MVP

**目标**：用一次 KOL 查询覆盖全部项目账号，完成 `new following -> x_activities -> trade_signals` 闭环。

建议新增状态表：

```text
x_follow_seen
- kol_id
- target_x_user_id
- target_x_handle
- first_seen_at
- first_seen_poll_id
- was_in_baseline
- UNIQUE(kol_id, target_x_user_id)

x_follow_signal_once
- kol_id
- ca_id
- source_target_x_handle
- first_activity_id
- triggered_at
- UNIQUE(kol_id, ca_id)

x_follow_poll_runs
- id
- kol_id
- started_at
- completed_at
- page_count
- returned_count
- credits_used
- status
- last_error
```

工作项：

- [ ] 首次启用 KOL 时按 `pageSize=200` 分页获取完整 Followings，全部写为 baseline，禁止生成历史活动。
- [ ] 运行期默认每 60 秒按 `pageSize=20` 拉取最新 Followings；一个 KOL 一次查询覆盖全部项目账号。
- [ ] 从第一页向后查找持久化的已知边界；若第一页没有任何已见账号，则继续分页，避免短时间新增超过 20 个关注时漏事件。
- [ ] 达到最大补充分页数仍未找到边界时标记 `gap_detected`、告警并暂停生成不确定信号。
- [ ] 新出现的账号先写入 `x_follow_seen`，再与本地项目账号和 CA 多对多绑定做匹配。
- [ ] baseline、新增账号、活动和一次性 Follow 信号均使用数据库事务和唯一约束防并发重复。
- [ ] 取消关注不删除 `x_follow_seen`；重新关注仍视为已见，不重新生成 Follow 活动或信号。
- [ ] 一个新关注可对绑定的多个 distinct CA fan-out；同一 `kol_id + ca_id` 永久只生成一次 Follow 信号。
- [ ] 记录 `previous_poll_at`、`observed_at` 和 observation window，不伪造真实 Follow 时间。
- [ ] Job 使用全局 Credits 硬上限、并发锁和单 KOL lease，禁止重叠轮询。

人工验收步骤：

1. 对 `wanshenme` 执行完整 baseline，确认不生成历史 activity/signal。
2. 启动默认 60 秒 Followings Job。
3. 用户使用 `wanshenme` 关注 `neet_sol`。
4. 在两个轮询周期内观察是否出现新 Following，并单独记录 Provider 数据刷新延迟。
5. 数据库只新增一条 follow activity，并对命中的 distinct CA 生成幂等 signal。
6. 用户取消后重新关注 `neet_sol`，确认不新增 activity/signal。
7. 增加“一个项目账号绑定多个 CA”和“多个项目账号绑定同一 CA”测试，确认 fan-out 正确且同 CA 不重复。
8. 前端信号日志可看到 KOL、项目账号、CA、观察时间区间、Provider 延迟和检测延迟。
9. `positions`、交易请求和钱包余额均无变化。

退出标准：真实新增关注可被聚合快照稳定发现；baseline、重复轮询、取消后重关、分页缺口和并发执行均不产生重复或不确定信号。

预计时间：3-5 小时。

---

## M4：推文、转发、回复、引用和直接提及

**目标**：覆盖 PRD 定义的全部互动条件。

工作项：

- [ ] 以 TwitterAPI.io Tweet Stream 订阅 enabled KOL，项目账号和 CA 不进入 Provider 订阅列表。
- [ ] Webhook 作为主传输，WebSocket 作为诊断或备选传输；静默期间不调用 Timeline 轮询。
- [ ] 验证 Provider 是否提供签名；没有签名能力时必须使用共享密钥路径、网关鉴权或等价保护，禁止开放匿名事件入口。
- [ ] Webhook 落库前校验时间窗、事件 ID 和 payload schema，防止伪造、重放和畸形数据。
- [ ] 实现失败重试、死信记录、断线重连、健康检查、游标/水位恢复和短窗口 Timeline 补偿。
- [ ] 记录账号加入 Stream 到真正 active 的状态；未完成 Provider onboarding 时前端不得显示为正常监控。
- [ ] 保存真实 `source_created_at`，禁止使用入库时间代替发布时间。
- [ ] 首次 Timeline 同步只建立游标，不处理历史推文。
- [ ] 标准化活动类型：`tweet`、`retweet`、`quote`、`reply`。
- [ ] 从 API 元数据提取互动对象，不只解析可见文本。
- [ ] 直接发帖继续匹配完整 CA 和完整单词关键词，例如 `NEET`、`ANSEM`。
- [ ] 每条 Provider 事件建立稳定 `provider_event_id` 并防重复。
- [ ] 增加信号最大年龄，过期内容只归档不触发。

人工测试矩阵：

| 行为 | 预期匹配 |
|---|---|
| 关注 `neet_sol` | `handle_match` |
| 转发 `neet_sol` 推文 | `handle_match` |
| 回复 `neet_sol` | `handle_match` |
| 引用 `neet_sol` 推文 | `handle_match` |
| 发帖包含完整 CA 2 | `ca_mention` |
| 发帖包含完整单词 `NEET` | `ticker_mention` |
| 发帖包含相似但非完整单词 | 不匹配 |

退出标准：六类测试全部唯一、准确、可追溯，不产生持仓。

预计时间：1-1.5 天，包含 Webhook 安全、恢复和补偿测试。

---

## M5：真实数据 Paper 闭环

**目标**：在真实 X 数据和真实 GMGN 只读行情下创建模拟持仓。

工作项：

- [ ] 对 GMGN `token_info`、安全、报价接口做当前凭证合约测试。
- [ ] 对响应建立字段校验，缺少价格或安全字段时拒绝 Paper 开仓。
- [ ] 切换 `TRADING_MODE=paper`。
- [ ] 由真实信号调用 `paperEngine`。
- [ ] 持仓明确标记 `execution_mode=paper`。
- [ ] 前端展示信号来源、活动类型、Provider 延迟、模拟入场价和拒绝原因。
- [ ] 验证 TP/SL 只能调用 Paper 平仓。
- [ ] 验证重复信号和 Cron 并发不会创建重复持仓。

退出标准：真实 X 行为产生一笔可解释的 Paper 持仓，全程无签名、广播和资金变化。

预计时间：1 天。

---

## M6：付费 Provider 上线与观测

**目标**：按已确认架构购买最小额度并用真实数据验证速度、费用和稳定性，不进入真实交易。

执行项：

- [ ] M0-M4 代码、测试和安全门禁完成后，再购买 Stream Starter `$29/月`；当前套餐最多覆盖 6 个 KOL。
- [ ] REST Credits 首次只充值 `$10`，配置每日和每月硬上限，禁止自动无限充值。
- [ ] 先用不超过 `$2` 的预算对比 `check_follow_relationship` 与 Followings 快照的真实刷新延迟。
- [ ] Follow 默认保持 60 秒；只有成本、刷新延迟和漏检测试通过后，才评审 30 秒。
- [ ] 分别记录 Provider 发布时间、Webhook 到达、入库、匹配和 signal 创建时间，输出 P50/P80/P95/P99。
- [ ] 连续记录 Stream 可用率、重复率、Webhook 重试、Follow gap、429、calls 和 credits。
- [ ] Stream 故障时进入告警与补偿模式，不自动切换为高频 REST 轮询。
- [ ] Follow 数据刷新仍不满足需求时，启动独立 Follow Event Provider 选型；不得用逐关系 1 秒轮询兜底。

退出标准：Tweet 类达到可接受的亚秒/秒级实测表现，Follow 延迟和月成本有真实样本，Provider 中断不会造成重复信号或失控费用。

---

## M7：回到 P6 的 Paper 与 Live 路线

P7 完成后回到 P6：

1. 连续运行真实数据 Paper 3-7 天。
2. 统计信号命中率、误报、延迟、API 错误和模拟收益。
3. 完成交易幂等、链上确认、对账、预算和告警。
4. Readiness 全部通过后，才允许进入 Solana 小额 Live。
5. 首笔 Live 不超过 `0.005 SOL`，完成买入和卖出闭环后再评估扩容。

---

## 五、明日工作顺序

明日严格按以下顺序执行，不并行开启真实交易相关工作：

1. **恢复检查**：服务、数据库、Armed、模式、测试数据。
2. **模式隔离**：先保证真实 X 事件不会进入交易引擎。
3. **自动化测试**：验证 `signal/paper/live` 三模式路由。
4. **Provider 接入**：将 TwitterAPI.io Followings REST 和 Tweet Webhook 接入正式 Provider。
5. **状态表与 migration**：实现完整 baseline、永久 seen、Follow 一次性信号和 poll run 审计。
6. **正式 Followings Job**：按 KOL 聚合轮询，默认 60 秒并启用费用熔断。
7. **Tweet Webhook**：完成鉴权、幂等、重放防护、重试与补偿。
8. **端到端测试**：依次验证 `wanshenme` 的 Follow、Retweet、Reply、Quote、CA 和关键词。
9. **多对多测试**：验证一个项目账号多 CA、多个项目账号同 CA。
10. **数据核验**：activity、signal、前端日志、无持仓、无资金变化。
11. **付费观测**：代码门禁通过后才购买最小套餐并记录延迟、请求数、credits 和异常。

当日最低交付物：

- 模式隔离代码与测试。
- TwitterAPI.io Followings REST 与 Tweet Webhook 正式 Provider。
- Follow baseline/seen/once/poll-run migrations。
- 一次真实关注到唯一信号及取消后重关不触发的端到端记录。
- 一次 Tweet Webhook 到本地多对多 signal 的端到端记录。

---

## 5.1 6551 Pro 真实能力与容量测算（2026-07-21）

本节中的“监控账号数”统一指 `KOL 账号 + 去重后的项目 X 账号`。如果 50 仅指 KOL，仍需加上项目账号数量后重新计算。

### 真实合约测试

| 测试项 | 结果 | 延迟/计费 | 判定 |
|---|---|---|---|
| `twitter_kol_followers(neet_sol)` | HTTP 200，返回 34 个可识别账号，未命中 `wanshenme` | 359ms，响应包含 usage | 普通查询可用，但该接口不能替代任意 KOL 的实时关注事件 |
| `twitter_user_tweets(wanshenme)` | HTTP 200，返回 15 条 | 1291ms，1 point | Pro REST 可用 |
| `twitter_follower_events(neet_sol)` | HTTP 200，返回 20 条 | 194ms，1 point | Pro REST 可用；后续 100 条复查仍未发现此前的 `wanshenme` 关注事件 |
| `twitter_watch` | HTTP 403 | `please upgrade to a higher plan` | Pro 无 Watch 权限 |
| `twitter_watch_add(wanshenme)` | HTTP 403 | 未新增、未产生 Watch 新增费用 | Pro 无自定义监控权限 |
| `twitter_wss` | 握手失败 | 实时流未建立 | 与消费规则中仅 Max 可用一致 |

结论：当前 Pro 只能作为 REST 查询/补偿数据源，不能作为 300ms-1s 实时信号主链路。自定义 Watch、`NEW_FOLLOWER` 和 Tweet WebSocket 需要 Max 或供应商另行开通权限。

2026-07-21 Pro 阶段曾使用一次性矩阵脚本复测 12 项：10 项成功、Watch 按套餐预期返回 403、Retweet Users 返回 HTTP 400，确认扣费 8 points。成功项包括 Profile、User by ID、User Tweets、Search、Follow Events、Unfollow Events、Deleted Tweets、KOL Followers、Tweet by ID 和 Quote Tweets。Retweet Users 又使用另一条公开推文单独复测，仍返回 `query failed, please try again later`，因此当前不可作为补偿接口；实时 Max 的 `NEW_RETWEET` 仍需独立验收。升级 Max 后该付费 Pro 一次性脚本已退役，历史结果保留在本文档中。

### Pro REST 轮询用量

推文或 follower events 每个账号每轮至少 1 point；1 point 对应 20 messages。若每个账号每轮只调用一个主接口：

```text
points/day = 账号数 * 86400 / 轮询间隔秒数
messages/day = points/day * 20
```

| 轮询间隔 | 50 账号 points/day | 50 账号 messages/day | 200 账号 points/day | 200 账号 messages/day |
|---|---:|---:|---:|---:|
| 300ms | 14,400,000 | 288,000,000 | 57,600,000 | 1,152,000,000 |
| 1s | 4,320,000 | 86,400,000 | 17,280,000 | 345,600,000 |
| 60s | 72,000 | 1,440,000 | 288,000 | 5,760,000 |
| 1h | 1,200 | 24,000 | 4,800 | 96,000 |

Pro 基础额度为 10,000 points/月（200,000 messages/月），另有每日 5 points。按基础额度保守计算，50 个账号约每 3.6 小时才能轮询一次，200 个账号约每 14.4 小时一次；若每个账号同时查推文和 follower events，消耗再翻倍。因此 Pro 轮询不满足实时交易要求。

### Max Watch + WSS 用量

根据当前消费规则，Watch 新增为一次性 10 points/账号，删除免费；WSS 按每 20 条推送消息消耗 1 point。静默账号不产生持续轮询成本，生产环境只维持一个主 WSS 连接。

| 总监控账号 | 首次 Watch 成本 | 平均 10 事件/账号/日 | 平均 50 事件/账号/日 | 平均 100 事件/账号/日 |
|---|---:|---:|---:|---:|
| 50 | 500 points（10,000 messages） | 500 messages / 25 points/day | 2,500 / 125 points/day | 5,000 / 250 points/day |
| 200 | 2,000 points（40,000 messages） | 2,000 messages / 100 points/day | 10,000 / 500 points/day | 20,000 / 1,000 points/day |

Max 明确支持最多 600 个自定义监控账号。按消费规则，WSS 静默连接没有按时长扣费，生产单连接可 24x7 常驻；每增加一个并行 WSS 连接都可能重复计算推送消耗，因此只允许一个主连接。

首次添加账号后，50 账号剩余 99,500 points，200 账号剩余 98,000 points。按推送消息累计每 20 条消耗 1 point，理论耗尽时间如下；超过 30 天表示可完整覆盖当月，次月额度重置后继续运行：

| 平均事件/账号/日 | 50 账号耗尽时间 | 200 账号耗尽时间 |
|---:|---:|---:|
| 100 | 398 天 | 98 天 |
| 300 | 132.7 天 | 32.7 天 |
| 500 | 79.6 天 | 19.6 天 |
| 1,000 | 39.8 天 | 9.8 天 |

要完整覆盖首个 30 天账期，50 账号平均不得超过约 1,326 个推送事件/账号/日；200 账号平均不得超过约 326 个/账号/日。后续月份不再支付首次 Watch 新增费用时，阈值分别约为 1,333 和 333 个/账号/日。

按 Max 的 2,000,000 messages/月额度估算，首月包含 Watch 新增成本时：

- 50 账号、平均 100 事件/账号/日：约 160,000 messages/月。
- 200 账号、平均 100 事件/账号/日：约 640,000 messages/月。
- 200 账号约可承受平均 326 个推送事件/账号/日，才接近首月 2,000,000 messages 上限。

上述 Max 测算尚未包含按 Tweet ID 补查详情的 REST 成本。Reply/Quote/Retweet 若缺少关联对象，只允许对候选事件做有上限的选择性补查，禁止每条推送无条件追加一次 REST 请求。

Max 的 600 个自定义 Watch 名额已由套餐页确认。上线前仍需实测：`NEW_FOLLOWER` payload 可识别新粉丝、Reply/Quote/Retweet 关联字段、P50/P95 延迟、断线重连补发，以及“不足 20 条的单次推送”如何计费。

### Max 可行性复核结论

2026-07-21 已再次核对 6551 官方 `opentwitter-mcp` 仓库最新 `main` 提交 `4758c10e363ed66e048604bc173f2f22262a4bb5`；本机安装的 `opentwitter` Skill 与官方版本逐字一致。

| XBOT 需求 | 官方能力 | 当前结论 |
|---|---|---|
| KOL 直接发帖、CA、关键词 | `NEW_TWEET`、`CA`，content 含 text/mentions | 可实现 |
| KOL 回复 | `NEW_TWEET_REPLY` | 事件存在；目标账号字段需实测，缺失时选择性调用 Tweet by ID |
| KOL 引用 | `NEW_TWEET_QUOTE` | 事件存在；Tweet by ID 官方说明包含 `quotedStatus`，可补全目标 |
| KOL 转发 | `NEW_RETWEET` | 事件存在；原推作者字段需实测 |
| KOL 新关注项目账号 | 对项目账号开启 `newFlwBol`，接收 `NEW_FOLLOWER`；content 含新粉丝账号和 ID | 架构可实现，方向正确 |
| 取消后重关不重复触发 | 本地 `x_follow_seen` 与 `x_follow_signal_once` | 已由现有代码和 TwitterAPI.io 真实测试验证 |
| 多账号、多 CA 绑定 | 本地多对多匹配 | 不依赖 Provider，已验证 |
| 50/200 账号容量 | Max 自定义监控上限 600 | 满足 |
| 静默期不轮询 | 单 WSS 事件驱动 | 满足 |
| 300ms-1s 延迟目标 | 官方未公布延迟 SLA | 必须实测，不能仅凭文档承诺 |
| 断线可靠性 | 官方仅说明 ping/pong，未说明 ACK、游标、重放或补发 | 必须实现告警、重连和有界 REST 对账 |

因此决策为：**Max 条件性可行，可用于 Signal-only MVP 验收；在真实事件延迟、payload、补发和计费测试通过前，不得进入 Paper 自动执行或 Live。** TwitterAPI.io 暂时保留为对照/回退 Provider，不同时开启重复生产信号。

Max 开通后的最小合约验收：

1. 添加 `wanshenme`：只开启 Tweet、Reply、Quote、Retweet、CA，关闭资料更新等无关事件。
2. 添加 `neet_sol`：只开启 New Follower；取消关注事件仅用于状态观测，不生成信号。
3. 启动唯一一个 WSS 主连接，完成 subscribe、ping/pong、指数退避重连和 Token 日志脱敏。
4. 依次执行新关注、回复、引用、转发、直接提及 CA/关键词，验证每类事件的 actor、target、tweet ID 和 createdAt。
5. 每类事件只生成一条 activity，并按本地 distinct CA fan-out；全程保持 `TRADING_MODE=signal`、`engine_armed=false`、Position=0。
6. 记录事件发布时间到本地 signal 的 P50/P95；MVP 通过线暂定 P95 不超过 1 秒，任何持续漏报或无法识别 target 均判定失败。
7. 人为断开 WSS 60 秒后制造一条测试事件，验证是否补发；不补发时启用有界 REST 对账并明确最大不可恢复窗口。
8. 对照控制台前后 points，确认不足 20 条推送是否向上取整，以及重连/多连接是否重复计费。

### GMGN 官方 CLI 链上闭环测试（2026-07-21）

本次使用官方 `gmgn-cli@1.5.2` 直接测试托管钱包交易契约，没有调用 XBOT 当前旧版 `trade-engine`，也没有修改应用的 Activity、Signal、Position 或 Budget 数据。

只读门禁：

| 项目 | 结果 |
|---|---|
| API Key + 私钥签名 | `portfolio info` 成功 |
| 绑定 Solana 钱包 | `6ek4SVsYvqa4s7YFDi6iJ8YM7mdVvH3AdZ4QwAfQE3YA` |
| 初始余额 | `0.500001 SOL` |
| 目标 CA | `Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump`（NEET，6 decimals） |
| Token Info / Security / Pool | 全部成功；无 alert/flags，流动性约 `$1.208M` |
| 0.005 SOL 买入报价 | 5% 滑点报价成功，预计 `18.700189 NEET`，价格冲击 `0` |

真实买入：

- 输入：`0.005 SOL`，最大滑点 5%，anti-MEV。
- GMGN Order：`od10sol00000019f844e245fe1fb7aaa81eb41e5`。
- [Solana Transaction](https://solscan.io/tx/2s3h5nJpLjZqi8Dfj6FGGV4SSoNAsiaPvymuagciUrw6y6VYFgZbHRtcFbjFqwBdZxFVGteu4actJkuJ8sfSQZ8J)。
- 最终状态：`confirmed`，实际到账 `18.700189 NEET`。

真实卖出：

- 输入：全部 `18.700189 NEET`，最大滑点 5%，anti-MEV。
- GMGN Order：`od10sol00000019f844fa7a83efc6153cc536625`。
- [Solana Transaction](https://solscan.io/tx/589sRaqWs48qkh4hEwPzZUsqqw3VMKPjSf4pYkGVEjahux9igWCXUSWbjNDBZxvw4JLJSVMH674VYythwyEQpidt)。
- 最终状态：`confirmed`，实际返回 `0.004984157 SOL`。

闭环后余额：`0.498010896 SOL`、`0 NEET`。相对初始余额，完整买卖测试总成本约 `0.001990104 SOL`，包含网络、路由、平台及临时账户相关成本。

Solana 主网 RPC 独立核验：两笔交易均 `confirmationError=null`，网络费各 `5,010 lamports`；买入钱包变化 `-8,948,690 lamports`，卖出钱包变化 `+6,958,586 lamports`。网络费合计仅 `0.00001002 SOL`，余额差额中的其余部分包含路由/平台成本以及零余额代币账户仍占用的租金；租金可能在关闭账户后回收，不能把 `0.001990104 SOL` 全部视为永久交易亏损。可使用 `npm run audit:solana-tx -- <wallet> <signature...>` 重复核验。

安全核验：XBOT 继续保持 `TRADING_MODE=signal`、`engine_armed=false`、Active Position=0、Trades Today=0、Budget 表为空。CLI 的两笔真实交易未进入应用数据库。

代码阻塞：当前 `backend/lib/gmgn-http.js` 仍使用旧 `/defi/router/v1/...` 契约，`trade-engine` 还错误地把 GMGN API PEM 私钥当作 Solana/EVM 钱包私钥签交易。应用进入 Live 前必须改为官方 `/v1/trade/swap -> order_id -> /v1/trade/query_order` 托管钱包流程，并以 `confirmed` 作为唯一成功终态。

---

## 六、需要用户配合的事项

明日开始开发时不需要新增密钥或钱包信息。人工验收阶段需要用户：

1. 保持 `wanshenme` 可操作。
2. 按提示关注或取消关注 `neet_sol`。
3. 后续按顺序执行转发、回复、引用和测试发帖。
4. 在 M0-M4 门禁通过后，确认购买 Stream Starter `$29/月` 和首次 REST Credits `$10`。

任何测试开始前，Codex 必须先明确回复“监控已启动”，用户再执行 X 操作，避免错过基线和浪费免费额度。

---

## 七、安全红线

- P7 全部完成前保持 `engine_armed=false`。
- 不把 `TRADING_MODE` 切换为 `live`。
- 不调用 GMGN 交易提交、签名或广播接口。
- 不输出、提交或写入文档任何 API Key、私钥或 Admin Token。
- Provider 失败时不得生成虚假活动、虚假信号或 Mock 持仓。
- 任何无法解释的重复信号、状态跳变或资金变化立即停止测试。

---

## 八、P7 完成定义

同时满足以下条件，P7 才算完成：

- [ ] `signal/paper/live` 三模式有明确、可测试的执行边界。
- [ ] TwitterAPI.io 已成为正式 X Provider，不再依赖手工测试脚本运行主流程。
- [ ] Tweet 类由 Webhook 事件驱动，静默期间不做 Timeline 轮询。
- [x] Follow 按 KOL 聚合拉取 Followings，不存在逐关系高频生产轮询。
- [ ] 真实关注、转发、回复、引用、CA 和关键词六类行为均完成验证。
- [ ] 每个 Provider 事件最多生成一条 activity，并仅对命中的 distinct CA 生成幂等 signal。
- [x] 首次完整 baseline、历史内容、重复轮询、取消后重关、分页缺口和 429 不会误触发。
- [x] 一个项目账号多 CA、多个项目账号同 CA 的 fan-out 和防重复规则通过测试。
- [ ] Webhook 鉴权、重放防护、重试、断线恢复和补偿通过测试。
- [x] Provider calls/credits 具有可观测指标、软告警、硬上限和自动熔断。
- [x] 前端能解释信号的 KOL、项目账号、CA、行为类型、来源时间和延迟。
- [x] 全部 MVP 测试期间无真实交易调用、无持仓误建、无资金变化。
- [ ] Tweet Stream 与 Followings 混合架构的真实延迟、稳定性和月成本已形成书面记录。

完成 P7 后，项目才进入 P6 Phase 4 的真实数据 Paper 连续观察阶段。
