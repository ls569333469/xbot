# P38 运行健康告警与人工 Engine 控制收敛方案

> 日期：2026-08-21
>
> 状态：P38.1 代码已实施并完成本地验证；待生产发布验收
>
> 当前生产版本：`p36.3-production-20260820` / `aa15f24d4c11fc40c0ad4f04a00aa5188cfa7c62`
>
> 用户确认的最高优先级规则：健康异常只提示，不得自动暂停或停止全局自动交易；全局 Engine 状态由操作员控制。

本次实施范围：Readiness 健康/启动门禁拆分、运行监控改为只读观察者、重启恢复保留操作员意图、交易 Gate 忽略健康与未确定交易的全局提示、保留目标链/钱包隔离，并增加 `GET /api/system/runtime-health` 与前端常驻健康提示。未修改策略匹配、预算、GMGN Swap、持仓和平仓业务逻辑。

## 1. 目标与边界

P38 解决的不是单个 6551 心跳错误，而是当前系统把“启动检查、运行健康、最终下单安全”混在同一套 Readiness blocker 中的问题。

目标：

1. Provider、WSS、RPC、数据库短暂中断、GMGN 429、调度器冷却和健康检查程序错误，只形成可见告警，不修改全局 Engine 状态。
2. 全局 Engine 的 `running/stopped` 只由明确的操作员动作改变。
3. 单笔资金安全门禁继续保留，但只能阻断对应交易、钱包或链，不得无差别暂停三个策略。
4. 健康异常在所有前端页面持续可见，恢复后自动清除，不依赖一次性 Toast。
5. 任何故障窗口内的过期 Signal 不补买、不重放。
6. 固定 CA、动态喊单和关注发现的匹配、预算、GMGN Swap、Position、平仓及保护逻辑不做无关改动。

本方案不授权：

- 当前立即恢复生产 Engine；
- 重放 `BASEJUICE`、`WTDD` 或其他历史 Signal；
- 修改 P37 项目投研代码；
- 删除余额、Gas、预算、重复买入、钱包隔离和订单不确定性门禁；
- 在未经部署验收和用户确认时发起真实交易。

## 2. 生产事件与已确认根因

### 2.1 事件时间线

2026-08-21 生产证据：

| 时间（Asia/Shanghai） | 事实 |
|---|---|
| 06:25:03 - 06:25:09 | `apt-daily-upgrade` 自动重启 PostgreSQL，数据库短暂不可用 |
| 09:28:39 | Readiness 误报 `X_6551_INGESTION_UNHEALTHY` |
| 09:28:41 | 系统写入 `trade.auto_disarmed`，Engine 进入 `paused_transient` |
| 13:50:01 | `BASEJUICE` Signal `#832` 正常匹配，但停留在 `recorded` |
| 14:23:03 | `WTDD` Signal `#833` 正常匹配，但停留在 `recorded` |
| 14:25:49 | 6551 ingestion 心跳正常，WSS 为 `subscribed`，心跳年龄约 4 秒 |

当前生产资金状态：

- Dangerous Attempt：`0`
- Active Intent：`0`
- Pending Order：`0`
- Open Position：`0`
- Watch Outbox：`succeeded=51`
- Whitelist Activation Outbox：`succeeded=123`
- 最近 24 小时 GMGN：`98` 次请求、`0` 次 429、`0` 个 Provider error code

### 2.2 直接根因

`backend/lib/service-heartbeat.js` 使用以下表达式计算心跳年龄：

```sql
ROUND(EXTRACT(EPOCH FROM (NOW() - heartbeat_at)) * 1000)::int
```

生产 `service_heartbeats` 中仍保留一条 2026-07-27 的 `all` 角色心跳。2026-08-21 复现值为：

```text
2,165,318,034 ms
```

PostgreSQL `int` 上限为：

```text
2,147,483,647
```

即使查询最终按时间选中新鲜的 `ingestion` 行，数据库仍可能先计算候选行表达式，因此旧 `all` 行触发：

```text
ERROR: integer out of range
```

