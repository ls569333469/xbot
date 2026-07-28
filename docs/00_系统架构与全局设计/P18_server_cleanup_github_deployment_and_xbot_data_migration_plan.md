# P18 Server Cleanup, GitHub Deployment, and XBOT Data Migration Plan

> Implementation status (2026-07-28): XBOT release `p18.2-production-20260728` is deployed to `107.172.78.150`; database migration, authenticated frontend gate, Node/npm runtime pinning, local HTTP/API/WebSocket checks, TGBOT regression, and browser layout checks passed. Public DNS remains outside the cutover: `xiexiu.io` currently resolves to `34.84.35.236`, not the new server.

## 1. Scope and decision

This plan covers the production server `107.172.78.150`:

- Keep `TelegramForwarder` (TGBOT) running at `/tg/`.
- Remove the Binance MEME application code from `/opt/meme-radar`.
- Do not back up the MEME code, as explicitly requested.
- Do not delete the `telegram_forwarder` database, TGBOT directory, TGBOT systemd unit, or TGBOT Nginx routes.
- Deploy XBOT from the GitHub release into `/opt/xbot` with a separate `xbot` database and backend port `3011`.
- Add a small navigation page at `/` with links to `/tg/` and `/xbot/`.

The MEME database and old Nginx/systemd references are not deleted in the first cleanup step. They are disabled or removed only after the replacement routes are verified, so a missing path cannot cause an automatic restart loop or an accidental TGBOT outage.

## 2. Verified server state

| Item | Current state | Target state |
|---|---|---|
| TGBOT | `/opt/TelegramForwarder`, `telegram-forwarder.service`, ports `8000/8001` | Keep unchanged |
| Binance MEME | `/opt/meme-radar`, `meme-radar.service`, port `3001` | Stop, disable, remove code |
| XBOT | Not deployed | `/opt/xbot`, `xbot.service`, port `3011` |
| PostgreSQL | `meme_radar`, `telegram_forwarder`, `chanlun` | Add independent `xbot` database |
| Nginx root | MEME frontend | Navigation page |
| Nginx `/tg/` | TGBOT frontend/API/WebSocket | Keep unchanged |
| HTTPS | Server Nginx listens on port `80`; no local `443` listener | Verify the upstream TLS/proxy layer before release |

## 3. MEME removal boundary

The safe order is:

1. Confirm the exact service and path are `meme-radar.service` and `/opt/meme-radar`.
2. Stop and disable `meme-radar.service` so it cannot restart after its code is removed.
3. Remove `/opt/meme-radar` only.
4. Leave `meme_radar` temporarily untouched unless a separate database deletion is approved.
5. Remove the old MEME Nginx root/API locations when the navigation page and XBOT routes are ready.

No MEME code archive is created. This means MEME cannot be rolled back from the server after deletion.

## 4. GitHub release requirements

The current local repository points to `https://github.com/ls569333469/xbot.git`, but the working tree contains extensive uncommitted P16/P17 changes. The server must not clone `main` until the current release is reviewed and pushed.

Release gate:

1. Inspect `git diff --stat` and review the production changes.
2. Confirm `backend/.env`, all PEM/private-key files, database dumps, and local credentials are not tracked by Git.
3. Run backend unit tests and the frontend build.
4. Run the guarded migration rehearsals against dedicated test databases, not `xbot`.
5. Commit the release and create a tag such as `p17-production-20260728`.
6. Push the tag/commit to the private GitHub repository.
7. Let the server pull through a GitHub Deploy Key or a release artifact. Do not place a GitHub token in the repository or in the runtime `.env`.

The release must include the `/xbot/` path adaptation described below. A root-path build is not production-ready for this deployment.

## 5. XBOT production environment

The server-side `/opt/xbot/backend/.env` is created separately from GitHub. Required groups are:

