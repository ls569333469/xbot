# P20 动态策略测试与运行时升级方案

版本：v1.6。范围：Node 20 基线验收、P20 动态策略测试、Node 24 运行时升级回归、GitHub 隐私检查和受控服务器上传。必须先完成 Node 20 基线与 P20 测试，再单独升级 Node 24；两阶段都通过后才允许上传服务器。不启用动态实盘，不执行真实 Swap。

## 1. 测试目标

验证以下闭环能够稳定工作：

```text
6551 事件
  -> 动态策略匹配
  -> 动态任务入队
  -> 内容与 Intent 解析
  -> Candidate Index / GMGN 候选验证
  -> 唯一 CA 解析或明确拒绝
  -> Record 或 Paper 记录
  -> 审计、失败重试、预算和离场策略回写
```

Live 只验证安全门和阻断条件，不执行 Swap。P20 必须完成至少 7 天 Paper 运行并人工核对后，才能另行审核单账号小额 Live。

## 2. 测试前置

### 2.1 环境

本轮 P20 首阶段已使用 Node `20.20.x` 和 npm `10.8.x` 完成基线验收；随后本地运行时契约已统一升级为 Node `24.11.x` 和 npm `11.6.x`。`deploy/check-node-runtime.js` 与两个 `package.json` 现在拒绝其他 Node 主次版本。Node 20 结果作为历史基线保留，Node 24 结果作为当前代码运行时验收。

使用专用测试数据库，必须设置 `XBOT_TEST_DB_NAME`，名称中包含 `test`，且不能与生产库相同。本轮使用独立库 `xbot_p20_runtime_test`，没有把生产数据库临时改名后当作测试库。

本地安全配置：

```text
TRADING_MODE=signal
LIVE_TRADING_ENABLED=false
P20_CANDIDATE_INDEX_ENABLED=false
P20_DYNAMIC_RESOLUTION_ENABLED=true
P20_RECORD_ENABLED=false
P20_PAPER_ENABLED=false
P20_LIVE_ENABLED=false
```

确保 `.env`、API Key、私钥、管理员密码、生产数据和真实日志不进入 Git。测试事件使用脱敏账号、测试 CA 或只读候选数据。

### 2.2 基线检查

1. `npm.cmd test`：后端全部通过。
2. `npm.cmd run build`：前端构建通过。
3. `npm.cmd run lint`：前端检查通过。
4. `npm.cmd run test:integration`：专用测试库迁移和集成测试通过。
5. `npm.cmd run audit:schema:test`：确认 Migration 027、028、029、030、031、P20 表、列和唯一索引完整。
6. 查询 P20 Feature Flag，确认 `P20_LIVE_ENABLED=false`。
7. 查询动态 Worker、6551 Watch、GMGN 限流和数据库 Migration 状态，确认没有遗留 `processing` 锁或失败任务。
8. 确认 `P20_GMGN_CANDIDATE_TTL_MS` 使用受控短时缓存；测试环境不得将核验候选配置为永久有效。

## 3. 阶段一：策略保存和 Watch 同步

### 操作

1. 选择一个测试 KOL，保存一个 `record` 动态策略。
2. 允许链选择一个链，事件选择 Tweet、Quote、Reply 中的至少一种。
3. 词条依次选择完整 CA、`$` Cashtag、`#` Hashtag；保存默认离场策略。
4. 修改一个资金字段后再次保存。

### 预期

- 每个账号只有一条动态策略；配置变更生成新的 `revision` 和 `context_hash`。
- 默认离场策略是有效的完整结构，不能保存为空对象。
- 策略保存后，6551 Watch 期望列表包含该账号，事件权限与策略一致。
- 禁用或暂停策略后，若没有其他业务依赖，Watch 需求会被撤销或降级。
- 不创建 CA 白名单、不创建交易 Signal、不创建 Paper Position。

## 4. 阶段二：确定性解析样例

逐条发送或注入脱敏测试事件，并检查 `dynamic_signal_jobs`、`dynamic_ca_resolution_attempts`、候选证据和错误码。