`backend/domains/trade/readiness-service.js` 和 `backend/domains/x-monitor/6551/status.js` 又把 `latestHeartbeat()` 异常静默转换成 `null`。系统随后把“查询程序失败”错误解释为“6551 没有健康心跳”。

### 2.3 为什么 Signal 被记录但没有执行

`LiveExecutionQueue.executeItem()` 在 `paused_transient` 下返回：

```text
skipped / live_gate_temporarily_paused
```

它不会执行 GMGN，也不会立刻把 Signal 转成明确终态，因此 `#832` 和 `#833` 留在 `recorded`。页面只能显示“已记录”，无法解释其未执行原因。

这两条 Signal 已超过当前 `SIGNAL_MAX_AGE_SECONDS`，后续不得补买。

## 3. 关联审计结论

### 3.1 P0：运行时健康检查拥有全局 Engine 写权限

当前 `ReadinessMonitor.checkOnce()` 有三条自动写状态路径：

1. `X_6551_INGESTION_UNHEALTHY` 或 `GMGN_SCHEDULER_NOT_HEALTHY` -> `pauseTransient()`；
2. 任意非瞬态 blocker -> `setFaulted()`；
3. Readiness 自身抛出异常 -> `setFaulted(READINESS_CHECK_ERROR)`。

这意味着 SQL 错误、Provider 抖动、配置读取异常、Migration 检查异常或新出现的 blocker 都可能停止三个策略的新买入。

结论：运行时健康监控必须改为纯观察者，不得调用 `stop()`、`pauseTransient()`、`setFaulted()`、`setArmed(false)` 或 `recoverTransient()`。

### 3.2 P0：只删除自动暂停仍不足以解决问题

`ExecutionGateService.assertReady()` 会读取同一个 Readiness snapshot，并把全局 blockers 再次作为最终下单拒绝条件。

如果只删除 `pauseTransient()`，Engine 虽显示 `running`，实际每笔交易仍会被 `LIVE_READINESS_FAILED` 全局拒绝。这会形成更隐蔽的“假运行”。

结论：必须拆分三种语义：

| 类型 | 用途 | 是否改变 Engine | 是否拒绝交易 |
|---|---|---:|---:|
| 启动条件 `arm_blockers` | 操作员启动前检查 | 仅阻止本次人工启动 | 不直接拒单；未启动时自然无交易 |
| 运行健康 `health_issues` | 前端、日志、通知 | 否 | 否 |
| 交易门禁 `transaction_blockers` | 单笔、单链、单钱包最终检查 | 否 | 只拒绝对应范围 |

### 3.3 P0：启动恢复仍会自动暂停或故障保护

`engineState.restoreDesiredState()` 在服务重启后最多等待 16 次 Readiness：

- 瞬态 blocker 超时 -> `paused_transient`；
- 非瞬态 blocker -> `fault_protected`；
- Readiness 异常 -> `READINESS_CHECK_ERROR_ON_RESTART`。

这条路径即使移除运行中 Monitor 的写权限，仍会在部署、系统重启或数据库恢复后自动改变 Engine。

结论：启动恢复只能恢复操作员持久化意图，不得因健康异常覆盖该意图。健康问题独立显示；实际交易仍由单笔最终门禁保证。

### 3.4 P1：错误被静默吞掉并伪装成业务不健康

以下路径把基础设施或程序异常转成 `null`：

- Readiness 的 ingestion heartbeat；
- 6551 状态接口的 ingestion heartbeat。

后果：

- 前端无法区分“6551 真断线”和“心跳查询失败”；
- 日志缺少原始数据库错误；
- 告警原因错误，排障方向被带偏。

结论：健康读取必须返回结构化 `observer_error`，记录经过脱敏的错误码，并保留最后一次可信状态；不得伪造 `unhealthy`。

### 3.5 P1：毫秒 `int` 溢出不是单点

同类表达式还存在于：

- `backend/scripts/prelive-audit.js`
- `backend/jobs/shadow-live-evaluator.js`
- `backend/domains/x-monitor/6551/event-inbox.js`
- 部分事件到 Signal、Signal 到交易的时延写入

