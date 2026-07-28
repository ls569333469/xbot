# P19 低延迟实盘执行与韧性快路径方案

> 状态：发布候选实现完成，尚未部署生产服务器。日期：2026-07-28。

> 发布前验证：后端完整测试 `268/268` 通过，P19 关键单元测试 `47/47` 通过，前端生产构建和 DOM 冒烟通过。专用测试库已从 migration `000` 完整迁移到 `027`，32 个数据库集成测试全部通过；测试库已删除，未触碰生产数据。生产发布仍须按 P19.0-P19.5 分阶段执行。部署和迁移不得自动 Arm。
>
> 发布目标固定为生产服务器 `107.172.78.150` 的 `/opt/xbot`。本地工作区只承担开发、测试、构建和备份，不以本地运行结果代替生产验收。发布完成必须核对 GitHub 发布提交、服务器代码版本和生产前端资产一致。

当前生产 Engine 最近一次只读检查为 `Armed / running`。P19 不允许在 Engine Armed 时热部署交易代码；进入维护窗口后必须先 Disarm，并确认无开放持仓、无 uncertain Attempt、无钱包隔离，再执行备份、迁移、部署和重启。新版本启动后保持 Disarmed，未经用户明确批准不得恢复真实交易。

二次审核结论：P19 会修改真实资金关键路径，不能作为一个大版本一次上线。必须拆分为独立、可回滚的小版本；每一阶段均保持 Engine Disarmed 部署和显式实盘验收。生产运行状态会变化，发布前必须重新读取实时状态，不得依赖本文档中的历史快照。

## 1. 核心目标

P19 的第一目标是缩短“X 账号发生行为 -> 真实买入进入链上”的时间，而不是只让前端更早显示成功。

延迟口径必须拆开记录：

1. `source_to_receive`：X 源时间到 6551 WSS 被 XBOT 收到。
2. `receive_to_signal`：XBOT 收到事件到 Signal 提交。
3. `signal_to_submit_start`：Signal 到 GMGN Swap 请求开始。
4. `submit_http`：GMGN Swap HTTP 请求时间。
5. `source_to_submitted`：X 源时间到 GMGN 接受订单。
6. `source_to_chain`：X 源时间到交易所在区块。
7. `source_to_confirmed`：X 源时间到 XBOT 完成链上证据确认。

`source_to_chain` 是交易速度的主指标；`source_to_confirmed` 是系统可观测性的次指标。区块时间只有秒级精度时，报告必须注明误差，不能把系统确认时间当成实际成交时间。

## 2. 当前基线

2026-07-28 Robinhood Chain 的 WAY 成功样本：

| 阶段 | 相对 X 源时间 | 阶段耗时 |
|---|---:|---:|
| X 源行为 | 0 ms | - |
| 6551 WSS 收到 | 1,636 ms | 1,636 ms，外部上游 |
| Signal 提交 | 1,644 ms | 8 ms |
| Attempt 创建 | 2,269 ms | 625 ms |
| GMGN Swap 开始 | 2,490 ms | 221 ms |
| GMGN 接受订单 | 2,671 ms | 181 ms |
| XBOT 链上确认 | 3,979 ms | 1,308 ms |
| 链上区块时间 | 约 2,000 ms | 秒级精度 |

结论：

- 6551 上游约 `1.64s`，XBOT 无法通过本地代码直接消除。
- XBOT 从收到事件到 GMGN 接受订单约 `1.04s`，这是 P19 的主要优化区间。
- 实际交易约第 `2s` 已进入区块；`3.98s` 是 XBOT 完成确认的时间。
- 本地历史正常样本的源时间到系统确认约 `3.50-4.35s`；本地 YOLO 样本源时间到 GMGN 接受为 `4.127s`，实际区块约 `4.0s`。

## 3. P19 性能目标

在不降低资金安全等级的前提下：