| 样例 | 预期结果 |
| --- | --- |
| 帖子正文只有一个完整 CA | 唯一 CA，可进入解析；仍需通过策略和资金门 |
| `$PONS` / `$pons` | 大小写归一化为同一 Symbol |
| `$ANSEM` | 可以匹配 `ANSEM` |
| `$ANSEM` 与 `$ANSEMX` | 只能精确匹配前者，不能前缀命中后者 |
| `#PONS` | 作为 Hashtag 证据单独记录 |
| 中文完整项目名或已批准别名 | 只按完整短语/批准别名匹配，不做模糊分词 |
| 裸英文普通词 `LIT`、`INDEX` | 不得仅凭裸词触发 |
| Quote 中只有被引用账号的 CA | `quoted_only`，不得归因给当前账号 |
| Retweet | `quoted_only` 或拒绝，不得使用转发内容作为作者喊单 |
| 多个资产同时出现 | `multi_asset_ambiguous`，不得自动选择 |
| `sold`、`avoid`、`hack`、历史回顾、比较列表 | Intent Gate 拒绝，不进入交易 |
| 同名原盘和社区重启盘同时存在 | `ambiguous_variant`，不得按最高市值猜 CA |
| GMGN 字段未知、超时、429 | 明确失败关闭，不降级为旧 CA 猜测 |
| GMGN Token Info 返回的地址与请求 CA 不一致 | `GMGN_ADDRESS_MISMATCH`，候选必须失败关闭，不得选中或写入已核验缓存 |
| 策略仅允许 Cashtag，帖子只含完整 CA | 不得走直接 CA 路径，不调用候选验证 |
| 策略仅允许完整 CA，帖子只含 `$PONS` | 不得使用 Symbol 候选，不调用候选验证 |

重点核对 `$ANSEM` 这类边界：大小写应等价，符号必须存在，且 Token 边界必须完整。

## 5. 阶段三：Record 回放

将开关改为：

```text
P20_CANDIDATE_INDEX_ENABLED=true
P20_RECORD_ENABLED=true
P20_PAPER_ENABLED=false
P20_LIVE_ENABLED=false
```

### 检查项

- 6551 事件进入队列后只产生一条同策略同 revision 的任务。
- 同一 Tweet 重复投递只产生一个 Resolution。
- 唯一候选会记录选中 CA 和 GMGN 证据，但不创建交易 Signal。
- 多候选、无候选、Provider 未知和 Intent 拒绝都保存明确 `failure_code`。
- 任务第 1、2 次失败回到 `pending`；第 3 次失败进入 `failed`。
- `last_error` 必须保存真实错误消息，不得是 `[object Object]` 或空值。
- `gmgn_info` 核验候选必须带过期时间；过期后再次解析必须重新调用 GMGN 核验，不能永久信任旧快照。
- GMGN Token Info 的返回地址必须与请求的 `chain + CA` 一致；地址错配不得进入 `resolved`、Dynamic Target 或交易 Signal。
- 策略保存新 revision 后，旧任务被取消或按 revision 失效，不得使用新配置继续执行。
- Record 运行期间不调用 `gmgnHttp.swap()`，不创建 `positions`。

## 6. 阶段四：Paper 烟雾测试

先停止上一阶段 Worker，再设置：

```text
P20_CANDIDATE_INDEX_ENABLED=true
P20_RECORD_ENABLED=true
P20_PAPER_ENABLED=true
P20_LIVE_ENABLED=false
```

动态策略模式改为 `paper`，单笔预算和每日预算都必须为正数，且每日预算不低于单笔预算。

### 检查项

1. 唯一可交易候选创建一个 Dynamic Target 和一个 Paper Signal。
2. 同一账号策略 + revision 只创建一个 running Paper Session；并发事件不能创建重复 Session。
3. 同一 Paper Session + Dynamic Target 只创建一个 Evaluation。
4. Paper 只调用 GMGN 只读 Token/价格接口，绝不调用 `gmgnHttp.swap()`。
5. 模拟仓位的预算、入场价、数量、离场策略快照正确写入。
6. 同链同 CA 已有 Paper 仓位时，重复买入按策略限制拒绝或合并。
7. Paper 失败会写入 Evaluation 的 `failure_code` 和结果快照，不影响其他账号策略。
8. 把测试库中的 Session 结束时间移到过去，只验证到期 Worker 能收尾；这不能替代生产环境连续 7 天 Paper 验收。

### 正式 7 天验收的 Revision 规则

明天只做 Paper 烟雾测试，不伪造 7 天生产验收。后续正式验收时，应先保存最终的 `live` 模式、链、事件、词条、金额、滑点和离场策略，同时保持：

```text
P20_CANDIDATE_INDEX_ENABLED=true
P20_RECORD_ENABLED=true
P20_PAPER_ENABLED=true
P20_LIVE_ENABLED=false
```