风险分为两类：

1. 只读年龄：应使用 `bigint`，并在 `ORDER BY/LIMIT` 后计算；
2. 数据库存储仍为 `int` 的时延：必须在 SQL 中显式 clamp，过旧事件标记为 stale，不能因时延统计导致事件事务失败。

### 3.6 P1：暂停期间 Signal 状态表达不完整

`paused_transient` 下的队列项目被消费后，Signal 仍为 `recorded`。Scanner 因 Engine 未 armed 不会清理它们，导致：

- 页面长期显示“已记录”；
- 用户不知道是等待、过期还是不会执行；
- 恢复时存在误补单疑虑。

结论：无论健康是否异常，Signal 都必须在 freshness 到期时进入 `expired/SIGNAL_EXPIRED`。任何恢复流程都只能处理恢复后的新事件，不得改变旧 Signal 的时效边界。

### 3.7 P1：前端只有一次性 Toast，没有持久健康状态

当前 `Layout.tsx`：

- 每 10 秒只轮询 Engine status；
- 仅通过 `trade:alert` 显示短暂 Toast；
- 设置页才展示完整 Readiness；
- 侧栏把 `paused_transient` 显示为 Engine 暂停，没有独立的健康状态。

用户离开页面、刷新页面或错过 Toast 后，无法知道异常开始时间、当前影响范围和是否已恢复。

### 3.8 P1：告警风暴

本次误暂停在约 5 小时内生成：

```text
trade.auto_disarmed                1
trade.transient_pause_reminder    61
```

重复提醒没有增加新信息，却占用 Outbox、Telegram 和前端注意力。

结论：改为状态边沿通知：`opened`、重要变化、`resolved`。持续状态由前端常驻横幅承载，不再每 5 分钟重复发送同一提醒。

### 3.9 P1：生产系统自动升级重启 PostgreSQL

2026-08-21 `06:24:30`，`apt-daily-upgrade.service` 启动；`06:25:03` 停止 PostgreSQL，`06:25:09` 恢复。期间出现：

- DB pool 连接被管理员终止；
- Retry、Reconciler、Watch、动态 Worker、研究 Worker 等集中报错；
- execution 进程记录一次 `uncaughtException`。

虽然当前队列和资金状态已恢复安全，但生产数据库不应由无人值守升级在随机窗口重启。

### 3.10 P1：未捕获异常只记录，不退出

`server.js` 的 `uncaughtException` 和 `unhandledRejection` handler 只写日志，进程继续运行。Node 在未捕获异常后可能处于部分失效状态，Supervisor 又无法通过退出码发现并重启子进程。

结论：记录脱敏错误后执行有界退出，由 Supervisor 拉起新业务角色；启动后先运行 Reconciler，再接受新交易。不得让未知状态进程长期存活。

### 3.11 P2：另有数据质量问题，但不得影响 Engine

最近 24 小时日志还存在：

- 6551 `interaction target remains unknown after enrichment`：77 次；
- Follow Grok 未使用 `x_search/web_search`：9 次；
- Follow 事件拒绝：关系未验证 3、链无法唯一解析 2、CA 未找到 1。

这些属于事件解析和关注发现质量，不是本次 Engine 误暂停根因。P38 只保证它们形成局部失败与可见统计，不允许它们修改全局 Engine；具体解析质量另行归入关注发现/投研迭代，避免夹带交易控制重构。

### 3.12 P0：启动不变量失败不能伪装成 Engine 状态

`Migration` 失败、Schema 与代码不兼容、必需环境变量缺失、生产角色非法、端口绑定失败等错误，表示业务进程不具备安全启动条件。这类错误既不是可继续运行的 `health_issue`，也不是操作员主动停止 Engine。

正确边界是：

1. 业务进程在接受流量或启动 Worker 前失败并退出非零；
2. Supervisor 保留失败证据、执行有界重启并触发外部告警；
3. `operator_desired_state` 保持原值，不写入 `paused_transient/fault_protected/stopped`；
4. 进程恢复后必须先完成 Migration/Schema 检查和 Reconciler，再处理恢复后的新事件；
5. 外部探针必须能区分“进程未启动”和“进程已启动但运行健康降级”。

