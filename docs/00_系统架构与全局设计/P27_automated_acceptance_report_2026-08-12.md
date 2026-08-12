# P27 自动验收报告

> 日期：2026-08-12
> 范围：P27 代码、Migration、共享 GMGN 元数据、数据契约、前端设计系统、DOM、GMGN 调用边界与发布资产
> 结论：本地自动验收通过；最新代码尚未提交/推送，xiexiu 服务器尚未部署，凭据轮换尚未完成

## 1. 验收结论

P27 已完成本地代码更新、Migration `044-049`、历史元数据精确回填、共享 GMGN 展示元数据、REST/WebSocket 契约统一、前端设计收口和自动回归。自动验收未发现阻断代码提交的问题，但本报告不代表 GitHub 已上传或服务器已部署。

本报告只证明自动化与只读运行证据通过，不替代以下资金操作验收：

- Fixed：真实 6551 互动 -> Signal -> 小额买入 -> 平仓。
- P20：真实完整 CA 发帖/评论 -> Signal -> 小额买入 -> 平仓。
- P21：真实关注新账号 -> Grok/RPC 唯一链与 CA -> Signal -> 小额买入 -> 平仓。
- 服务器同步前轮换对话中曾展示的 GMGN Key，并验证生产与测试 credential profile 隔离。

## 2. 代码与契约

| 检查项 | 结果 |
|---|---|
| 后端全量测试 | `546/546` 通过 |
| 独立数据库集成测试 | `38/38` 通过 |
| 前端 lint | 通过 |
| 前端 TypeScript/Vite build | 通过 |
| Signal/Position/Attempt/History/CSV | 统一由 `p27.v1` projector 输出 |
| WebSocket | `p27.events.v1` 最小 envelope + 可靠 entity outbox |
| 策略归属 | `fixed_ca / dynamic_policy / follow_discovery` 明确投影 |
| 元数据 | P20/P21 本地 provenance 保留；缺失名称按唯一 `chain + CA` 异步共享回填，不阻断交易 |
| Swap 幂等 | 单 Attempt 最多一次 Swap；Order Query 不重提 Swap |
| Research | 独立权重和持久运行状态，不进入买入热路径 |

业务域未发现直接调用 `gmgn-http` 的路径；低层 HTTP 只负责签名、调度、审计和网络传输。已删除具备真实交易能力的 P25 Live runner，且其不进入发布候选。

## 3. Migration 与数据库

| 检查项 | 结果 |
|---|---|
| Migration 顺序 | `044 -> 045 -> 046 -> 047 -> 048 -> 049` 通过 |
| 专用测试库演练 | 从 P26 manifest 基线升级成功，二次运行零变更 |
| 生产只读 Schema Audit | 通过 |
| `047` 正式应用 | 7 条 Signal、2 条 Position 精确补齐 |
| 数据边界 | `047` 不调用外部 Provider；`048-049` 只异步调用 GMGN `token/info`，不修改状态、CA、金额或交易凭证 |
| 隔离恢复 | 8 张关键表行数与业务库一致，Schema Audit 通过 |

`047` 只处理 `source=historical_backfill`：P20 通过 `matched_dynamic_resolution_id -> selected_variant_id`，P21 通过 `follow_discovery_event_id -> variant_id`。禁止按 CA 模糊匹配。

`048-049` 新增共享 `asset_metadata`：数据库唯一键保证同一个 `chain + CA` 只有一条任务；Signal 已有完整 `name + symbol` 时不入队。Worker 默认延迟 30 秒，一次处理一个资产，仅在 GMGN Scheduler 空闲时使用最低优先级调用 `token/info`，且不使用 RPC、Metaplex、合约读取或其他 Provider 降级。

迁移前 PostgreSQL custom-format 备份：

- 文件：`backend/db/backups/xbot-before-p27-047-20260812-191534.dump`（Git 忽略）
- SHA-256：`D80B411707F220DF3A49B64614E4F4E3D955850A0157BFB7C7C9D85B5D7EE109`
- `pg_restore --list`：通过

## 4. DOM 与前端

以下 11 个路由已在 `1440x900` 和 `390x844` 验收：

`/`、`/strategies`、`/strategies/fixed`、`/strategies/dynamic`、`/strategies/follow-discovery`、`/whitelist`、`/kol`、`/signals`、`/positions`、`/history`、`/settings`。

结果：

- 无根级横向溢出，无 `undefined`、`NaN`、`[object Object]` 或控制台错误/警告。
- Signal 正确显示 `CASHCAT/STONKBROKER/MUMU/GTR`，不再显示“未知代币”。
- Signal 与 Position 统一显示共享元数据中的 `CRUDECAT/NOVAAI`，不再各自查询 Provider。
- `/history` 表格使用固定列宽和表内横向滚动，短标签、订单号和 Tx Hash 保持单行，错误码允许换行。
- 完整 CA、Tx Hash 和 `ROBINHOOD` 链筛选在桌面及移动端均不溢出。
- Trade Attempt 弹窗具备 `role=dialog`、标题关联、初始焦点和 Esc 关闭。
- Robinhood 交易链接使用已配置的 Blockscout explorer。

## 5. GMGN 调用审计

- Signal/Position 各连续读取 5 次，共 10 次，新增 GMGN 调用为 `0`；热查询约 Signal 8ms、Position 2-4ms。
- 7 个唯一历史资产真实回填共调用 7 次 GMGN `token/info`，全部 HTTP 200、约 202-371ms、`429=0`、Swap 调用 0。
- 保护策略 `strategy_batch_query` 约 8 小时 250 次，单分钟最高 3 次，全部 HTTP 200；它属于已有持仓状态同步，不是共享元数据或页面刷新。
- `429=0`、未知请求 0、未授权买入 0、重复 Swap 0。
- Supervisor 最终重启窗口未产生启动探测、页面预热或显式诊断调用。
- 显示名称不调用 Grok；仅缺失名称资产在交易之外异步调用一次 GMGN `token/info`。未命中策略不调用 GMGN 买入接口。

## 6. 运行与发布边界

本地健康接口已返回：

```text
contract_version=p27.v1
event_contract_version=p27.events.v1
process_role=execution
release_sha=null
```

本地 `release_sha=null` 是预期行为。`migration_manifest.release_sha` 是签署 P26 Migration 基线，不代表当前 P27 运行版本。服务器发布必须显式设置：

```dotenv
XBOT_RELEASE_SHA=<40-character-release-commit>
```

Release Audit、Secret/Git 历史扫描和 `git diff --check` 已通过；最终扫描计数以本次提交前重跑结果为准。

## 7. 未完成项

1. P27 最终代码下 Fixed/P20/P21 各完成一条真实 6551 买入和平仓闭环。
2. 轮换已披露 GMGN Key，验证生产/测试 profile 隔离。
3. 将当前工作区形成唯一 release commit 并推送 GitHub；远端 `codex/p26-production-hardening` 当前仍停在 `5a6d326`。
4. 服务器备份后按 Migration `044-049` 部署同一 release commit；`https://xiexiu.io/xbot/api/health` 必须返回匹配的 `release_sha`、`contract_version=p27.v1` 和 `event_contract_version=p27.events.v1`。
5. 服务器部署后重新执行 Schema、DOM、GMGN 429、Signal/Position 零页面调用和三策略闭环验收。

P26 binary 已在 P27 Schema 上完成启动、只读和空队列恢复验证，但未用旧 binary 对真实活跃仓位执行平仓写操作。该高风险动作不纳入本地自动回归；事故回滚时必须先暂停新买入，再按受控清单验收对账和平仓。
