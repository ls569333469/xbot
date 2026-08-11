# P21 单次实盘闭环测试方案

> 版本：v1.2
>
> 日期：2026-08-06
>
> 范围：仅验证“新关注发现策略”的一次真实买入与一次真实平仓
>
> 明确不包含：Record 测试轮次、Paper 测试轮次、批量账号测试、扩大实盘范围

## 1. 审核结论

P21 当前架构边界清晰，可以进入部署前准备，但在真实资金测试前必须满足两个硬门槛：

1. Migration 036 必须先在隔离测试数据库完整 rehearsal，再在生产库备份后执行；当前自动化只验证了 Migration 文件和 Schema Audit 规则，没有替代真实 PostgreSQL Migration rehearsal。
2. `P21_FOLLOW_DISCOVERY_ENABLED=false` 时 Worker 不处理事件，但已启用 Policy 的 Follow 事件仍可能进入 `pending`。打开总开关前必须确认该测试 Policy 没有旧 `pending/processing` 事件；存在旧事件时不得直接开启实盘。

已验证：

- 后端完整测试 `401/401` 通过；
- 本轮 Follow Discovery 与 6551 相关测试 `23/23` 通过；
- 前端 lint/build 通过；
- Follow 方向、稳定 User ID、永久幂等、唯一 CA、Revision、TTL、逐链预算和 P19 运行时二次授权均已有自动化覆盖；
- Record 不物化 Signal，Paper/Live 复用现有 Signal 和 P19 执行链路；
- 固定 CA 页面和固定 CA 唯一约束已排除系统生成的 Follow Whitelist。

本方案不通过放宽 CA 标准来确保成交。目标账号不满足唯一 CA 时，本次测试应安全拒绝，而不是强行选择代币。

## 2. 测试目标

只执行一个完整闭环：

```text
受控 KOL 主动关注一个新项目账号
  -> 6551 NEW_FOLLOWER
  -> Follow Event
  -> Grok 4.5 快速模式（reasoning_effort=low）+ x_search/web_search
  -> 搜索工具调用门禁
  -> 目标账号/项目/官网/关联人员证据与唯一 CA
  -> 无结果或歧义时进入结构化补充检索
  -> 本地从主证据摘录重新提取 CA
  -> GMGN 精确地址验证
  -> Follow Whitelist Activation
  -> P19 真实买入
  -> Position / Lot / Strategy / Budget 入账
  -> 人工全额平仓
  -> Receipt / Proceeds / Position / Budget 对账完成
```

测试只允许产生：

- 1 个受控 Follow Event；
- 1 个唯一 `chain + CA`；
- 1 条 P21 Live Signal；
- 1 次真实买入提交；
- 1 个真实持仓；
- 1 次人工全额平仓。

## 3. 测试对象标准

### 3.1 Actor

推荐使用用户可完全控制的 `@wanshenme`，或另一个可在约定时间执行关注动作的已核验 KOL。

必须满足：

- 已存在于 KOL 账号库；
- `profile_status=verified`；
- X User ID 是真实稳定 ID，不是 Handle 回退值；
- 测试准备期间不执行其他关注或取消关注动作；
- 当前没有另一份未归档的新关注发现 Policy。

### 3.2 Target

执行前选择一个 Actor 当前尚未关注的项目账号。不要先关注再取消，因为同一 Actor/Target 行为永久去重。

Target 必须满足：

- 有稳定 X User ID；
- 账号年龄达到 Policy 配置；
- 至少有一条近期原创内容；
- Bio、置顶原创、近期原创、Profile 直连官网或可追溯的官方项目证据中能够确认一个完整 CA；
- 如果 Target 是创始人/CEO/核心成员，允许由关联项目账号提供 CA，但必须同时有 Target -> 项目账号和项目账号 -> Target 的双向证据；
- 关联账号必须被识别为官方项目账号，不能只是生态账号或普通 KOL；
- CA 所在链与本次唯一允许链一致；
- GMGN 精确回显同一地址并标记可交易；
- GMGN 的 X Handle/Website 对齐关联项目账号时，审计记录必须保留关联账号和关系证据；
- 官方证据中不存在第二个有效 CA；
- Actor/Target 组合从未生成过 `follow:{actorUserId}:{targetUserId}`。

以下 Target 不用于本次成交测试：

- 同时宣传原盘和重启盘；
- 同一 EVM 地址在多个允许链上均形成有效候选；
- CA 只出现在无法与目标账号/官方项目建立关系的回复、引用、转发或第三方聚合页；
- 只有名称或 Symbol，没有完整 CA；
- 已经存在 pending、open、closing 或 uncertain 持仓。