否则，Engine 表既表达操作员意图又表达进程启动错误，部署失败后仍会出现状态失真和错误恢复。

## 4. 目标状态模型

### 4.1 Engine 只表达操作员意图

目标持久状态简化为：

```text
operator_desired_state = running | stopped
```

兼容现有数据时：

- 新代码不再写入 `paused_transient`；
- 历史 `paused_transient/fault_protected/recovering` 只用于升级读取和迁移展示；
- 只有经过认证且带审计的人工 Start/Stop、明确 Emergency Stop、明确关键凭据替换可以改变操作员意图；
- 普通健康监控、策略保存、KOL、Watch、研究、Provider、数据库和 RPC 事件均无 Engine 写权限。

### 4.2 健康状态独立建模

新增轻量运行健康投影，不调用 GMGN probe：

```json
{
  "status": "healthy | degraded | critical",
  "engine": {
    "desired": "running",
    "effective": "running"
  },
  "issues": [
    {
      "code": "X_6551_INGESTION_UNHEALTHY",
      "severity": "warning",
      "scope_type": "provider",
      "scope_id": "6551",
      "first_seen_at": "...",
      "last_seen_at": "...",
      "summary": "6551 实时连接异常",
      "engine_affected": false
    }
  ],
  "generated_at": "..."
}
```

优先复用现有 `system_logs`、`notification_outbox` 和内存 snapshot，不为紧急修复引入数据库 Migration。若后续确实需要长期 Incident 查询，再在 P37 Migration 编号收敛后单独增加表，避免与当前未提交的 `054_p37_*` 冲突。

### 4.3 健康分类

| 健康问题 | 前端 | Engine | 交易处理 |
|---|---|---|---|
| 6551 WSS/心跳异常 | 常驻告警 | 不变 | 无新事件自然无交易；恢复后只处理新事件 |
| GMGN 429/冷却 | 常驻告警+倒计时 | 不变 | 当前请求有界等待，过期即结束 |
| GMGN API 超时 | 告警 | 不变 | 当前 Signal 延迟或失败，不影响其他策略 |
| 单链 RPC 异常 | 标记链异常 | 不变 | 只阻断该链 |
| 单钱包隔离 | 标记钱包/链 | 不变 | 只阻断该钱包写入 |
| 余额/Gas/预算不足 | Signal 显示明确原因 | 不变 | 只拒绝当前交易 |
| 数据库短暂不可用 | 全局健康告警 | 不变 | 连接恢复后继续；不补过期事件 |
| 健康观察器自身异常 | “健康检查不可用” | 不变 | 不把未知伪装成 Provider 故障 |
| Migration/Schema/必需环境启动失败 | 外部服务不可用告警 | 不变 | 进程启动失败，不接受新交易 |
| 手工 Emergency Stop | 明确停止提示 | stopped | 全局停止，这是操作员动作 |

## 5. 后端实施方案

### 5.1 第一阶段：P38.0 紧急热修

目标是用最小改动解除当前错误暂停根因，不夹带 P37。

1. `service-heartbeat.js`
   - 先在子查询中按 `heartbeat_at DESC LIMIT 1` 选中目标行，再计算年龄；
   - 年龄使用 `bigint`；
   - 增加超过 24.8 天的回归用例。
2. `readiness-service.js` 与 `6551/status.js`
   - 删除 heartbeat 的静默 `catch(() => null)`；
   - 返回 `observer_error` 或记录明确错误，不伪造 6551 断线。
3. `ReadinessMonitor`
   - 运行中只更新健康投影和发送边沿告警；
   - 禁止调用任何 Engine 状态写方法。
4. `LiveExecutionQueue`
   - Scanner 在 Engine 运行时继续执行 freshness 清理；
   - 所有恢复/部署流程明确禁止重放故障窗口旧 Signal。