| 指标 | 当前样本 | P19 目标 |
|---|---:|---:|
| `receive_to_signal` | 8 ms | P95 <= 50 ms |
| `receive_to_submitted` | 1,035 ms | P50 <= 550 ms，P95 <= 850 ms |
| `source_to_submitted` | 2,671 ms | 同等 6551 延迟下约 2.2-2.5s |
| `receipt_available_to_confirmed` | 当前未单独记录 | P50 <= 600 ms |

以上目标不承诺 `source_to_chain` 固定低于 2 秒，因为 6551、GMGN、RPC、区块生产和网络路由均属于外部变量。`submitted_to_confirmed` 只能作为观察指标，不能作为发布硬门槛；P19 的可控目标是将 XBOT 内部关键路径稳定减少约 `300-600ms`，并缩短 Receipt 已可见后的系统处理时间。

## 4. 当前关键路径问题

### 4.1 自动交易错误复用了人工两阶段流程

`LiveExecutionQueue` 当前依次调用：

```text
execution.prepare()
  -> buildPrepared()
execution.execute()
  -> readiness.getSnapshot()
  -> buildPrepared()
```

这会重复读取 Signal、上下文、配置、Live Policy，并重复请求 GMGN Quote。人工按钮需要一次性 Prepare Token 和二次快照校验，但 WSS 自动交易在同一进程、同一调用栈内立即执行，不存在等待人工确认期间的数据漂移，不应重复整套准备。

### 4.2 每笔交易执行完整 readiness

`readiness.getSnapshot()` 当前执行约 17 组查询，并装配全部白名单、缓存键和 721 条关系。该完整快照适合启动检查和设置页诊断，不适合每笔资金关键路径。

### 4.3 Quote、提交前证据串行

Attempt 创建后，系统才并发读取链状态、钱包 Token 余额和钱包 Activity，完成后才提交 Swap。提交前证据不能删除，但可与唯一一次实时 Quote 并行获取。

### 4.4 数据库往返可合并

Signal 领取、执行时间标记、Attempt 创建、证据保存、钱包写通道获取和状态切换目前分布在多个事务/查询中。数据库不是最大瓶颈，但可在保持 CAS 和审计边界的条件下减少往返。

### 4.5 确认轮询晚于实际区块

GMGN 返回 Tx Hash 后主要依赖 Reconciler 的热轮询。交易可能已经进入区块，但 XBOT 要到下一轮查询后才显示 confirmed。

### 4.6 一次缓存预热失败会永久停机

Cache Warmer 每 2 秒运行一次，任意一次 GMGN/网络错误都会设置 `lastError`。Readiness Monitor 将 `FAST_PATH_WARMER_ERROR` 当成永久 blocker，立即进入 `fault_protected`；下一批预热成功会清除错误，但故障保护状态不会自动恢复。这不符合 P17 已确定的“临时故障先暂停、连续健康后恢复、超过 60 秒才升级”原则。

## 5. 目标架构

### 5.1 自动单次执行入口

新增仅供内部队列调用的 `executeAutomatic(signalId, operator)`：

1. 校验 Engine Armed、运行模式、配置指纹和 Signal 年龄。
2. 获取目标链的紧凑执行门快照。
3. 预留 7 weight 资金写 Lease，并按优先级调度提交前证据读取。
4. 只执行一次 `buildPrepared()` 和一次实时 Quote。
5. 创建唯一 Intent/Attempt 并完成预算原子预留。
6. 保存提交前证据、获取钱包写通道、进入 `submitting`。
7. 调用一次 GMGN Swap。
8. 持久化订单并启动热确认。

人工 `/prepare` + `/execute` API 保持原样，继续要求一次性 Token、操作者绑定和二次快照校验。自动路径不会对外暴露，也不能由浏览器绕过人工确认调用。

### 5.2 紧凑执行门

新增 `ExecutionGateSnapshot`，只包含：

- Engine Armed、mode、emergency stop；
- 当前配置指纹和 live policy version；
- 目标链 production approval；
- Scheduler 是否可接受新交易；
- 未解决 Attempt、钱包隔离和未保护持仓 blocker；
- 当前快照生成时间。

Readiness Monitor 每秒生成并保存在内存中。自动交易只接受：