## 4. 实盘参数

本次 Policy 使用专用模板，参数必须形成“一次成交上限”：

| 配置 | 标准 |
|---|---|
| 运行阶段 | `live` |
| 启用状态 | `enabled=true` |
| 允许链 | 只选 1 条 |
| 单笔金额 | 用户填写该链可成交的最小实盘金额 |
| 每日该链预算 | 等于单笔金额 |
| 每日新币数量 | `1` |
| 单币累计买入次数 | `1` |
| 滑点 | 使用该链已经过固定 CA 实盘验证的标准值 |
| 离场策略 | 使用该链已经过固定 CA 实盘验证的模板 |
| Event TTL | `900` 秒；测试期间不临时延长 |
| 最低账号年龄 | 默认 `7` 天 |
| 原创内容 | 必须开启 |
| Profile 官网 | 开启 |

不要在同一个模板中开放多链，也不要把每日预算设置为单笔金额的倍数。

## 5. 部署前硬门槛

以下任一项失败，本次测试不开始：

1. Git 提交经过凭据扫描，不包含 `.env`、API Key、Token、私钥、日志或数据库内容；
2. 服务器代码、Migration、依赖锁文件和前端构建产物来自同一提交；
3. Node/npm 版本符合项目锁定版本；
4. 隔离数据库完成 Migration 000-036 rehearsal；
5. 生产数据库完成备份并成功执行 Migration 036；
6. `audit:schema:production` 通过；
7. `/xbot/api/health` 返回 JSON 200；
8. 固定 CA、动态喊单、持仓页、平仓入口和 WebSocket 冒烟通过；
9. 6551 WSS 已连接，Watch Apply 可用，GMGN 不在 429 冷却期；
10. 目标链 readiness、钱包余额、RPC、Quote、Swap 和手续费储备全部正常；
11. 未解决交易、钱包隔离、提交不确定和对账事故数量为 0；
12. 部署过程保持 Engine 停止，不自动启动实盘。

## 6. 单次实盘执行顺序

### A. 建立测试边界

1. 记录测试开始时间 `T0`；
2. 记录部署 commit、Policy ID、Actor X User ID、目标链和模板版本；
3. 确认 Actor 当前未关注 Target；
4. 确认 Target CA 当前无持仓、无买入尝试、无其他策略 Signal；
5. 确认当前固定 CA/P20 Live 策略数量和状态，避免把其他正常交易误判为 P21 结果。

### B. 创建 Live Policy，但暂不关注

1. 保持 `P21_FOLLOW_DISCOVERY_ENABLED=false`；
2. 创建或更新一份 Live Policy；
3. 只选择一条链和专用单次模板；
4. 等待 Follow Watch 同步成功，远端 `newFlwBol=true`；
5. 确认 Policy Revision、Context Hash 和模板快照稳定；
6. 查询该 Policy 的事件，必须没有 `pending/processing`；
7. 若存在旧事件，停止测试，停用并归档该 Policy，不直接打开 P21 总开关。

### C. 开启能力和全局 Engine

1. 开启 `P21_FOLLOW_DISCOVERY_ENABLED=true`，只热重启 ingestion/监控进程；
2. 再次确认 Follow Worker、6551、Watch、GMGN 和目标链健康；
3. 执行全局 Arm 准备，核对当前所有有效实盘范围；
4. 用户确认后启动全局 Engine；
5. 记录 Engine Arm 时间 `T1`；
6. 确认 `T0-T1` 之间仍没有该 Policy 的旧 `pending/processing` 事件。

### D. 用户执行唯一触发动作

在 Codex 明确回复“监控已就绪”后，用户只执行一次：

```text
Actor 关注 Target
```

不要同时发帖、回复、引用、转发，不要快速取消关注，也不要重复关注。

### E. 实时观察链路

按顺序确认以下状态，每一步都记录时间：

