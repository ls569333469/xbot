# P18 Production Deployment Assets

These files record the configuration deployed to `107.172.78.150` for release `p18.3-production-20260728`.

The production JavaScript runtime is pinned to Node `24.11.x` and npm `11.6.x`. Both package manifests run `deploy/check-node-runtime.js` before dependency installation so a different npm major cannot silently rewrite the lockfiles.

P18.3 keeps the authenticated frontend gate and adds compact whitelist list responses, on-demand detail loading, and Nginx compression for large JSON responses.

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

Do not enable monitoring or live trading as part of a code deployment. Complete the server readiness and explicit live-approval flow separately.

## P20 发布附加条件

P20 不是一次普通前端发布。服务器发布前必须确认本次代码的 commit、数据库 Migration 和构建产物来自同一版本。当前动态策略仍须经过专用测试库验收和至少 7 天 Paper 运行，不能因为代码测试通过就直接开启动态实盘。

冷部署顺序：

1. 记录服务器当前 commit、服务状态、数据库 Migration 状态和固定 CA 实盘状态；必要时先锁定新买入，但保留对账和离场能力。
2. 只上传代码、`backend/db/migrations/032_p20_dynamic_chain_budget_matrix.sql`、依赖锁文件和前端构建产物；禁止上传 `.env`、API Key、GMGN 私钥、OPENNEWS_TOKEN、ADMIN_TOKEN、数据库密码、日志和数据库 dump。
3. 服务器使用 Node `24.11.x`、npm `11.6.x`，分别执行后端和前端的 `npm ci`；版本不符时停止发布，不要强行安装。
4. 启动前执行 Migration，并以生产只读方式运行 `npm run audit:schema:production`；必须确认 Migration `027` 至 `032`、按链预算列、按链使用表、动态解析索引和租约字段完整。
5. 首次启动保持以下 P20 开关全部为 `false`，并保持 `LIVE_TRADING_ENABLED=false`、`EMERGENCY_STOP=true`、`X_6551_WSS_ENABLED=false`、`X_6551_WATCH_APPLY_ENABLED=false`。先验证 `/api/health`、登录、固定策略、持仓、Settings、WebSocket、TGBOT 和两个生产进程状态。
6. 通过固定链路冒烟后，单独开启 Candidate Index，再开启 Dynamic Resolution 和 Record；观察任务入队、解析审计、失败原因和 Worker 租约，确认没有产生交易 Target、Paper Position 或 Swap。
7. Record 稳定后再单独批准 Paper。Paper 期间仍禁止 `P20_LIVE_ENABLED`，并使用目标 Live 配置的同一 revision 连续运行至少 7 天。
8. 7 天 Paper 完成且人工核对通过后，才允许对一个账号、一个链、最小金额创建短时 Live Approval；每次配置修改都会生成新 revision，必须重新 Paper 验收。

生产秘密只存放于 `/opt/xbot/backend/.env`，权限为 `0600`。不要把服务器 `.env`、数据库内容或生产日志复制到 GitHub，也不要把动态兼容白名单记录混入固定 CA 列表或固定策略查找。