此时 `live` Policy 会按同一 Revision 降级执行 Paper。连续 7 天完成后才能申请短时 Live Approval；任何配置修改都会产生新 Revision，必须重新验收。

## 7. 阶段五：安全门和故障注入

以下情况必须全部“拒绝或等待”，不能产生真实交易：

- 全局 `P20_LIVE_ENABLED=false`。
- 动态策略被禁用、暂停或 revision 改变。
- 未完成 7 天 Paper Session。
- 没有有效的动态 Live Approval、context hash 不一致或授权过期。
- 动态 CA 的 Watch 尚未同步，或 Activation 状态为 `syncing`/`sync_failed`。
- RPC、GMGN quote、Token 可交易性或离场策略校验失败。
- 6551 Watch Apply 关闭但动态 Live 需要新增/修改 Watch。
- Worker lease 过期后被另一个 Worker 接管。
- 动态解析任务 lease 过期后，旧 Worker 的完成或失败回写必须被拒绝；新 Worker 只能处理自己的租约。
- 动态任务连续失败达到上限。

重点证据：动态 Live 物化后必须先是 `live_activation_state=syncing`，写入 Activation Outbox，Signal 保存 `activation_wait_version`；只有现有 Activation Worker 完成 Watch、RPC、GMGN quote 和配置快照校验后才允许 `live_ready`。

## 8. 明天的通过标准

### 必须全部通过

- 单元测试、前端构建、Lint、专用测试库集成测试全部通过。
- 所有确定性解析样例结果符合表格。
- 无错误 CA 猜测；歧义、未知和超时全部失败关闭。
- Record 不交易，Paper 不 Swap，Live Flag 仍关闭。
- 无重复 Job、Resolution、Dynamic Target、Paper Session 或 Evaluation。
- 所有失败记录可读错误码和错误消息。
- 动态策略保存、Watch 同步、Activation Outbox 和 revision 失效链路闭环。
- 前端“配置为实盘”和“已获得授权”严格分开，未授权策略不得计入实盘授权数量。

### 立即停止条件

出现任意以下情况，停止测试并修复，不上传服务器：Paper 调用 Swap；动态目标直接变为 `live_ready`；未知 CA 被自动选中；多候选被市值机械选中；重复 Session/Signal；失败原因丢失；策略修改后旧 revision 仍可下单；或任何 API Key/私钥/生产数据出现在日志、构建产物或 Git diff 中。

## 9. Node 24 运行时升级回归

该阶段只能在阶段一至阶段五和数据库验收全部通过后开始。此阶段先验证本地，再更新服务器；不与 P20 首次启用混在一次发布中。

### 本地升级

1. 记录 Node 20 阶段的测试结果、Lockfile 状态和后端 Commit。
2. 将 `deploy/check-node-runtime.js`、两个 `package.json`、两个 `package-lock.json` 和相关部署文档统一改为 Node `24.11.x`、npm `11.6.x`，不能只改服务器版本。
3. 使用 Node 24/npm 11 执行后端和前端 `npm.cmd ci`，确认 Lockfile 没有非预期变化。
4. 重跑后端全量测试、P20 定向测试、集成测试、Schema audit、前端 lint/build、语法检查和隐私扫描。
5. Node 24 阶段任一项失败，都保留 Node 20 运行时和原 Commit，不进入服务器升级。

### 服务器升级

1. 记录服务器当前 Node/npm、Commit、Migration、systemd 状态、交易状态和服务路径 `/usr/bin/node`。
2. 服务器创建私有 Release 和数据库快照；快照不得进入 GitHub。
3. 停止新买入，等待 `pending/submitting` 订单归零，确认持仓、离场任务和对账状态后再重启服务。
4. 先仅升级 Node 24/npm 11，服务器 P20 Flag 全部保持 `false`，完成 `/api/health`、登录、固定策略、持仓、Settings、WebSocket 和 TGBOT 路由冒烟测试。
5. Node 24 服务器冒烟通过后，再部署已测试的唯一 Commit；不能在服务器临时修改代码或依赖。
6. 发现运行时异常时回退 `/usr/bin/node`、systemd Release 和依赖目录，恢复服务后核对交易账本。

## 10. 上传服务器前置门

明天本地测试全部通过后，才进入服务器上传；任一停止条件出现时当日不部署。

