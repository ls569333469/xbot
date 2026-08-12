# XBOT Production Deployment Assets

These files define the production deployment contract for the current XBOT release.

The production JavaScript runtime is pinned to Node `24.11.x` and npm `11.6.x`. Both package manifests run `deploy/check-node-runtime.js` before dependency installation so a different npm major cannot silently rewrite the lockfiles.

The current release keeps the authenticated frontend gate, fixed CA trading, the shared
execution kernel, the P20 account-scoped dynamic strategy pipeline, and P21 follow discovery.
P27 adds versioned REST contracts, immutable Signal metadata snapshots, reliable entity events,
and a trusted migration manifest without adding a new buy gate.

- `xbot.service` runs the supervisor as the unprivileged `xbot` operating-system user.
- `nginx-trading-platform.conf` mounts XBOT at `/xbot/` and preserves TGBOT at `/tg/`.
- `portal/index.html` is the root navigation page.

No `.env`, API token, private key, database password, or database dump belongs in this directory. Production secrets are stored only in `/opt/xbot/backend/.env` with mode `0600`.
Only paths listed in `release-allowlist.txt` belong in a server release bundle. Run
`cd backend && npm run audit:release` before creating the bundle. The historical live acceptance
runner, tests, local logs, screenshots, `dist`, and database snapshots are not release inputs.

The cold deployment contract is:

```dotenv
TRADING_MODE=live
LIVE_TRADING_ENABLED=false
EMERGENCY_STOP=true
X_6551_WSS_ENABLED=false
X_6551_WATCH_APPLY_ENABLED=false
P21_FOLLOW_DISCOVERY_ENABLED=false
GMGN_CREDENTIAL_PROFILE=primary
XBOT_RELEASE_SHA=<40-character-release-commit>
```

Do not enable monitoring or live trading as part of a code deployment. Complete server readiness first, then let the operator explicitly start new buys.

## 瞬态故障恢复契约

GMGN `429`、`RATE_LIMIT_BANNED`、GMGN 调度器冷却、6551 短暂断流和快速缓存临时异常只暂停新买入，不再在固定等待时间后升级为 `fault_protected`。系统优先读取 GMGN 返回的 `reset_at`，将后续请求排到冷却结束后，避免冷却期间重复请求延长封禁；缺少 reset 时使用受限退避。系统保留操作员的启动意图，持续运行订单对账与持仓保护；每等待 5 分钟写入一次 `trade.transient_pause_reminder`，连续三次健康检查通过后自动恢复。Migration 缺失、配置指纹变化、交易权重配置不足、未保护持仓、未解决交易和钱包隔离等非瞬态安全问题仍进入故障保护，必须人工核对。

本地与生产不得长期共用同一 GMGN 凭据进行并发测试。GMGN 限额按账户聚合；确需本地联调时应保持本地 Engine 停止、禁用 cache warmer，或使用独立测试凭据。

## P27 发布顺序

1. 记录服务器当前 release SHA、两个业务进程、Engine 状态、Migration manifest 和未完成 Order/Position。停止新买入，但保持 execution 进程负责对账和平仓。
2. 轮换任何曾在聊天、截图、终端或外部日志中展示过的 API Key。生产必须使用 `GMGN_CREDENTIAL_PROFILE=primary`；`test` profile 会被启动检查拒绝。
3. 备份 PostgreSQL，并在隔离数据库完成恢复校验。至少记录 `pg_dump` 文件 SHA-256、恢复库名、`schema_migrations` 数量和关键表行数。备份文件不得进入 Git 或发布包。
4. 仅从同一 release SHA 的 `deploy/release-allowlist.txt` 生成发布包；执行后端全量测试、前端 lint/build、`npm run audit:release` 和 Migration 演练。
5. P27 首次迁移必须执行 `044 -> 停止`。随后导入已签署的 `backend/db/manifests/p26_80e9f5a_migrations.json`，确认 release SHA `80e9f5a77d62b84f930efd924aed329d4e047515`，再执行 `045 -> 046 -> 047 -> 048 -> 049`。不得跳过 bootstrap 或自动接受 checksum 漂移。`047` 仅补齐精确关联的本地历史 Candidate 元数据；`048-049` 建立唯一 `chain + CA` 的共享 GMGN 元数据和缺失时入队规则。
6. 第二次运行 Migration 必须为零变更；再执行 `npm run audit:schema:production`。发布前把当前 40 位 commit 写入 `XBOT_RELEASE_SHA`，确认 `/api/health.release_sha` 等于本次 P27 发布 commit；`migration_manifest.release_sha` 仍应是签署的 P26 基线，两者不得混用。同时确认 `process_role`、`contract_version=p27.v1` 和 `event_contract_version=p27.events.v1`。
7. `xbot.service` 只启动 Supervisor，Supervisor 只启动一个 `ingestion` 和一个 `execution`。生产禁止 `--role=all`，且启动/恢复不得触发显式 GMGN 诊断。
8. 先保持新买入停止，验证登录、REST、WebSocket entity envelope、Signals、Positions、History、Settings、Order 对账和已有持仓平仓。稳定后由操作员重新启动 Engine。

