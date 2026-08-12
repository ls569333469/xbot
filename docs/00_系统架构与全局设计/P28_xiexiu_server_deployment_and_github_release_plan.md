# P28 xiexiu 服务器部署与 GitHub 发布方案

> 版本：v1.3
> 日期：2026-08-12
> 状态：GitHub 发布与 xiexiu 技术部署已完成；生产保持冷启动，三策略真实资金验收待用户单独批准
> 前置版本：P27 v1.3
> 目标：将已验收的 P27 工作区固化为唯一 GitHub Release SHA，并把完全相同的版本安全部署到 `https://xiexiu.io/xbot/`

> 执行校正：第 1-13 节保留部署前方案与控制边界，第 14-15 节记录 2026-08-12 的实际执行结果。若部署前快照与执行结果冲突，以第 14-15 节为准。

## 1. 当前事实与发布边界

截至本文创建时，已核对的事实为：

| 项目 | 当前状态 |
|---|---|
| 本地分支 | `codex/p26-production-hardening` |
| 本地已提交 HEAD | `a34f62a`，包含 3 个尚未推送的提交 |
| 本地工作区 | 仍包含 P27 `048-049`、共享元数据、History 和文档等未提交修改 |
| GitHub 分支 | `origin/codex/p26-production-hardening` 仍为 `5a6d326` |
| GitHub `main` | `da5f853` |
| xiexiu 健康接口 | HTTP 200，但只返回旧式健康字段，未返回 `release_sha`、`contract_version` 和 `event_contract_version` |
| 生产入口 | `https://xiexiu.io/xbot/` |
| 服务器应用目录 | `/opt/xbot`；当前为无 `.git` 的发布副本，历史版本由 `/opt/xbot-releases/CURRENT` 和发布目录名记录 |
| 后端 | `127.0.0.1:3011`，systemd `xbot.service` |
| 生产运行时 | `/opt/node-v24.11.1`，Node `24.11.x` / npm `11.6.x` |
| 数据库 | 独立 PostgreSQL `xbot` |
| 服务器当前迁移 | `000-035`；P28 必须先应用 `036-044` 并在 `044` 停止，再导入 P26 签署基线，最后应用 `045-049` |
| 服务器 GitHub 获取能力 | SSH Deploy Key 未配置；GitHub HTTPS 只读访问可用，发布只允许按不可变 production tag 获取并核对 40 位 SHA |
| 首次发布候选 | `p27-production-20260812` 指向 `7f6a81ed42546f297b0443f8e08a28a35376a394`，服务器干净 `npm ci` 发现 lockfile 无版本节点，tag 保留审计但禁止部署 |
| 修订发布 tag | `p27.1-production-20260812`；必须包含 lockfile 修复和 Release Audit 的 lock 节点完整性检查 |

P28 把 GitHub 发布和服务器部署分成两个独立批准动作：

1. **GitHub 发布批准**：允许提交、推送分支和不可变 tag，不授权登录服务器或改变生产状态。
2. **服务器部署批准**：允许服务器备份、代码切换、Migration、systemd/Nginx 验证，不授权启动真实买入。
3. **实盘恢复批准**：技术部署验收通过后，用户单独在设置页恢复 6551 和全局 Engine；部署脚本不得自动执行。

禁止把以下状态混为一谈：

- 本地测试通过不等于 GitHub 已推送；
- GitHub 已推送不等于服务器已部署；
- 服务器健康不等于实盘已经启用；
- `migration_manifest.release_sha` 是 P26 签署迁移基线，不是当前应用 Release SHA。

## 2. P28 标准发布链路

```text
P27 本地工作区
  -> 最终测试 / Secret / Release Audit
  -> 形成唯一 Git commit
  -> 推送 GitHub 分支
  -> 核对远端 SHA
  -> 创建并推送不可变 production tag
  -> 服务器记录旧版本和运行状态
  -> 停止新买入，保留既有退出能力至切换窗口
  -> PostgreSQL 备份和隔离恢复验证
  -> 服务器只获取已批准 tag/SHA
  -> 安装依赖并构建前端
  -> 短暂停止 xbot.service
  -> 从当前 035 按顺序迁移 036-049，并在 044 导入签署基线
  -> Supervisor 启动 ingestion + execution
  -> 保持 6551/新买入关闭完成验收
  -> 用户单独批准恢复监控和实盘
```