5. 对当前生产 `#832/#833` 只做过期确认，不执行、不重新入队。

### 5.2 第二阶段：P38.1 Readiness 职责拆分

1. 将现有 `getSnapshot()` 输出拆为：
   - `arm_blockers`
   - `health_issues`
   - `transaction_blockers_by_scope`
2. `ExecutionGateService` 不再消费通用 `blockers`；只消费：
   - 操作员 Engine 是否 running；
   - 当前配置 fingerprint；
   - 当前策略 revision/context hash；
   - 当前链/钱包/订单的 transaction blockers。
3. 6551 健康、GMGN scheduler 状态、数据库观察器状态不得进入全局 transaction blocker。
4. `UNRESOLVED_TRADE_ATTEMPTS`、钱包隔离和连续失败锁改为对应链/钱包作用域；Reconciler 和持仓保护继续运行。
5. 保留 `EMERGENCY_STOP_ACTIVE` 和人工 Stop 的明确全局语义。

### 5.3 第三阶段：P38.2 启动恢复

1. Supervisor 重启后读取操作员意图：
   - `stopped` -> 保持停止；
   - `running` -> 启动业务角色并恢复新事件处理。
2. 启动健康异常只写 Health Issue，不再写 `paused_transient/fault_protected`。
3. 启动顺序保持：Migration -> Reconciler -> Retry -> Queue -> Worker。
4. 在数据库/Provider 未恢复时自然无法完成对应交易，但不得覆盖操作员意图。
5. 恢复后以当前时间作为新事件边界，旧 Signal 全部按 freshness 终结。
6. Migration、Schema、必需环境或进程角色校验失败时，必须在 Worker/API 就绪前退出非零；不得捕获后继续启动，也不得借写 Engine 状态表达失败。
7. 只有 `execution` 角色可以恢复操作员意图和承载交易控制；部署验收必须确认生产只有一个有效 execution 实例，避免多进程竞争写状态或重复消费。

### 5.4 第四阶段：P38.3 时间字段安全

1. 心跳、Shadow session、预实盘审计年龄使用 `bigint`。
2. 写入 `int` 时延列时使用显式上限和 stale 分类。
3. 禁止任何可选观测指标让事件入库、Signal 生成或交易事务失败。
4. 增加静态审计测试，扫描危险模式：

```text
EXTRACT(EPOCH ...) * 1000)::int
```

5. `prelive-audit` 必须在存在多年旧心跳时仍可运行。

### 5.5 第五阶段：P38.4 进程与服务器维护

1. `uncaughtException/unhandledRejection`：
   - 记录脱敏错误；
   - 停止接收新请求；
   - 有界释放资源；
   - 退出非零，由 Supervisor 重启。
2. xiexiu：
   - 禁止 `apt-daily-upgrade` 在随机窗口自动安装会重启 PostgreSQL 的包；
   - 保留安全更新检查，但 PostgreSQL、Nginx、systemd 等运行依赖只在 P29 维护窗口升级；
   - 升级前备份、停止新交易、核对在途资金，升级后执行 Schema/Readiness/公网验收。
3. 增加 systemd 告警：PostgreSQL 非计划重启、xbot child restart、WSS 长时间断线均只告警，不改 Engine。

## 6. 前端设计

### 6.1 全局常驻健康横幅

在 `Layout` 顶栏下方增加全宽、非卡片式状态带：

- 健康时不占空间；
- `degraded` 使用警告色，显示问题数量、最重要原因和开始时间；
- `critical` 使用危险色，但明确显示“Engine 仍按操作员状态运行”；
- 点击进入设置页健康详情；
- 桌面和移动端均不得遮挡导航、标题或操作按钮。

示例：

```text
运行健康异常 1 项 | 6551 实时连接异常 | 14:20 开始 | Engine 仍在运行
```

### 6.2 Engine 与健康状态分开显示

侧栏分成两个独立事实：

```text
Engine：真实交易运行中
健康：1 项异常
```

禁止再用“暂停等待恢复”把系统健康与操作员 Engine 状态混为一谈。