数据库备份/恢复示例中的路径必须位于服务器受控目录，实际名称由操作员填写：

```bash
pg_dump --format=custom --file=/var/backups/xbot/xbot-before-p27.dump xbot
sha256sum /var/backups/xbot/xbot-before-p27.dump
createdb xbot_p27_restore_check
pg_restore --exit-on-error --clean --if-exists --dbname=xbot_p27_restore_check /var/backups/xbot/xbot-before-p27.dump
```

## P27 应用回滚

P27 Migration `044-049` 是 additive。需要回滚应用时暂停新买入、停止 `asset_metadata` Worker、保留当前数据库 Schema，不执行向下 Migration，然后切回已签署 P26 binary `80e9f5a77d62b84f930efd924aed329d4e047515`。回滚环境不得再次运行旧 migration phase；先以只读方式验证健康查询、历史读取和空队列恢复，再受控验证未完成 Order 对账与已有 Position 平仓。当前自动演练没有让旧 binary 对真实活跃仓位执行写操作，该步骤只能在事故回滚窗口由操作员验收。P26 不写 P27 snapshot/outbox/asset_metadata，因此回滚期只用于事故恢复，不得创建新 Signal 或恢复新买入。恢复 P27 时重新核对 manifest 后再启动。

## P20 发布附加条件

P20 不是一次普通前端发布。服务器发布前必须确认代码、Migration、依赖锁文件和前端构建产物来自同一 commit。Paper 是可选运行阶段；动态实盘不再依赖 7 天 Paper 或账号短时授权，但仍必须同时满足 P20 实盘能力、账号策略 `live + enabled`、当前 Revision、逐链预算、Watch、全局 Engine 和最终交易门禁。

冷部署顺序：

1. 记录服务器当前 commit、服务状态、数据库 Migration 状态和固定 CA 实盘状态；必要时先锁定新买入，但保留对账和离场能力。
2. 只上传 allowlist 中的代码、Migration `000-049`、依赖锁文件和同 release SHA 构建产物；禁止上传 `.env`、API Key、GMGN 私钥、OPENNEWS_TOKEN、ADMIN_TOKEN、数据库密码、日志和数据库 dump。
3. XBOT 使用隔离运行时 `/opt/node-v24.11.1`，npm 为 `11.6.x`；`xbot.service` 必须直接调用该路径，不能替换系统 `/usr/bin/node` 并影响同机项目。再分别执行后端和前端的 `npm ci`；版本不符时停止发布。
4. 应用 Migration 前按 P27 bootstrap 顺序执行独立 Migration phase；再以生产只读方式运行 `npm run audit:schema:production`。必须确认 Migration `027` 至 `049`、动态模板、按链预算、Follow Policy/Event、候选索引、共享限流、Signal snapshot、migration manifest、精确历史元数据回填、共享 `asset_metadata` 和 outbox lease 字段完整。
5. 首次启动保持以下 P20 开关全部为 `false`，并保持 `LIVE_TRADING_ENABLED=false`、`EMERGENCY_STOP=true`、`X_6551_WSS_ENABLED=false`、`X_6551_WATCH_APPLY_ENABLED=false`。先验证 `/api/health`、登录、固定策略、持仓、Settings、WebSocket、TGBOT 和两个生产进程状态。
6. 通过固定链路冒烟后，单独开启 Candidate Index，再开启 Dynamic Resolution 和 Record；观察任务入队、解析审计、失败原因和 Worker 租约，确认没有产生交易 Target、Paper Position 或 Swap。
7. 需要模拟时单独启用 Paper，并保持 `P20_LIVE_ENABLED=false`；确认 Paper 不调用 Swap，且解析、预算和离场策略与目标配置一致。
8. 需要实盘时只配置明确账号和逐链原生币金额，开启 P20 Live 能力后由用户启动全局 Engine。策略修改会产生新 Revision，旧排队任务必须取消；不创建账号短时授权。

## P21 发布附加条件

冷部署必须保持 `P21_FOLLOW_DISCOVERY_ENABLED=false`。固定 CA、动态喊单、持仓和离场回归通过后，先在设置页只开启新关注发现能力，并将策略保持为 Record。确认 Follow 方向、Baseline、永久去重、Target 身份、官网 SSRF 防护、Grok/x_search 证据和本地 RPC 唯一链解析均符合预期后，再单独审批单 KOL 小额 Live。GMGN 不参与人物关系、CA 发现或链识别。开启 P21 能力只重启 ingestion/监控进程，不得自动启动全局 Engine。

生产秘密只存放于 `/opt/xbot/backend/.env`，权限为 `0600`。不要把服务器 `.env`、数据库内容或生产日志复制到 GitHub，也不要把动态兼容白名单记录混入固定 CA 列表或固定策略查找。