生产服务器不得 `git pull` 一个会移动的分支后直接启动，也不得部署本地未提交目录。服务器只消费经过核对的 40 位 Release SHA 或指向该 SHA 的不可变 production tag。

## 3. GitHub 推送方案

### 3.1 提交前冻结和核对

提交前记录以下证据：

```powershell
git status --short --branch
git diff --check
git diff --stat
git log --oneline --decorate -8
git remote -v
```

必须确认：

- `.env`、日志、数据库 dump、截图、私钥、PEM、构建目录和测试交易脚本没有进入 Git。
- `backend/db/migrations/048_p27_shared_gmgn_asset_metadata.sql` 和 `049_p27_metadata_enqueue_missing_only.sql` 已纳入发布。
- P27 v1.3、P27 自动验收报告、P28 和 `deploy/README.md` 的 Migration 范围均为 `000-049`。
- 不修改或重写已经发布的 Migration `000-049`；只提交当前已验收内容。
- 不使用 `git reset --hard`、强制推送或覆盖远端历史。

### 3.2 最终本地发布门

在准备提交的同一工作区执行：

```powershell
cd D:\Axiangmu\xbot\backend
npm.cmd test
$env:XBOT_TEST_DB_NAME='xbot_p27_test'
npm.cmd run test:migration:p27
npm.cmd run test:integration
npm.cmd run audit:schema:production
npm.cmd run audit:release

cd D:\Axiangmu\xbot\frontend
npm.cmd run lint
npm.cmd run build

cd D:\Axiangmu\xbot
git diff --check
```

Migration 演练和数据库集成测试必须按上述顺序使用同一个、名称包含 `test` 的独立数据库。演练负责重建测试库、执行 `044 -> manifest import -> 045-049`；集成测试随后在该完整 Schema 上运行。任一命令失败即停止发布，不允许通过删除测试或降低断言继续。

提交后再次运行 `npm.cmd run audit:release`，确保最终 commit 而不是提交前工作区通过发布审计。

### 3.3 Commit、分支和 Tag

推荐使用一个最终收口提交保存 P27 v1.3 与 P28 文档：

```text
feat: finalize P27 shared metadata and P28 deployment release
```

禁止使用未经审核的 `git add .`。按 `git status --short` 逐项核对后，只暂存本次 P27/P28 文件；暂存完成必须检查：

```powershell
git diff --cached --check
git diff --cached --stat
git diff --cached
```

确认 staged diff 不含 Secret、日志、dump、`dist` 或无关修改后再提交：

```powershell
git commit -m "feat: finalize P27 shared metadata and P28 deployment release"
$releaseSha = git rev-parse HEAD
git status --short --branch
```

提交后定义：

```text
RELEASE_SHA = git rev-parse HEAD 的完整 40 位值
RELEASE_TAG = p27.1-production-20260812
RELEASE_BRANCH = codex/p26-production-hardening
```

执行顺序：

1. 推送 `codex/p26-production-hardening`，禁止 force push：

   ```powershell
   git push origin HEAD:refs/heads/codex/p26-production-hardening
   git ls-remote origin refs/heads/codex/p26-production-hardening
   ```

2. 使用 `git ls-remote` 核对 GitHub 分支 SHA 与 `RELEASE_SHA` 完全一致。
3. 复核 GitHub diff、Release Audit 和测试证据。
4. 创建 annotated tag `p27.1-production-20260812`，tag 必须指向同一 `RELEASE_SHA`：

   ```powershell
   git tag -a p27.1-production-20260812 $releaseSha -m "P27.1 production release 2026-08-12"
   git push origin refs/tags/p27.1-production-20260812
   git ls-remote origin refs/tags/p27.1-production-20260812 'refs/tags/p27.1-production-20260812^{}'
   ```

5. 对 annotated tag 以 `^{}` 行的 commit SHA 为准，再次核对它等于 `RELEASE_SHA`。
6. `main` 更新单独执行；只允许 fast-forward 或经审查的 PR，不允许为了同步而重写 `main`。服务器部署不依赖 `main`，只依赖已批准 tag/SHA。

GitHub 发布完成的判定是：

```text
本地 HEAD SHA
  = GitHub release branch SHA
  = production tag 指向 SHA
  = Release Audit 记录 SHA
```

## 4. Secret 与双实例边界

服务器部署前必须轮换任何曾出现在聊天、截图、终端或外部日志中的 GMGN/API Key。不得把新 Secret 写入 GitHub、P28 文档、部署日志或命令历史。

