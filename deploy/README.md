# XBOT Production Deployment Assets

These files define the production deployment contract for the current XBOT release.

The production JavaScript runtime is pinned to Node `24.11.x` and npm `11.6.x`. Both package manifests run `deploy/check-node-runtime.js` before dependency installation so a different npm major cannot silently rewrite the lockfiles.

The current release keeps the authenticated frontend gate, fixed CA trading, P19 execution, and the P20 account-scoped dynamic strategy pipeline.

- `xbot.service` runs the supervisor as the unprivileged `xbot` operating-system user.
- `nginx-trading-platform.conf` mounts XBOT at `/xbot/` and preserves TGBOT at `/tg/`.
- `portal/index.html` is the root navigation page.

No `.env`, API token, private key, database password, or database dump belongs in this directory. Production secrets are stored only in `/opt/xbot/backend/.env` with mode `0600`.

The cold deployment contract is:

```dotenv
TRADING_MODE=live
LIVE_TRADING_ENABLED=false
EMERGENCY_STOP=true
X_6551_WSS_ENABLED=false
X_6551_WATCH_APPLY_ENABLED=false
```

Do not enable monitoring or live trading as part of a code deployment. Complete server readiness first, then let the operator explicitly start new buys.

## P20 发布附加条件

P20 不是一次普通前端发布。服务器发布前必须确认代码、Migration、依赖锁文件和前端构建产物来自同一 commit。Paper 是可选运行阶段；动态实盘不再依赖 7 天 Paper 或账号短时授权，但仍必须同时满足 P20 实盘能力、账号策略 `live + enabled`、当前 Revision、逐链预算、Watch、全局 Engine 和最终交易门禁。

冷部署顺序：

1. 记录服务器当前 commit、服务状态、数据库 Migration 状态和固定 CA 实盘状态；必要时先锁定新买入，但保留对账和离场能力。
2. 只上传 Git 中的代码、Migration `033-035`、依赖锁文件和同 commit 构建产物；禁止上传 `.env`、API Key、GMGN 私钥、OPENNEWS_TOKEN、ADMIN_TOKEN、数据库密码、日志和数据库 dump。
3. 服务器使用 Node `24.11.x`、npm `11.6.x`。先确认 systemd 实际调用的 `/usr/bin/node` 也是 `24.11.x`，再分别执行后端和前端的 `npm ci`；版本不符时停止发布。
4. 应用 Migration 前预检模板名称是否存在大小写重复，以及候选索引字段是否超过 1024 bytes。启动后以生产只读方式运行 `npm run audit:schema:production`；必须确认 Migration `027` 至 `035`、动态模板、按链预算、按链使用表、候选索引、Family 拆分和租约字段完整。
5. 首次启动保持以下 P20 开关全部为 `false`，并保持 `LIVE_TRADING_ENABLED=false`、`EMERGENCY_STOP=true`、`X_6551_WSS_ENABLED=false`、`X_6551_WATCH_APPLY_ENABLED=false`。先验证 `/api/health`、登录、固定策略、持仓、Settings、WebSocket、TGBOT 和两个生产进程状态。
6. 通过固定链路冒烟后，单独开启 Candidate Index，再开启 Dynamic Resolution 和 Record；观察任务入队、解析审计、失败原因和 Worker 租约，确认没有产生交易 Target、Paper Position 或 Swap。
7. 需要模拟时单独启用 Paper，并保持 `P20_LIVE_ENABLED=false`；确认 Paper 不调用 Swap，且解析、预算和离场策略与目标配置一致。
8. 需要实盘时只配置明确账号和逐链原生币金额，开启 P20 Live 能力后由用户启动全局 Engine。策略修改会产生新 Revision，旧排队任务必须取消；不创建账号短时授权。

生产秘密只存放于 `/opt/xbot/backend/.env`，权限为 `0600`。不要把服务器 `.env`、数据库内容或生产日志复制到 GitHub，也不要把动态兼容白名单记录混入固定 CA 列表或固定策略查找。