1. 记录服务器当前提交号、Migration 版本、运行配置摘要和交易状态。
2. 对服务器数据库和当前应用 Release 做受控快照；快照留在服务器私有存储，不进入 GitHub。
3. 检查 Git diff 和待提交文件，确认无 `.env`、API Key、私钥、密码、数据库 dump、真实日志、钱包地址快照和构建缓存。
4. 提交并推送经过测试的唯一 Commit，记录 Commit SHA；服务器只能部署该 Commit，不允许上传未提交目录覆盖。
5. 关闭新买入安全门，等待 `pending/submitting` 真实订单归零；确认已有持仓、离场订单和资金账本状态后再停止服务进程。
6. 核对服务器已通过 Node 24 阶段的 Node `24.11.x`、npm `11.6.x`、PostgreSQL 和依赖安装方式；使用锁文件安装，不在服务器临时改动主版本。
7. 执行 Migration 028、029、030、031，然后在服务器运行 `npm run audit:schema:production`；该命令只读审计生产 Schema，不修改数据。
8. 后端健康检查通过后再发布前端，并核对静态资源和 API 版本来自同一 Commit。

## 11. 服务器上传后验证

部署前必须额外确认：固定白名单列表和固定 CA 查找不返回 `source='dynamic_keyword'` 的动态兼容记录；动态信号只能通过 `dynamic_target_id -> whitelist_id` 精确引用自己的兼容记录。该隔离用于避免动态 Paper/Live 目标污染固定策略页面或被固定 CA 查找误选。

首次启动必须保持：

```text
P20_CANDIDATE_INDEX_ENABLED=false
P20_DYNAMIC_RESOLUTION_ENABLED=false
P20_RECORD_ENABLED=false
P20_PAPER_ENABLED=false
P20_LIVE_ENABLED=false
```

验证顺序：

1. 检查 `/api/health`、登录、策略中心、固定策略工作区、动态策略工作区和 Settings 加载；不得出现 5xx、无限加载或未捕获前端错误。
2. 检查原固定 CA、项目关系、生态互动、6551 Watch、持仓、离场、预算和对账数据未变化。
3. 检查 P20 Worker 状态为已启动但因 Feature Flag 关闭而不取任务；数据库无遗留 `processing` Job。
4. 检查 Migration 029、030、031 的动态表为空或仅含明确迁移数据，`ca_whitelist.source` 无 `NULL`，关键唯一索引存在。
5. 检查服务器日志不输出 API Key、私钥、Authorization、管理员密码或完整 Provider 响应。
6. 只在上述检查全部通过且用户再次批准后，按顺序启用 Candidate Index、Dynamic Resolution、Record；先绑定一个测试账号做服务器 Record 回放，仍保持 Paper/Live 关闭。
7. Record 验收通过后才能另行批准服务器 Paper；动态 Live 不属于明天的部署范围。

回退原则：发现应用错误时立即关闭全部 P20 Flag，并回退到部署前 Commit；Migration 029、030、031 为向前兼容增量表、字段和索引，不在故障现场直接执行破坏性降级 SQL。若固定策略或真实交易链路受影响，立即关闭新买入安全门并保留对账与离场能力，完成数据核对后再恢复。

## 12. 本轮代码核对补充

本轮新增的验收项必须在明天纳入测试：

- 账号清洗任务出现 `failed` 或 `partial` 后点击重试，父任务必须恢复为 `pending`，失败子项恢复为 `pending`，Worker 能重新领取；没有失败子项时接口返回明确的 `NOT_FOUND`。
- 动态上线窗口必须带有 Worker 租约；Worker 异常退出后，另一个 Worker 能在租约过期后接管；超过窗口有效期的 `pending/processing` 记录必须进入 `expired`，不能永久停留在 `processing`。
- 上线窗口只允许把仍为 `rejected` 的动态 Job 重新排队；策略删除或 revision 变化后，Job 保持 `cancelled`，不得被窗口 Worker 复活。
- 动态解析任务在 GMGN 慢响应期间必须续租；租约丢失时不得写入 Resolution、Target、Signal 或覆盖新 Worker 的错误状态。
- `gmgn_info` 候选快照默认 5 分钟过期，过期后必须重新验证；Provider 返回不同 CA 时必须记录 `GMGN_ADDRESS_MISMATCH`。
- Schema audit 必须同时确认 Migration 027、028、029、030、031，以及动态上线窗口租约字段和 P20 关键索引。

对应 Node 20 基线回归结果（2026-08-02）：完整后端单元测试 `338/338`、定向 P20/GMGN 测试 `31/31`、前端 lint/build、后端语法检查和 `git diff --check` 均通过；独立测试库集成测试 `36/36` 通过，Schema audit 输出 `SCHEMA_AUDIT_OK=xbot_p20_runtime_test;MODE=test`。期间发现旧测试库已登记 `029` 但缺少动态上线窗口租约字段和 Paper/动态信号唯一索引，已补充幂等迁移 `030`、`031` 并验证通过。