- 年龄不超过 1.5 秒；
- 配置指纹与 Engine Armed 指纹一致；
- 目标链明确 ready；
- 无资金安全 blocker。

快照过期或指纹不一致时，执行紧凑同步检查；不得复用过期结果，也不得为了速度跳过检查。完整 readiness 继续用于启动、诊断和生产验收，但不再位于每笔交易关键路径。

内存快照只用于快速预检，不能作为最终资金写授权。完成 Quote 和提交前证据后、进入 `funds_write_started_at` 之前，`beginSubmission()` 必须再次同步验证持久化 Engine 状态、Armed 配置指纹、Emergency Stop、白名单状态与 activation version、Signal 对应的 Live Policy 关系/来源授权、目标链 production approval、Chain Circuit 和钱包隔离状态。任何变化都必须在 Swap 前失败关闭。

### 5.3 分层权重与并行读取

自动交易不采用一次性 `11 weight` Lease。一次性占用 11/14 容量会在额度不足时延长新交易等待，并可能挤压 `CRITICAL_RECONCILIATION`。P19 改为分层预留：

```text
资金写 Lease：Quote 2 + Swap 5          7
证据读取：Wallet Token Balance 1        1
证据读取：Wallet Activity 3             3
总消费上限                              11
```

执行顺序：

1. 先取得 7 weight 资金写 Lease，保证 Quote 后仍保留 5 weight 给 Swap。
2. 从内存读取已预热的 Token/Security/Pool/Gas/Wallet 上下文。
3. 证据读取以低于 `CRITICAL_RECONCILIATION`、高于维护任务的优先级单独获取 4 weight，并与唯一一次 Quote、链 RPC 状态并行。
4. 全部完成后计算 Risk/Snapshot 并执行最终同步资金门检查。
5. Swap 使用资金写 Lease 的剩余 5 weight。

资金写 Lease 等待证据时必须有短 Deadline；证据无法及时取得时释放 Lease 并失败关闭，不能长期占用 5 weight。这样既保护新交易，也允许紧急对账优先执行，并且不会突破内部 `14 weight/s` 上限。若必要缓存缺失，回退到现有安全加载路径并记录 `fast_path_fallback`，不能使用空值继续交易。

### 5.4 数据库快路径

数据库合并不与“自动单次准备”同批上线。只有 Trace 证明数据库往返仍是显著瓶颈后，才按风险从低到高实施：

1. 将 Signal 过期判断、领取和 `execution_started_at` 标记合并为一个 CTE/CAS 事务。
2. 将提交前证据保存、最终同步资金门、钱包写通道获取和 `reserved -> submitting` 合并为一个 `beginSubmission()` 事务。

`createBuyAttempt()` 继续在事务内锁定白名单、检查累计预算、重复买入上限、Chain Circuit、生产批准和幂等 Intent。正式 production approval 下不再无条件聚合完整 relations；仅在存在限时验收 scope 时加载关系并重算验收 Context Hash。

### 5.5 热 Receipt 确认

GMGN Swap 返回 Tx Hash 后立即唤醒现有 Reconciler 的同一条订单确认路径，不新增第二套确认写入器：

- 通过订单 CAS/领取机制保证同一笔订单同时只有一个 reconciler；
- 请求不重叠，结合实际 RPC 330-520ms 延迟调度；
- 前 2 秒最多 3 次 RPC，不占 GMGN weight；
- 必须验证目标 Token 的精确钱包增量和交易成功状态；
- 继续复用现有 `reconcileOrder()`、`saveChainReceipt()` 和 `finalizeConfirmedOrder()`；
- 证据完整后可直接 confirmed；
- 无 Receipt、Receipt 不完整或 RPC 异常时回退现有 Reconciler。

热唤醒与定时 Reconciler 竞争时，未取得订单领取权的一方必须退出，不能重复创建 Position、Lot 或保护策略。这只缩短系统确认展示，不改变实际成交速度，也不能用“Tx Hash 存在”代替 Receipt 证据。

### 5.6 Cache Warmer 韧性修复