生产环境要求：

```dotenv
GMGN_CREDENTIAL_PROFILE=primary
XBOT_RELEASE_SHA=<RELEASE_SHA>
TRADING_MODE=live
LIVE_TRADING_ENABLED=false
EMERGENCY_STOP=true
X_6551_WSS_ENABLED=false
X_6551_WATCH_APPLY_ENABLED=false
P21_FOLLOW_DISCOVERY_ENABLED=false
```

生产 `.env` 只保存在 `/opt/xbot/backend/.env`，属主为 `xbot:xbot`，权限 `0600`。测试 API 必须使用 `GMGN_CREDENTIAL_PROFILE=test` 并运行在隔离进程或机器上。

在把 6551 所有权切到服务器前：

- 本地 Engine 必须停止；
- 本地 Supervisor 必须停止或确认使用完全隔离的测试凭据；
- 本地不得继续应用 Watch、消费同一 6551 WSS 或使用生产 GMGN Key；
- 同一时间只允许一套生产 ingestion 和一套生产 execution。

## 5. 服务器部署前只读盘点

进入服务器后先只读记录，不立即修改：

1. 当前 `/opt/xbot-releases/CURRENT`、发布目录名、`RELEASE` 标记和代码工作区指纹；若目录带 `.git` 才记录 Git SHA、branch/tag 和工作区状态。无 `.git` 时不得伪造 Git SHA。
2. `xbot.service`、Supervisor、ingestion、execution 的 PID 与启动时间。
3. `/api/health`、`/api/system/engine-status`、readiness 和 provider audit。
4. `schema_migrations`、`release_migration_manifests` 最新记录。
5. 未完成 Order、Attempt、Strategy Group、打开 Position 和钱包隔离状态。
6. Nginx `/xbot/`、`/xbot/api/`、`/xbot/ws` 与 `/tg/` 当前状态。
7. PostgreSQL、磁盘空间、Node/npm 和系统时间。

必须把旧版本记录为：

```text
OLD_RELEASE_SHA=<server current 40-character SHA>
OLD_MIGRATION=<server current last migration>
OLD_ENGINE_STATUS=<running/stopped/fault>
OLD_OPEN_POSITION_COUNT=<count>
OLD_PENDING_ORDER_COUNT=<count>
```

若服务器工作区存在未提交代码，立即停止部署；不得擅自 stash、reset 或覆盖。先确认这些修改的所有者和用途。

## 6. 备份与恢复验证

停止新买入后，旧 execution 可继续对账和平仓，直到进入短暂代码切换窗口。数据库备份必须先于 Migration：

```bash
sudo -u postgres pg_dump --format=custom --file=/var/backups/xbot/xbot-before-p28-<timestamp>.dump xbot
sha256sum /var/backups/xbot/xbot-before-p28-<timestamp>.dump
sudo -u postgres pg_restore --list /var/backups/xbot/xbot-before-p28-<timestamp>.dump
```

在隔离恢复库验证：

```bash
sudo -u postgres createdb xbot_p28_restore_check
sudo -u postgres pg_restore --exit-on-error --clean --if-exists \
  --dbname=xbot_p28_restore_check /var/backups/xbot/xbot-before-p28-<timestamp>.dump
```

记录 `schema_migrations` 数量以及 KOL、Whitelist、Signal、Attempt、Order、Position、Lot、Strategy Group、Outbox、`asset_metadata` 的行数。备份和恢复库不得进入 GitHub 或公开目录。

备份文件 SHA、恢复验证或关键表行数不一致时停止部署。

## 7. 服务器代码获取与构建

推荐在 `/opt` 同一文件系统创建临时发布目录，例如：

```text
/opt/xbot-release-<RELEASE_SHA>
```

当前仓库允许服务器通过 GitHub HTTPS 只读获取。发布目录只能从 production tag 创建，禁止把 GitHub Token 写入 `.env`、clone URL 或命令历史；若仓库以后改为私有，再单独配置只读 Deploy Key。示例：

```bash
git clone --filter=blob:none --single-branch --branch p27.1-production-20260812 \
  https://github.com/ls569333469/xbot.git /opt/xbot-release-<RELEASE_SHA>
```

核对：

```text
git rev-parse HEAD = RELEASE_SHA
git status --porcelain = 空
git tag --points-at HEAD 包含 RELEASE_TAG
```

然后使用固定运行时安装和构建：