### 6.3 事件机制

1. 新增轻量接口：`GET /api/system/runtime-health`。
2. 前端每 10 秒轮询一次，页面刷新后仍可恢复当前状态。
3. WebSocket 新增 `system:health-changed`，用于即时更新。
4. Toast 只在 Issue 新建、严重度提升和恢复时显示一次。
5. 去掉固定 5 分钟重复 Toast/Outbox。

### 6.4 Signal 状态

- `recorded` 必须展示当前等待原因；
- GMGN 冷却显示“等待 Provider”，并显示剩余 freshness；
- freshness 到期显示“已过期”，不能长期停留“已记录”；
- Engine 人工停止期间的新 Signal 显示“仅记录信号 / 操作员已停止”；
- 健康异常不能直接生成 `LIVE_TRADING_STOPPED`。

## 7. 明确保留的安全门禁

P38 不删除以下保护：

- Engine 人工 Start/Stop；
- Emergency Stop；
- Signal 时效；
- 策略 enabled/mode/revision/context hash；
- CA、链、账号与触发事件授权；
- 单笔金额、日预算、累计预算；
- 重复买入与已有持仓；
- 余额和最低 Gas 保留；
- 钱包写租约；
- 已提交订单不确定性、Reconciliation、Wallet Quarantine；
- 止盈止损和平仓保护。

这些门禁只能作用于明确的 Signal、Attempt、钱包或链。除人工 Emergency Stop 外，不得将局部失败升级为全局 Engine 状态变化。

## 8. 配置操作边界

代码审计发现链重试、链配置和部分环境配置接口仍会调用 `setFaulted()`。这些属于操作员配置动作，不属于健康监控，但仍需满足：

1. 前端保存前明确显示“此操作是否会停止全局 Engine”；
2. 会停止时必须二次确认，不能在普通保存中隐式发生；
3. 后端必须先校验并保存成功，再按确认结果改变 Engine；
4. 配置保存失败不得留下 Engine 已停止的副作用；
5. KOL、标签、策略、Watch、投研和展示设置永远不属于全局停止操作。

当前已确认的高风险路径包括：`PUT /api/config/chains/retry` 在保存前先 `setFaulted()`，保存失败也可能留下 Engine 已停止；通用 `PUT /api/config/:key` 保存后无差别停止；`POST /api/system/env` 的 `monitoring_critical` 变化会自动 `pauseTransient()`。P38 必须逐项建立“配置类别 -> 影响范围 -> 是否需要显式停机确认”的白名单，不能继续依赖通用默认停机。

P38 首次实现以健康路径为主；配置接口按上述清单逐项回归，不做无关配置模型重构。真正影响交易模式、实盘总开关或私钥的操作仍可要求人工停止，但必须使用专用接口、明确确认文案和完整审计。

## 9. 测试矩阵

### 9.1 单元测试

- 新鲜 `ingestion` + 超过 24.8 天的旧 `all` 心跳，必须返回新鲜 ingestion；
- 心跳查询异常必须返回 observer error 并记录日志；
- 每一种 health issue 均不得调用 Engine 写方法；
- Readiness 抛异常时 Engine 状态不变；
- GMGN cooling 不改变 Engine；
- 6551 disconnect 不改变 Engine；
- 数据库恢复后不重放旧 Signal；
- 单链 RPC/余额/Gas 问题只阻断该链或该交易；
- 未知已提交订单只进入对应钱包/链隔离。
- `arm_blockers` 只能拒绝人工 Start，不得在 Engine 已运行时进入通用执行拒单列表；
- Migration/Schema/必需环境启动失败必须退出非零，且不得修改 `operator_desired_state`；
- 普通 KOL、标签、策略和监控配置保存不得调用 Engine 写方法；
- 配置保存失败不得先行改变 Engine 状态。

### 9.2 集成测试

1. Engine running，模拟 ingestion heartbeat stale：
   - Health Issue 出现；
   - Engine 仍 running/armed；
   - 其他本地可执行链路不被全局阻断。