`FAST_PATH_WARMER_ERROR` 改为有状态的临时故障：

1. 单次批次失败只记录错误和连续失败次数，不立即永久停机。
2. 若目标 CA 的必要缓存仍新鲜，现有交易门保持可用。
3. 单个目标 CA 缓存过期时，只让该 Signal 进入同步安全回退；回退失败则拒绝该 Signal，不暂停其他 CA。
4. 只有连续系统性 Provider/Scheduler 故障才进入 `paused_transient`，停止接新单但继续持仓保护和对账。
5. 连续 3 次健康检查后自动恢复，不追执行暂停期间的旧 Signal。
6. 系统性故障超过 60 秒仍未恢复才进入 `fault_protected` 并通知用户。

当前生产故障需要在部署修复后由用户明确批准重新 Arm，不能由迁移脚本或部署脚本自动开启实盘。

### 5.7 基础设施观察项

6551 上游约 1.64 秒是当前最大单段延迟。P19 先新增 24 小时分位数和网络分段数据：

- 6551 source -> transport 的 P50/P95/P99；
- GMGN DNS/connect/TLS/TTFB；
- Robinhood RPC TTFB 和 Receipt 可见时间；
- Node HTTP keep-alive 复用状态。

只有数据证明服务器区域持续同时远离 6551、GMGN 和 Robinhood RPC 时，才评估迁移服务器区域。P19 不直接引入第二家 X 数据源竞速，因为这会增加重复事件、语义差异、费用和漏控风险。

### 5.8 部署影响与维护窗口

P19 后端更新需要重启执行进程，不能保证完全无感：

- 部署前必须 Disarm，停止接收新买单；已有受 GMGN 策略保护的持仓仍由 Provider 执行，但本地对账在执行进程重启期间短暂停止。
- 部署门要求无 `open_unprotected` Position、无 uncertain Attempt、钱包通道无 quarantine。
- 当前 Supervisor 同时管理 ingestion/execution；整服务重启会造成短暂 6551 WSS 断线。P19 优先采用仅重启 execution role 的发布方式，ingestion 代码未变化时不重启 WSS。
- 若必须整服务重启，必须声明维护窗口；窗口内事件不得事后作为旧 Signal 自动补买。
- 新版本启动后保持 Disarmed，完成 readiness、队列、WSS、钱包通道和策略保护检查，再由用户明确批准限时验收。
- 每个阶段保留上一版本代码和数据库兼容回滚路径；回滚同样不得自动 Arm。

## 6. 分阶段实施

### P19.0：生产可用性修复

- 修复 Cache Warmer 临时错误被永久故障化。
- 成功执行后清空 Live Queue 的历史 `lastError`，状态页保留独立的历史事件而不是显示为当前故障。
- 增加连续失败次数、最近成功、暂停开始和恢复时间。

### P19.1：毫秒级 Trace

- 为每个 Provider Event/Signal/Attempt 生成统一 Trace ID。
- 使用单调时钟记录 claim、gate、cache、quote、risk、attempt、evidence、lane、swap、receipt 各阶段。
- 数据库存储有界 timing JSON；不存 API Key、签名、私钥、完整鉴权 URL 或钱包敏感响应。
- 设置页只显示 P50/P95 和最近一笔分段，原始 Trace 放诊断接口。

### P19.2：自动单次准备

- 实现内部 `executeAutomatic()`。
- 自动交易只请求一次 Quote。
- 人工两阶段交易保持不变。
- 完整 readiness 替换为紧凑预检，并增加提交前最终同步资金门。
- 本阶段不改变 Scheduler 权重、提交前证据顺序、数据库事务和 Reconciler。

### P19.3：并行证据与数据库合并

- 7 weight 资金写 Lease + 4 weight 分层证据读取。
- Quote、钱包证据和 RPC 状态并行。
- 合并 claim/timing 和 beginSubmission 事务。
- 优化 production approval 下无意义的 relation 聚合。

### P19.4：热 Receipt 确认

- Tx Hash 返回后立即热唤醒共享 Reconciler 路径。
- 保留 Reconciler 作为唯一持久化恢复后备。