```bash
cd /opt/xbot-release-<RELEASE_SHA>/backend
PATH=/opt/node-v24.11.1/bin:$PATH /opt/node-v24.11.1/bin/npm ci
PATH=/opt/node-v24.11.1/bin:$PATH /opt/node-v24.11.1/bin/npm run audit:release

cd /opt/xbot-release-<RELEASE_SHA>/frontend
PATH=/opt/node-v24.11.1/bin:$PATH VITE_PUBLIC_BASE=/xbot/ /opt/node-v24.11.1/bin/npm ci
PATH=/opt/node-v24.11.1/bin:$PATH VITE_PUBLIC_BASE=/xbot/ /opt/node-v24.11.1/bin/npm run build
```

把现有生产 `.env` 通过服务器本地受控复制放入新 release 的 `backend/.env`，再更新冷部署开关和 `XBOT_RELEASE_SHA`；不得从本地电脑或 GitHub 下载 `.env`。设置 `xbot:xbot` 和 `0600`。

切换前运行 `deploy/check-node-runtime.js`、环境检查和只读 Release Audit。不要在旧服务仍使用 `/opt/xbot` 时直接修改其代码、依赖或前端 `dist`。

## 8. 受控切换与 Migration `036-049`

### 8.1 进入短暂停机窗口

1. 通过 API 停止全局 Engine，确认 `desiredRunning=false`、`armed=false`。
2. 确认没有正在提交的 Swap、Sell Attempt 或不确定写请求。
3. 保留当前数据库和旧 release 目录作为回滚证据。
4. `systemctl stop xbot.service`，确认 ingestion/execution 均退出且端口 `3011` 已释放。
5. 不停止 PostgreSQL、Nginx 或 TGBOT。

应用目录切换必须在同一文件系统上完成，并保留旧目录，例如：

```text
/opt/xbot-rollback-<OLD_RELEASE_SHA>
/opt/xbot                       -> 新 RELEASE_SHA
```

同时从 GitHub 的已推送 commit 准备已验证 P26 rollback binary：

```text
/opt/xbot-rollback-p26-80e9f5a77d62b84f930efd924aed329d4e047515
```

执行目录移动前必须分别核对真实绝对路径，禁止通配符、递归删除和覆盖已有 rollback 目录。Migration 前失败可切回原 `OLD_RELEASE_SHA`；Migration `044-049` 已应用后，只允许切回已验证的 P26 rollback binary，不能默认假设任意旧服务器版本都兼容 P27 Schema。

### 8.2 Migration bootstrap

在新 release 的 `backend` 中显式执行 Migration，不依赖第一次 systemd 启动碰运气：

```bash
cd /opt/xbot/backend
PATH=/opt/node-v24.11.1/bin:$PATH /opt/node-v24.11.1/bin/npm run migrate
```

当前服务器从 Migration `035` 升级。第一次运行会依次应用 `036-044`，在应用 `044_p27_migration_manifest.sql` 后返回 `MIGRATION_BASELINE_REQUIRED` 并停止。此时必须确认输出的 `applied` 恰好为 `036-044`，再人工核对已签署 manifest 后执行：

```bash
/opt/node-v24.11.1/bin/node scripts/import-migration-manifest.js \
  --manifest db/manifests/p26_80e9f5a_migrations.json \
  --confirmed-by <operator> \
  --confirmation-note 'P28 xiexiu production migration baseline reviewed' \
  --confirmation 'IMPORT SIGNED MIGRATION BASELINE'
```

以上命令从 `/opt/xbot/backend` 运行，因此使用 `db/manifests/p26_80e9f5a_migrations.json`。若改从仓库根目录运行才使用 `backend/db/...`；路径必须先确认存在。

随后执行：

```bash
PATH=/opt/node-v24.11.1/bin:$PATH /opt/node-v24.11.1/bin/npm run migrate
PATH=/opt/node-v24.11.1/bin:$PATH /opt/node-v24.11.1/bin/npm run migrate
PATH=/opt/node-v24.11.1/bin:$PATH /opt/node-v24.11.1/bin/npm run audit:schema:production
```

验收标准：