1. 6551 收到一个 `NEW_FOLLOWER`；
2. 标准化方向为 `Actor -> Target`；
3. Follow Event 使用稳定 Actor/Target User ID；
4. Event 状态从 `pending -> processing`；
5. Worker 进入 `grok_search`，请求使用 `grok-4.5`、`reasoning_effort=low` 和 `x_search/web_search`；
6. 记录 Grok `server_side_tool_usage_details`，`x_search_calls + web_search_calls > 0`；
7. 快速搜索返回唯一 CA 时继续本地证据复核；无结果、多个 CA、无搜索调用或结构化输出异常时记录失败码并进入一次补充检索；
8. Candidate Audit 只有一个 accepted `chain + CA`，并能回溯到目标账号、官方项目账号、官网或有明确关联的佐证证据；
9. Event 状态变为 `resolved`；
10. 生成一个 `source=follow_discovery` 的系统 Whitelist；
11. Whitelist Activation 变为 `live_ready`；
12. 生成一个 `execution_mode=live` 的 P21 Signal；
13. P19 在提交前重新检查 P21 开关、Policy Revision、Context Hash、TTL、预算和持仓；
14. 只创建一个 Buy Attempt 和一个 Trade Intent；
15. GMGN 返回真实 Order/Tx Hash；
16. Receipt 证明目标 Token 转入受管钱包；
17. Position、Lot、成本、使用预算和离场策略全部落库。

### F. 人工全额平仓

买入完成并通过对账后，不等待自动止盈止损触发：

1. 在持仓页选择该 P21 持仓；
2. 执行一次 `100%` 人工平仓；
3. 确认只出售系统记录 Lot 对应数量；
4. 确认 Sell Order/Tx Hash 和 Receipt；
5. 确认原生币 proceeds 可证明；
6. 确认 Position 进入 `closed`；
7. 确认相关离场策略已取消或完成；
8. 确认不存在残留 closing、uncertain 或 wallet quarantine。

### G. 恢复测试前状态

1. 停用并归档本次 P21 Policy，保留全部事件和交易审计；
2. 将 `P21_FOLLOW_DISCOVERY_ENABLED` 恢复到测试前状态；
3. 全局 Engine 恢复到测试前运行状态，不擅自改变其他策略；
4. 保留生产回滚包、数据库备份和测试证据；
5. 不物理删除 Follow Event、Signal、Trade Intent、Attempt、Order、Position 或 Usage 记录。

## 7. 立即停止条件

出现以下任一情况，停止新提交，不进行第二次关注或第二次买入：

- Follow 方向与预期不一致；
- Actor 或 Target User ID 缺失/变化；
- 开启 P21 前已存在旧 pending 事件；
- Event 超过 TTL；
- Profile、原创或官网证据不完整；
- 人员身份、关联项目身份或双向关系证据不完整；
- 出现两个及以上有效 CA；
- GMGN 回显地址、链或项目证据不一致；
- GMGN 429、账户级限流或交易调度器冷却；
- Watch 未同步或 Whitelist Activation 未到 `live_ready`；
- Policy Revision/Context Hash 在处理中变化；
- 目标 CA 已有持仓或未决买入；
- 实际金额、链或钱包与模板快照不一致；
- Attempt 进入 `submission_uncertain` 或 `reconciliation_required`；
- Tx Receipt 无法证明目标 Token 到账；
- 平仓 Receipt 无法证明精确 Token 支出或原生币 proceeds。

Provider 429 或 `RATE_LIMIT_BANNED` 时，Follow 解析和 Whitelist Activation 都读取 `reset_at` 并等待冷却结束；没有 `reset_at` 时使用受限退避。不切 IP、不手动重放、不放宽 TTL、不重复 Follow。冷却期间重复请求可能延长封禁。

## 8. 通过标准

本次 P21 实盘测试只有在以下条件全部满足时通过：

- 真实 Follow 事件只产生一个 P21 Event；
- 唯一 CA 来自 Target 自有官方内容，或来自已完成双向关系核验的官方项目账号；
- GMGN 精确验证同一地址和链；
- 只生成一个 P21 Signal、Intent 和 Buy Attempt；
- 真实买入金额等于模板单笔金额且不超过每日预算；
- Receipt、Position、Lot、成本和 Usage 对账一致；
- 人工 100% 平仓成功；
- Sell Receipt 和原生币 proceeds 可证明；
- 持仓关闭且无未解决交易、钱包隔离或策略残留；
- 固定 CA、动态喊单和其他现有策略没有被 P21 修改；
- 全部证据可以通过 Event ID、Signal ID、Attempt ID、Order ID 和 Tx Hash 串成一条审计链。

只解析成功但没有真实成交不算通过；买入成功但平仓或对账未完成也不算通过。

## 9. 测试证据清单

最终报告至少记录：