Node 24 阶段回归结果（2026-08-02）：后端和前端 `npm ci` 均通过；后端全量单测 `338/338`、P20/GMGN 定向测试 `39/39`、数据库集成测试 `36/36`、Schema audit `SCHEMA_AUDIT_OK=xbot_p20_runtime_test;MODE=test`、前端 lint/build、运行时校验、lockfile 完整性检查和 `git diff --check` 均通过。Node 24 初始基线已提交 GitHub；生产服务器尚未升级或开启 P20 Live。

## 13. Node 24 本地运行时实测记录（2026-08-02）

本轮使用独立数据库 `xbot_p20_runtime_test`，始终保持 `TRADING_MODE=signal`、`LIVE_TRADING_ENABLED=false`、`EMERGENCY_STOP=true`、`X_6551_WSS_ENABLED=false`、`X_6551_WATCH_APPLY_ENABLED=false`。GMGN Key 在测试进程中为空；Paper 行情使用进程内只读夹具，`gmgnHttp.swap()` 被计数并强制要求零调用。生产服务器、生产数据库和真实交易状态均未修改。

### 实测中发现并修复

1. Worker 定时器已启动但全部 Feature Flag 关闭时，前端错误显示“动态任务运行中”。现已按 Feature Flag 和 Worker 状态区分“未启用、待命、处理中、已停止”。
2. 非契约路径 `/api/actor-screening/runs` 会被 `/:id` 捕获并把 `NaN` 传给 PostgreSQL，产生 500。现已对账号清洗 ID 和 limit 做正整数校验，错误路径返回 400，不再污染后端错误日志。
3. 动态上线窗口 SQL 使用 PostgreSQL 关键字 `window` 作为更新别名，Record 启动后每秒产生语法错误和未处理 Promise rejection。现已改为非保留别名，定时任务增加顶层错误捕获，并新增真实 PostgreSQL 空队列轮询集成测试。

### Record 烟雾测试

执行 `npm run test:p20:record-smoke`。脚本带有以下硬门：数据库名必须包含 `test` 且不能等于生产库；`TRADING_MODE` 和全部 Live 开关必须关闭；只允许 Dynamic Resolution + Record，Paper 必须关闭。

结果：缓存候选被解析为唯一 CA，Job 和 Resolution 均完成；`signalCount=0`、`targetCount=0`，没有创建交易 Signal、动态目标、仓位或 Swap。前端正确显示测试账号、Record 策略和解析审计记录。

### Paper 烟雾测试

执行 `npm run test:p20:paper-smoke`。脚本使用受控 Token 价格和 BSC 钱包原生币价格夹具，同时覆盖 `gmgnHttp.swap()` 计数器。

结果：成功创建唯一 Resolution、Dynamic Target、Paper Signal、7 天 Paper Session、Evaluation 和 `execution_mode=paper` 的模拟仓位；单笔金额、入场快照和离场策略快照一致；`swapCallCount=0`。前端正确显示 Paper 策略和“7 天模拟运行中”。

### 故障与 Live 安全门

- 重复事件、候选歧义、Provider 地址错配、超时、Worker 租约、策略 revision 失效、Session 幂等和上线窗口接管测试全部通过。
- 把 Paper 策略保存为目标 Live 配置后，revision 从 1 变为 2；旧 Paper Session 不再计入当前 revision 验收。
- Live 授权接口返回 `DYNAMIC_PAPER_ACCEPTANCE_REQUIRED`，HTTP 400；`approval_id` 和 `approval_expires_at` 均为空，前端授权按钮保持禁用。
- 本轮只验证拒绝路径，没有开启 `P20_LIVE_ENABLED`，没有执行真实 Swap。

### 最终回归

- 后端全量单元测试：`341/341`。
- 独立测试库集成测试：`37/37`。
- 前端：lint、TypeScript 和 Vite build 通过。
- Schema audit：`SCHEMA_AUDIT_OK=xbot_p20_runtime_test;MODE=test`。
- 新增烟雾脚本、动态上线窗口和前端运行状态文件的 Node/TypeScript 语法检查通过，`git diff --check` 通过。
- 测试结束后必须恢复全部 P20 Feature Flag 为 `false`；服务器部署和 P20 生产启用仍需单独批准。