- 当前生产 Migration 顺序为 `036 -> 037 -> 038 -> 039 -> 040 -> 041 -> 042 -> 043 -> 044 -> manifest import -> 045 -> 046 -> 047 -> 048 -> 049`；
- 第二次 `npm run migrate` 的 `applied` 为空；
- 所有 checksum 与签署基线一致；
- `asset_metadata` 表、唯一键、claim 索引和 Signal 入队 trigger 存在；
- 任何 `MIGRATION_CHECKSUM_MISMATCH`、`MIGRATION_FILE_MISSING` 或非预期 SQL 错误都立即停止，不允许手工跳过 migration row。

## 9. Supervisor、Nginx 与冷启动验收

启动服务：

```bash
systemctl daemon-reload
nginx -t
systemctl start xbot.service
systemctl status xbot.service
```

必须确认：

- systemd 使用 `/opt/node-v24.11.1/bin/node /opt/xbot/backend/scripts/supervisor.js`；
- 只有一个 Supervisor、一个 ingestion、一个 execution；
- 未出现 `--role=all`；
- 后端只监听 `127.0.0.1:3011`；
- `/api/health.release_sha = RELEASE_SHA`；
- `contract_version=p27.v1`；
- `event_contract_version=p27.events.v1`；
- `process_role=execution`；
- Migration manifest 仍显示签署的 P26 基线，不能被误认为应用 Release SHA；
- Engine 保持 stopped/disarmed，6551 WSS 与 Watch Apply 保持关闭；
- 启动窗口没有 GMGN readiness probe、预热、Trenches 或批量 Token/Security/Pool 调用。

Nginx 不改变 `/tg/`，只验证：

- `https://xiexiu.io/` 门户正常；
- `https://xiexiu.io/xbot/` 前端正常；
- `/xbot/api/health`、鉴权 API、WebSocket 正常；
- `/tg/` 前端、API 和 WebSocket 与发布前一致；
- TLS 证书、重定向和 `nginx -t` 正常。

## 10. P27/P28 部署后功能验收

在新买入关闭状态下完成：

1. `/signals`、`/positions`、`/history`、`/settings` 桌面和移动端 DOM 回归。
2. Signal 与 Position 对同一 `chain + CA` 显示相同名称、Symbol 和 Logo。
3. 连续刷新 Signal/Position 各 5 次，GMGN 审计新增页面来源调用必须为 0。
4. 新缺失元数据只创建一个 `asset_metadata` 行；Worker 每次只处理一个资产，GMGN 忙时跳过。
5. `token/info` 回填不得创建 Trade Intent、Attempt、Swap 或 Position。
6. `/history` 表头、订单号和 Tx Hash 不逐字换行，表内横向滚动不造成页面根级溢出。
7. Provider Audit 无未知来源、重复 Swap、未授权买入和 429。
8. 保护策略同步只能处理 due 的已有 Strategy Group；记录频率和 backlog，不把合法同步误报为未触发买入。
9. 已有 Order 对账、已有持仓读取和人工平仓准备流程正常。
10. Telegram/TGBOT 不受本次 XBOT 发布影响。

验收观察期内不得通过显式诊断制造额外 GMGN 调用。若出现 429，记录 endpoint/source/stage/reset_at，保持 Engine 停止并等待冷却，禁止循环重试。

## 11. 实盘恢复顺序

服务器技术验收通过不自动恢复交易。由用户单独批准后按顺序执行：

1. 确认本地生产 Supervisor 已停止，生产凭据只在 xiexiu 服务器使用。
2. 开启 6551 WSS，但保持 Watch Apply 和 Engine 停止，确认单一连接和事件流。
3. 开启 Watch Apply，核对计划差异和幂等，不重复创建 Watch。
4. 固定 CA、P20、P21 分别先检查策略配置、预算、链和状态。
5. 使用 `/api/system/arm/prepare` 的默认 `probe=false` 生成快照。
6. 用户在设置页完成二次确认后启动 Engine。
7. 按 Fixed -> P20 -> P21 顺序分别执行一笔真实小额 Signal、买入、保护策略和平仓闭环。
8. 每笔完成后核对 Attempt、Swap 幂等、Receipt、Position/Lot、预算账本和 GMGN 审计，再进行下一策略。

任何策略失败不得切换到降级链路或批量重试。先根据 Signal、Attempt、Provider Audit 和 Receipt 定位，再决定修复或回滚。

## 12. 停止条件

出现以下任一情况立即停止发布或恢复实盘：