### P19.5：页面响应优化（独立发布）

该阶段不阻塞交易快路径：

- 移除每次路由切换强制 300ms 淡入。
- 页面 GET 数据缓存、请求去重和后台静默刷新。
- `runtime-policy` 默认移除完整 relations，详情继续分页加载。
- 白名单只在打开编辑工作区时加载 KOL/模板。
- WebSocket 使用增量更新，避免整页重拉。

## 7. 安全边界

P19 明确不采用以下“提速”方式：

- 不删除实时 Quote、预算预留、重复交易幂等、钱包写通道或提交前证据。
- 不以缓存 Quote 代替下单前唯一一次实时 Quote。
- 不以 Tx Hash 代替成功 Receipt 和目标 Token 精确增量。
- 不降低 Signal 年龄限制，不追执行暂停期间的旧事件。
- 不绕过 Chain Circuit、生产批准、紧急停止或配置指纹。
- 不默认提高 Gas/Tip 费用。任何费用换速度策略必须单独展示成本、设置绝对上限并经过用户批准。
- 不在 Armed 状态热更新交易执行代码，不由部署脚本自动恢复真实交易。

## 8. 测试与验收

### 8.1 单元与集成测试

必须新增并通过：

1. 自动路径每笔只执行一次 Quote 和一次 Swap。
2. 人工路径仍要求 Prepare Token、操作者绑定和二次快照校验。
3. 7 weight 资金写 Lease 与 4 weight 证据读取分层调度，紧急对账保持最高优先级，并在各失败点释放剩余权重。
4. 缓存缺失进入安全回退，缓存过期不得继续快速交易。
5. 执行门过期、提交前最终资金门失败、配置指纹变化或目标链不 ready 时不得提交。
6. Quote/Risk 失败不得创建资金写 Attempt。
7. 提交前证据必须早于 `funds_write_started_at`。
8. 任意异常不得造成重复 Intent、重复 Swap、预算泄漏或钱包通道遗留。
9. 单次 Warmer 失败不永久停机，持续失败暂停，连续健康自动恢复。
10. Receipt 热确认复用唯一 Reconciler 写入路径，只接受完整链上证据，所有不确定结果留在持久化 Reconciler。

### 8.2 发布验收

1. 完整后端测试、集成测试、迁移演练、前端构建和隐私扫描通过。
2. Engine 保持 Disarmed 部署，重启后不得自动 Arm。
3. 每个 P19 阶段独立发布和回滚，不允许将 P19.0-P19.4 合并成一次生产切换。
4. 先运行事件回放和只读 Shadow，确认一次 Signal 只生成一个执行计划。
5. 通过一条明确白名单和 `0.001` 原生币上限执行一次限时实盘验收。
6. 验证 Buy Tx、Receipt、目标 Token 增量、预算、Position、保护策略和 Close 全链路。
7. 恢复正式策略后，使用前 5 笔自然交易统计 P50；累计 20 笔后计算 P95，不为凑样本制造额外交易。
8. 任意 duplicate、uncertain、wallet quarantine、budget drift、新 429 或相对基线延迟回退立即停止扩大范围并回滚当前阶段。

## 9. 预期结果

按当前 WAY 样本估算：

```text
当前：6551 1.636s + XBOT 到 submitted 1.035s = 2.671s
目标：6551 1.636s + XBOT 到 submitted 0.55-0.85s = 2.19-2.49s
```

实际链上区块受外部条件影响，无法按固定值承诺。当前服务器样本约第 2 秒已进入区块，说明主要收益将表现为：

- 更稳定地在 6551 事件到达后约半秒到八百毫秒内完成提交；
- 减少高并发或缓存预热时对新交易的抢占；
- 更早显示链上确认；
- 第三方短暂抖动不会把 Engine 永久停住。

P19 的成功标准不是单笔偶然跑出最低数字，而是在保留全部资金安全边界的情况下，让 P50/P95 都下降，并且不增加重复交易、未知写入、429 或未保护持仓。