| 类别 | 必须记录 |
|---|---|
| 发布 | commit、Migration 036、Schema Audit 结果 |
| 策略 | Policy ID、Revision、Context Hash、模板 ID/Version |
| 身份 | Actor/Target Handle 与稳定 User ID |
| 事件 | Provider Event ID、Activity ID、Follow Event ID、各阶段时间 |
| 解析 | Profile Snapshot、Evidence、全部 Candidate Audit、唯一 CA |
| 激活 | Follow Whitelist ID、Activation Version、Watch 状态 |
| 买入 | Signal ID、Intent ID、Attempt ID、Order ID、Tx Hash、Receipt |
| 持仓 | Position ID、Lot、数量、成本、离场策略 ID |
| 平仓 | Close Attempt/Order、Tx Hash、Receipt、proceeds、最终状态 |
| 安全 | P21 Usage、每日预算、其他实盘范围、未解决事故数量 |

证据中不得包含管理员口令、API Key、私钥、完整请求签名或服务器 `.env`。

## 10. 用户需要配合的动作

用户只需要完成四项操作：

1. 选择受控 Actor 和一个符合唯一 CA 标准、当前尚未关注的 Target；
2. 在模板中填写该链最小实盘金额，并确认每日预算等于单笔金额；
3. 收到“监控已就绪”后执行一次关注；
4. 买入对账完成后，在持仓页确认一次 `100%` 平仓。

部署、Migration、Watch、队列、解析、Activation、交易和对账状态由 Codex 逐阶段核对。任何阶段失败，Codex应先报告精确失败码和审计 ID，不要求用户盲目重复操作。

## 11. P21.3 快速 Grok 专项测试

明天在真实买入前先完成以下只读验证；这些验证不产生 Whitelist、Signal 或交易：

| 编号 | 场景 | 预期 |
|---|---|---|
| F1 | 已知项目账号，CA 位于官网或官方内容 | 快速 Grok 实际调用搜索并返回唯一 CA |
| F2 | CA 位于项目账号帖子或买入链接 | 本地从主证据摘录/链接提取同一完整 CA |
| F3 | 目标为 CEO/创始人/核心成员 | 返回关联项目账号和关系证据，不能只凭姓名买入 |
| F4 | 搜索调用次数为 0 | 返回 `XAI_SEARCH_NO_TOOL_USE`，不接受模型记忆结果 |
| F5 | 快速结果无 CA 或多个 CA | 进入补充检索；仍不唯一则 `FOLLOW_CA_NOT_FOUND` 或 `FOLLOW_CA_AMBIGUOUS` |
| F6 | 证据发布时间晚于 Follow | 本地拒绝该候选，不使用未来信息 |
| F7 | CA 大小写、URL、第三方佐证混合 | 能匹配主证据，不因来源顺序错误误拒绝；第三方单独证据不能建立项目关系 |
| F8 | xAI 429、超时、无效 JSON | 按错误码退避/补充检索，不能重复提交交易 |

F1/F2 的只读测试账号使用已经验证过的 `@marscoin7777`，允许链只配置 `bsc`，用于确认返回：

```text
0xfe189e97832da1573e4e4ff034f4ffc3a15c7777
```

每个场景记录：开始时间、结束时间、Follow Event ID（如有）、Prompt Version、模型、搜索调用次数、候选 CA 数量、主证据 URL、最终错误码和是否进入补充检索。API Key、Token、私钥和完整请求体不得进入测试报告。

### 11.1 明日实际交易步骤

只读 F1～F8 全部通过后，才执行一次小额 Live 闭环：

1. 用户确认受控 Actor 已保存、目标账号当前未关注、目标链和单笔金额正确；
2. Codex 确认 Engine、P21 开关、6551 WSS、Watch、GMGN 和目标链均已就绪；
3. 用户只执行一次 `Actor 关注 Target`，不同时发帖、回复、转发或取消关注；
4. Codex 监控 `NEW_FOLLOWER -> grok_search -> gmgn_verify -> live_ready -> buy` 全链路；
5. 真实买入到账并完成对账后，用户在持仓页执行一次 `100%` 平仓；
6. 平仓 Receipt、proceeds、Position、Lot、预算和交易审计全部一致后，立即停止本次测试并归档 Policy。

### 11.2 快速路径验收时间

- 6551 事件到达时间单独记录，不作为 Grok 耗时；
- Grok 快速阶段目标不超过 60 秒；
- 从 Event 入队到唯一 CA 解析完成目标不超过 120 秒；
- 发生补充检索时允许延长，但必须记录原因和每次调用耗时；
- 超过 Event TTL、证据过期或出现歧义时，必须拒绝交易，不为追求速度放宽门禁。