- GitHub branch、tag、服务器 `HEAD`、`XBOT_RELEASE_SHA` 任一不一致；
- Git 工作区不干净或服务器存在未知修改；
- Secret 尚未轮换、权限不是 `0600`，或生产使用 test profile；
- 数据库备份不可读、恢复失败或关键表行数异常；
- Migration checksum/file mismatch、非预期跳号或第二次运行仍有变更；
- Supervisor 进程重复、出现 `--role=all`、端口或角色错误；
- 本地与服务器同时消费生产 6551 或使用同一生产 GMGN 凭据；
- Nginx、TLS、`/tg/`、TGBOT 或现有持仓退出能力回归失败；
- 页面刷新触发 GMGN、未命中策略触发买入调用、同 Attempt 重复 Swap；
- `RATE_LIMIT_BANNED`、429 无受控冷却、GMGN Schema/签名异常；
- Signal/Position 字段不一致、元数据成为交易门禁或历史交易数据被改写。

## 13. 回滚方案

### 13.1 应用回滚

P27 Migration `044-049` 均为 additive。应用代码故障时：

1. 停止新买入并保持 Engine disarmed。
2. 停止 `xbot.service`。
3. 保留当前数据库 Schema，不执行 down migration，不删除 `asset_metadata`。
4. 若尚未应用 `044-049`，可切回 `/opt/xbot-rollback-<OLD_RELEASE_SHA>`；若 Migration 已应用，切回 `/opt/xbot-rollback-p26-80e9f5a77d62b84f930efd924aed329d4e047515`。
5. 确认旧 release `.env` 仍使用安全冷启动开关。
6. 启动旧 Supervisor，只做健康读取、已有 Order 对账和受控平仓验证；禁止创建新 Signal 或恢复新买入。

已验证 P26 binary 不写 P27 snapshot/outbox/asset_metadata。迁移后的回滚期只能作为事故恢复窗口，不能使用未验证的历史 binary，恢复 P27 前重新核对 manifest 和新 release SHA。

### 13.2 数据库恢复

只有 Migration 造成无法通过应用回滚恢复的数据破坏，并经过单独批准后，才允许从 P28 备份恢复数据库。恢复会覆盖部署后的新交易数据，因此必须先保存事故窗口内 Order、Receipt、Position、Lot 和审计证据，不能自动执行。

### 13.3 GitHub 回滚

- production tag 不移动、不删除、不重新指向其他 SHA；
- 修复使用新 commit 和新 tag，例如 `p27.1-production-20260812`；
- 不 force push 发布分支或 `main`；
- 服务器回滚通过检出已记录的 `OLD_RELEASE_SHA`，不是修改 GitHub 历史。

## 14. 发布证据与完成定义

最终 P28 部署报告必须记录：

| 证据 | 结果 |
|---|---|
| 本地 release SHA | `9f019b498f2274e515524f5ff635632597fc2b7a` |
| GitHub branch SHA | `codex/p26-production-hardening` -> `9f019b498f2274e515524f5ff635632597fc2b7a` |
| GitHub production tag / SHA | `p27.1-production-20260812` -> `9f019b498f2274e515524f5ff635632597fc2b7a`；旧 `p27-production-20260812` 保留审计且禁止部署 |
| 服务器旧 SHA / 新 SHA | `da5f853` -> `9f019b498f2274e515524f5ff635632597fc2b7a` |
| P26 rollback SHA / 目录 | `80e9f5a77d62b84f930efd924aed329d4e047515` / `/opt/xbot-rollback-p26-80e9f5a77d62b84f930efd924aed329d4e047515` |
| 数据库备份路径 / SHA-256 | `/var/backups/xbot/xbot-before-p28-20260812-220515.dump` / `74d7b12e2dd3f20e86b182fd6b318a32ca2ad83de648e933d2bf32b43b9f85d1`；`postgres:postgres 0600`，隔离恢复通过 |
| Migration 最终版本 / 二次零变更 | `049_p27_metadata_enqueue_missing_only.sql`，共 50 条；第二次 `applied=[]`；生产 Schema Audit 通过 |
| `/api/health` 版本字段 | `release_sha=9f019b...`、`code_version=p27.1-production-20260812+workspace-...`、`process_role=execution`、`contract_version=p27.v1`、`event_contract_version=p27.events.v1` |
| Supervisor/ingestion/execution PID | 最终重启后 `737748 / 737768 / 737769`；仅一套双角色进程，监听 `127.0.0.1:3011` |
| Signal/Position 页面 GMGN 增量 | 鉴权 GET 各刷新 5 次，GMGN 总调用增量 `0` |
| GMGN 429 / 未知请求 / 重复 Swap | 本次刷新和最终重启验收窗口 429 增量 `0`；Engine 关闭期间没有创建 Swap。历史累计事件不作为本窗口新增错误 |
| `/xbot/` DOM 与 `/tg/` 回归 | 公网均 HTTP 200；登录页桌面/`390x844` 无横向溢出、越界元素或控制台错误；`/tg/` 登录页正常。公网登录后业务页 DOM 因生产口令不得回显到自动化环境，待管理员登录后补验 |
| Fixed/P20/P21 真实闭环 | 未执行；生产 `armed=false`、`desiredRunning=false`、`LIVE_TRADING_ENABLED=false`、`EMERGENCY_STOP=true`，等待用户单独批准 |
| 回滚目录和恢复命令已核对 | 旧应用 `/opt/xbot-rollback-da5f853-20260812`、P26 回滚目录和数据库备份均已记录至 `/opt/xbot-releases/CURRENT` |