2. Engine running，模拟 GMGN 429：
   - scheduler cooling；
   - Signal 在时效内等待；
   - Engine 不变；
   - 无高频重试。
3. 模拟 PostgreSQL 短暂重启：
   - 子进程按 Supervisor 策略恢复；
   - Engine 操作员意图不被覆盖；
   - Reconciler 先于新交易恢复；
   - 无旧 Signal 补买。
4. 模拟 Migration/Schema/必需环境启动失败：
   - 进程在 Ready 前退出非零；
   - Supervisor/外部监控产生明确告警；
   - Engine 操作员意图不变；
   - 无 Worker 接受新任务。
5. 固定 CA、动态喊单、关注发现各跑一条新 Signal 契约回归。

### 9.3 前端测试

- 健康横幅桌面、390x844 移动端无重叠；
- 刷新页面后异常仍显示；
- Issue 恢复后横幅自动消失；
- Engine running 与 health degraded 同时正确展示；
- Toast 不重复轰炸；
- Signal 页面显示等待/过期/局部拒绝的准确原因。

### 9.4 全量回归

- Backend 全量测试；
- PostgreSQL Integration；
- Migration rehearsal（若实现不新增 Migration，应为零变更）；
- Schema Audit；
- Release/Secret Audit；
- Frontend lint/build；
- `git diff --check`；
- 三策略执行、Position、平仓和外部钱包同步回归。

## 10. 实施与发布顺序

当前工作区含未提交 P37 代码，P38 不得夹带。

1. 从 `p36.3-production-20260820` 建立独立 `codex/p38-runtime-health-advisory` 工作树。
2. 先完成 P38.0/P38.1，保持无 Migration 的紧急发布优先级。
3. 完成自动测试与本地故障注入，不调用真实 GMGN Swap。
4. 推送唯一 commit 和不可变 production tag。
5. xiexiu 部署前：
   - 正式人工 Disarm；
   - 确认 `#832/#833` 及其他旧 `recorded` Signal 已过期且不会重放；
   - 核对危险 Attempt、Intent、Order、Position 为 0；
   - 备份并验证数据库。
6. 原子部署，Engine 保持 stopped。
7. 核对健康横幅、6551 subscribed、Watch、Readiness、进程唯一性和公网入口。
8. 只有用户明确批准后才重新启动 Engine。
9. 使用新事件分别验收三策略；禁止使用故障窗口历史事件。
10. 在独立维护窗口处理 unattended-upgrade，不能与应用热修混成一次不可回滚操作。

## 11. 验收标准

P38 完成必须同时满足：

1. 任何健康异常和健康观察器异常都不能改变 Engine 持久状态或 armed 状态。
2. 前端在 10 秒内持续显示健康问题及影响范围。
3. 6551/GMGN/RPC/DB 恢复后健康状态自动清除，不需要重新启动 Engine。
4. 单笔资金门禁继续有效，并且只影响对应范围。
5. 故障期间的过期 Signal 不补买。
6. 不再出现心跳 `integer out of range`。
7. 不再每 5 分钟生成重复暂停提醒。
8. PostgreSQL 不再由无人值守升级在随机时间自动重启。
9. 未捕获异常后业务子进程由 Supervisor 有界重启，不在未知状态继续运行。
10. 固定 CA、动态喊单、关注发现、持仓保护和平仓回归全部通过。
11. 启动不变量失败时进程失败退出且 Engine 操作员意图不变，生产只有一个有效 execution 实例。
12. 普通配置、KOL、标签、策略、Watch 和投研保存不会隐式停止全局 Engine。

## 12. 结论

本次不是一个孤立的 SQL 类型错误。真正问题是健康观察器拥有全局交易控制权，并且同一套 blocker 同时控制启动、运行状态和最终下单。

P38 的核心收敛原则是：

```text
健康只报告，Engine 由人控制，资金风险按最小范围阻断。
```

在 P38 完成并部署前，当前生产 `paused_transient` 不应通过手工反复 Arm 绕过；应先修复错误健康判定和自动状态写入，再由用户明确决定恢复真实交易。