- Process: `BACKEND_HOST=127.0.0.1`, `BACKEND_PORT=3011`, `XBOT_PROCESS_ROLE=all`.
- Database: `DB_HOST=127.0.0.1`, `DB_PORT=5432`, `DB_NAME=xbot`, dedicated XBOT database user/password.
- Trading: `TRADING_MODE`, `LIVE_TRADING_ENABLED`, `GMGN_API_KEY`, `GMGN_PRIVATE_KEY`, and `GMGN_KEY_EXCLUSIVE`.
- Chains: Solana, BSC, Base, Ethereum, and Robinhood RPC URLs plus chain fee/gas reserves.
- Monitoring: `OPENNEWS_TOKEN`, WSS/watch flags, heartbeat, reconnect, and message limit values.
- Research: `XAI_API_KEY`, `XAI_BASE_URL`, `XAI_MODEL` when Grok research is enabled.
- Control: a new production `ADMIN_TOKEN`.

The production `.env` is transferred through the server administration channel and is never committed to GitHub. The root password currently placed in the local XBOT `.env` must be removed before the release is pushed and rotated after deployment.

## 6. XBOT path and navigation design

The current XBOT frontend assumes root paths: API `/api`, WebSocket `/ws`, and BrowserRouter `/`. Serving it directly at `/xbot/` therefore needs a deployment-path adaptation:

- Build static assets with base path `/xbot/`.
- Use `/xbot` as the router basename.
- Use `/xbot/api` for browser API requests.
- Use `/xbot/ws` for the browser WebSocket.
- Nginx strips `/xbot` and proxies the backend requests to `127.0.0.1:3011`.

The production frontend build uses:

```bash
VITE_PUBLIC_BASE=/xbot/ VITE_API_URL=/xbot VITE_WS_PATH=/xbot/ws npm run build
```

The local development build keeps the default `/`, `/api`, and `/ws` paths.

The root page is a small static portal with two explicit links:

- `xiexiu.io/tg/` -> TGBOT
- `xiexiu.io/xbot/` -> XBOT

The portal does not expose tokens, API health details, server paths, or administrative controls.

## 7. XBOT database migration

Only XBOT data is migrated. MEME data is not imported into XBOT, and TGBOT data is not touched.

Source preparation:

1. Finish the local XBOT migrations through `025`.
2. Disarm the local engine, stop the local supervisor and both worker roles, and confirm there is no local `3011` listener before taking the final snapshot.
3. Generate a new custom-format dump from the quiesced local `xbot` database. The existing `xbot-pre-p17-20260727-144720.dump` is a pre-P17 checkpoint and must not be treated as the final production source without verification.
4. Record the migration version, row counts for whitelist/KOL/relation/trade tables, and the dump SHA-256.

Server import:

1. Create the independent `xbot` database and, preferably, a dedicated `xbot_user` role.
2. Transfer the dump over the protected SSH channel, outside the Git checkout.
3. Restore with `pg_restore --no-owner --no-acl` into the empty `xbot` database.
4. Run the application migration audit and confirm migration `025` is current.
5. Verify whitelist, KOL, relation, research, trade-attempt, position, and outbox counts.
6. Start XBOT only after database readiness passes.

The first server start is a cold deployment and must override any migrated runtime state with:

```dotenv
TRADING_MODE=live
LIVE_TRADING_ENABLED=false
EMERGENCY_STOP=true
X_6551_WSS_ENABLED=false
X_6551_WATCH_APPLY_ENABLED=false
```

`TRADING_MODE=paper` is not used because the current runtime rejects it unless the legacy paper engine is explicitly re-enabled. `TRADING_MODE=live` does not permit an order while `LIVE_TRADING_ENABLED=false`, `EMERGENCY_STOP=true`, and the persisted engine state is stopped.

This prevents the local and server instances from simultaneously consuming 6551 events, changing remote Watches, or executing a trade. The local supervisor remains stopped after the snapshot. Only after the server UI, API, database counts, WebSocket route, and TGBOT regression checks pass may 6551 ingestion be moved to the server. Live trading remains disabled until the existing readiness and live-approval flow is explicitly completed on the server.

The systemd unit must start `backend/scripts/supervisor.js` through `npm start` (or the equivalent absolute Node command), not a single `server.js` process. This keeps the ingestion and execution roles isolated as designed by the backend supervisor.

The migration is a database snapshot transfer, not a conversion from MEME schema. If the local XBOT database contains no business data, use a fresh schema initialization plus seed data instead of importing historical test rows.