只有同时满足以下条件才能宣布 P28 完成：

1. GitHub 分支与 production tag 均指向唯一 `RELEASE_SHA`；
2. xiexiu 服务器运行同一 `RELEASE_SHA` 和 P27 `p27.v1` 契约；
3. Migration `000-049`、Schema Audit、双角色 Supervisor、Nginx/TGBOT 验收通过；
4. 页面刷新 GMGN 调用为 0，共享元数据回填没有 429 且不影响交易；
5. 本地生产实例停止，服务器成为唯一生产 Provider 所有者；
6. 用户单独批准后完成三策略真实小额买入和平仓闭环；
7. 所有证据写入最终部署报告，且未泄漏 Secret。

批准本方案只代表可以开始 P28 GitHub 发布阶段，不代表已经批准 push、服务器登录、目录切换、Migration、数据库恢复或实盘启动。每个外部副作用阶段仍需按上文边界单独执行和记录。

## 15. 2026-08-12 实际执行结论

### 15.1 已完成

1. 发布分支、生产 tag 和服务器运行版本统一为 `9f019b498f2274e515524f5ff635632597fc2b7a`。
2. 服务器完成数据库备份、隔离恢复、依赖干净安装、前端生产构建、Migration `036-049`、manifest 导入、二次零变更和生产 Schema Audit。
3. `/opt/xbot` 已切换到新版本；`/opt/xbot-releases/CURRENT` 已从旧 `da5f853` 记录修正为当前 commit、tag、回滚目录和数据库备份证据。
4. `XBOT_CODE_VERSION` 已修正为 `p27.1-production-20260812`，`.env` 仍为 `xbot:xbot 0600`。
5. Nginx 配置测试通过，PostgreSQL、Nginx、`xbot.service` 和 `/tg/` 均正常；最近 15 分钟 `xbot.service` 无 warning。
6. 鉴权 API `/api/system/signals`、`/api/trade/positions`、`/api/trade/history`、`/api/system/env` 和 `/api/system/engine-status` 均返回 200；无鉴权业务 API 返回 401。
7. Signal/Position 各刷新 5 次后 GMGN 调用增量为 0、429 增量为 0；最终重启没有启动预热、Research、6551 或交易。

### 15.2 当前生产状态

```dotenv
XBOT_RELEASE_SHA=9f019b498f2274e515524f5ff635632597fc2b7a
XBOT_CODE_VERSION=p27.1-production-20260812
LIVE_TRADING_ENABLED=false
EMERGENCY_STOP=true
X_6551_WSS_ENABLED=false
X_6551_WATCH_APPLY_ENABLED=false
P21_FOLLOW_DISCOVERY_ENABLED=false
GMGN_CREDENTIAL_PROFILE=primary
```

Engine 为 `armed=false`、`desiredRunning=false`、`status=stopped`。这代表技术部署完成，不代表实盘已经恢复。

### 15.3 待单独批准

1. 管理员登录公网 XBOT 后，对 `/signals`、`/positions`、`/history`、`/settings` 做最后一次桌面与移动端人工视觉确认。
2. 按第 11 节顺序恢复唯一 6551 WSS、Watch Apply 和 Engine。
3. 按 Fixed -> P20 -> P21 分别完成人工真实小额买入、保护策略和平仓闭环。

因此，P28 的 GitHub 发布和服务器技术部署阶段已经完成；P28 的完整资金验收仍处于待批准状态，不能提前标记为全部完成。
