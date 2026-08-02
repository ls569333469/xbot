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