## 8. Cutover and verification

1. Keep TGBOT running throughout the cutover.
2. Stop/disable MEME and remove its code.
3. Start XBOT on `127.0.0.1:3011`.
4. Validate `/xbot/api/health`, admin authentication, frontend API calls, and WebSocket connectivity.
5. Validate `/tg/`, TGBOT API, TGBOT WebSocket, and Telegram forwarding.
6. Validate the public HTTPS route through the external TLS/proxy layer.
7. Confirm port `3001` is no longer used and port `3011` is owned by XBOT.
8. Confirm the local XBOT supervisor is stopped and only the server deployment can own 6551 ingestion and GMGN execution credentials.
9. Keep server live trading disabled after technical deployment; activation requires a separate production readiness and approval action.
10. Delete the remaining MEME database and old systemd/Nginx references only after separate confirmation.

The public DNS gate is independent of server health. Before declaring `https://xiexiu.io/xbot/` live, the DNS A record and HTTPS termination must route `xiexiu.io` to `107.172.78.150`. Until that change, the verified server entry is `http://107.172.78.150/xbot/`; the existing host at `34.84.35.236` must not be overwritten as part of this plan.

The release gate also includes:

- `npm run build` with the `/xbot/` variables above.
- A built `index.html` whose asset URLs start with `/xbot/`.
- A browser smoke test for `/xbot/`, `/xbot/api/health`, authenticated API calls, and `/xbot/ws`.
- A separate smoke test confirming `/tg/` assets, API, and WebSocket remain unchanged.

## 9. Explicit non-goals

- Do not upload `.env`, PEM keys, root passwords, database dumps, or private session files to GitHub.
- Do not reuse TGBOT's database or runtime directory for XBOT.
- Do not expose XBOT API or WebSocket on a public standalone port.
- Do not start live trading merely because the service is healthy; XBOT still requires the existing readiness and live-approval flow.

## 10. P18.4 production synchronization and latency correction

The post-deployment audit found two release defects that are part of P18 rather than new trading behavior.

### 10.1 Watch demand must be idempotent

Whitelist saves currently requeue every related 6551 Watch even when only budget or exit settings changed. When `X_6551_WATCH_APPLY_ENABLED=false`, those unnecessary rows remain pending and block whitelist activation.

P18.4 stores an exact demand snapshot on each Watch Outbox row:

- whether a managed remote Watch is currently required;
- the complete normalized 6551 flag set;
- a SHA-256 fingerprint of those two values.

An Outbox version advances only when that fingerprint changes or when the observed remote state drifts from the current demand. Repeated saves with an already synchronized Watch complete as a no-op. Remote flags are compared exactly against the global union of all active whitelist and launch-monitor requirements; a stale remote superset is not accepted after an event type is removed.

If a real Watch change is required while Watch apply is disabled, activation fails once with `WATCH_SYNC_DISABLED`. It must not retry five times as `WATCH_SYNC_PENDING`. Enabling Watch apply and explicitly retrying activation remains an operator action.

### 10.2 Settings must not wait for the remote 6551 API

The settings page loads engine state, environment configuration, runtime policy, and chain configuration as its core payload. The 6551 diagnostics load only after the operator opens the status tab. A slow or unavailable remote Watch list therefore cannot hold the full page skeleton.

The backend caches the remote Watch count for 60 seconds. The explicit refresh button bypasses that cache; normal page navigation does not repeatedly spend a remote API request.

### 10.3 Release acceptance

P18.4 is accepted only when all of the following pass:

1. An in-sync Watch plus a budget-only or exit-only whitelist edit does not become pending.
2. Adding or removing a required event flag changes the fingerprint and queues a real Watch update.
3. Watch apply disabled produces `WATCH_SYNC_DISABLED` without the five-attempt delay.
4. Settings core content renders without waiting for `/api/x-monitor/6551/status`.
5. Unit, integration, frontend lint/build, schema audit, privacy scan, and production smoke tests pass.
6. Existing production failed rows are repaired only after migration `026` is applied and their current global demand is recalculated.

P18.4 does not enable live trading, 6551 WSS ingestion, or remote Watch writes. Those flags retain their existing production values until separately approved.
