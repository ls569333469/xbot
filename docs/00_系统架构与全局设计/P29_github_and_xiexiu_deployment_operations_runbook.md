# P29 GitHub 发布与 xiexiu 生产部署工作手册

> 版本：v1.0
> 日期：2026-08-13
> 状态：Active Runbook
> 适用范围：XBOT GitHub 提交、production tag、xiexiu `/opt/xbot` 部署、回滚与部署后验收
> 形成依据：P28 首次完整部署，以及 `p27.2-production-20260813` 策略隔离 hotfix 的实际执行记录

## 1. 手册目标

P29 解决两个问题：

1. 每次发布必须安全、可追踪、可回滚，不能因为追求速度跳过资金安全检查。
2. 不再把完整版本发布的所有步骤机械套到纯后端 hotfix，避免重复测试、重复 Release Audit、重复前端构建和无效远端检查。

生产发布仍遵守三段授权边界：

```text
GitHub 提交与发布
  != xiexiu 服务器部署
  != 启动真实交易
```

代码部署完成后，Engine 必须保持 `stopped / desiredRunning=false / armed=false`。是否启动真实交易由用户在部署验收完成后单独决定。

## 2. 为什么之前部署较慢

### 2.1 必须保留的时间

以下步骤不能为了提速删除：

| 步骤 | 必要性 |
|---|---|
| 测试与 `git diff --check` | 防止把逻辑回归和格式错误带到生产 |
| 最终 SHA 的 Secret / Release Audit | 防止 Secret、日志、dump、测试脚本和非发布资产进入 GitHub 或服务器 |
| GitHub 分支与 annotated tag SHA 核对 | 保证服务器部署的是已经审核的唯一提交 |
| Engine 停止与在途资金检查 | 防止切换过程中产生重复 Swap、未知订单或无人对账状态 |
| PostgreSQL 备份与可读性校验 | 为应用或 Migration 事故保留恢复证据 |
| 新 release 独立构建 | 避免直接污染正在运行的 `/opt/xbot` |
| Migration 零变更检查与 Schema Audit | 防止代码与数据库结构不一致 |
| 原子目录切换和 Supervisor 验收 | 将停机窗口压缩到秒级，并保证只有一套双角色进程 |
| Engine、6551、Watch、Readiness、GMGN 增量验收 | 防止“服务返回 200”被误认为交易系统整体正常 |

### 2.2 本次发现的可避免耗时

| 问题 | 表现 | P29 处理办法 |
|---|---|---|
| VPN / GitHub 网络不稳定 | `Connection reset`、GitHub 443 不可达 | 发布开始前只做一次 `git ls-remote` 网络门；失败时先切换网络，再重试，不进入服务器阶段 |
| Release Audit 重复执行 | 本地提交前、提交后、服务器各扫描一次 Git 历史 | 最终 commit 只执行一次完整 Audit；只要 SHA 未变化，服务器只核对 SHA、tag 和工作区，不重复历史扫描 |
| 纯后端 hotfix 仍重建前端 | `npm ci + build` 没有产生新前端资产 | 先比较 `frontend` tree；完全一致时复用上一 release 已验收的 `dist`，否则必须重建 |
| 多个网络命令并行绑定 | 一个 GitHub 命令失败，掩盖 SSH 或本地检查结果 | GitHub、SSH、生产写操作分阶段串行执行；一个命令只负责一个阶段 |
| PowerShell -> SSH -> Bash 多层引号 | `unexpected EOF`、SQL 引号丢失 | 复杂远端逻辑通过 LF 格式脚本送入 `ssh ... bash -s`，不使用超长 `ssh "..."` |
| 直接 `source backend/.env` | PEM 或含空格值被 Bash 当成命令 | 禁止 `source .env`；使用项目 `dotenv`、应用 `check-env.js`，或只复制文件不解析 Secret |
| Windows CRLF 进入远端脚本 | `CURRENT\r`、`--no-pager\r` | 发送前去除 `\r`，或在 Linux 服务器上直接生成脚本和 `CURRENT` |
| root 读取 xbot 仓库 | Git 报 `dubious ownership` | 使用 `sudo -u xbot git -c safe.directory=/opt/xbot ...`，不修改全局 Git 配置 |
| 启动后立即请求端口 | 前两次 `curl` 连接失败 | 使用有上限的健康轮询；只有超时后才判定启动失败 |
| 完整 Readiness 较慢 | RPC 状态计算可持续几十秒 | 先验收硬状态，再单独执行 `probe=false` Readiness；禁止在部署验收中做 GMGN probe |
| 把历史 GMGN 总量当作新增 | 历史累计请求和 429 数量很大 | 部署前记录基线，部署后只比较 `since_restart` 或前后差值 |
| `npm ci` 输出漏洞告警 | 容易临时执行 `npm audit fix` 扩大发布范围 | 发布中只记录告警；依赖升级必须作为独立代码变更测试和发布 |

## 3. 发布类型必须先分类

每次变更只允许选择一种路径。

### 3.1 A 类：应用 hotfix

同时满足以下全部条件才属于 A 类：

- 不修改 `backend/db/migrations/**`、`backend/db/init.sql` 或 Migration manifest；
- 不修改 `backend/package*.json`；
- 不修改 `frontend/**` 或 `frontend/package*.json`；
- 不修改 `deploy/**`、Nginx、systemd、Node/npm 版本；
- 不修改 REST / WebSocket 契约版本；
- 影响边界已通过针对性测试和后端全量测试。

A 类仍然需要 GitHub tag、Engine 停止、资金状态检查、数据库备份、`npm ci`、零变更 Migration、Schema Audit、原子切换和完整运行态验收。

A 类可以省略：

- 前端 lint/build，前提是新旧 `frontend` tree 完全一致；
- 服务器重复执行完整 Git 历史 Release Audit，前提是最终 SHA 已在本地通过并记录；
- Migration 演练，前提是 Migration tree 完全一致。

### 3.2 B 类：完整应用发布

出现以下任一变化即进入 B 类：

- Migration、数据库 Schema 或 manifest；
- package lock、Node/npm 版本或生产依赖；
- 前端源码、Vite public base 或静态资源；
- Supervisor、systemd、Nginx、部署资产；
- API / WebSocket 契约；
- GMGN 写入、幂等、预算、钱包、平仓或对账核心代码的大范围修改。

B 类执行全部测试、Migration 演练、前后端干净安装与构建、Release Audit、备份恢复验证和完整部署验收。

### 3.3 C 类：配置操作，不是代码发布

以下操作不创建 release：

- 新增 KOL；
- 创建、修改、暂停某条策略；
- Watch 同步；
- 通过现有前端或受支持 API 修改非 Secret 的业务配置；
- 用户启动或停止 Engine。

这些操作不得重启服务、替换 `/opt/xbot`，更不得因为单条策略暂未同步而停止其他正在运行的策略。P27.2 已把 Follow Watch 的 `pending/processing/failed` 限制在对应策略作用域。

直接修改生产 `.env`、systemd、Nginx、Node/npm 或数据库不属于 C 类，必须进入受控维护窗口；涉及运行资产时按 B 类处理。

### 3.4 D 类：仅文档或非运行资产

同时满足以下全部条件才属于 D 类：

- 只修改 `docs/**`、根文档或不在 `deploy/release-allowlist.txt` 中的说明文件；
- 不修改代码、Migration、契约、依赖、前端、生产配置或部署资产本体；
- 不改变服务器运行行为。

D 类只需要文档自检、提交和 GitHub 推送，不创建 production tag，不连接 xiexiu，不停止 Engine，也不部署服务器。若文档同时修改了可执行部署文件、Nginx、systemd 或 allowlist，则不能使用 D 类。

## 4. 一页式标准流程

```text
1. 分类 A/B/C/D
2. 本地网络门和工作区盘点
3. 运行本次类型要求的测试
4. 只暂存审核过的文件
5. 提交，得到唯一 40 位 RELEASE_SHA
6. 对最终 SHA 执行一次 Release/Secret Audit
7. 推送分支，核对远端 SHA
8. 创建并推送不可变 production tag，核对 tag^{}
9. 服务器只读预检
10. 正式 Disarm Engine，确认无危险在途资金状态
11. 创建并校验数据库备份
12. 在 /opt/xbot-release-<SHA> 预构建
13. 复制生产 .env，只改版本标识
14. check-env、Migration、Schema Audit
15. 记录 GMGN/429 基线
16. 短暂停止 xbot.service，原子切换目录
17. 启动 Supervisor，轮询健康接口
18. 验收双角色、6551、Watch、Engine、Readiness、GMGN 增量
19. 原子更新 /opt/xbot-releases/CURRENT
20. 保持 Engine 停止，交给用户决定是否启动真实交易
```

## 5. GitHub 发布 SOP

### 5.1 网络门

在开始测试和生产操作前执行：

```powershell
git ls-remote origin HEAD
```

失败时：

1. 停在本地阶段，不登录生产做写操作。
2. 检查 VPN 或网络，切换后只重试一次。
3. 不修改仓库 remote，不关闭 TLS 校验，不把 Token 写进 URL。
4. 成功后再继续。

### 5.2 工作区与变更分类

```powershell
git status --short --branch
git diff --check
git diff --stat
git diff --name-only <OLD_RELEASE_SHA> HEAD
git remote -v
```

禁止发布以下内容：

- `.env`、PEM、API Key、数据库密码；
- dump、日志、截图、临时审计脚本；
- 测试真实交易 runner；
- 本地 `dist`、`node_modules`；
- 与本次目标无关的用户改动。

### 5.3 测试矩阵

#### A 类 hotfix

1. 与修改模块直接相关的测试。
2. `backend` 全量测试。
3. `git diff --check`。
4. 最终 SHA 的 `npm run audit:release`。
5. 只有当前端 tree 变化时才执行前端 lint/build。

#### B 类完整发布

```powershell
cd D:\Axiangmu\xbot\backend
npm.cmd test
npm.cmd run test:migration:p27
npm.cmd run test:integration
npm.cmd run audit:release

cd D:\Axiangmu\xbot\frontend
npm.cmd run lint
npm.cmd run build

cd D:\Axiangmu\xbot
git diff --check
```

数据库集成测试只允许使用名称含 `test` 的隔离数据库。

### 5.4 暂存、提交与唯一 Audit

禁止 `git add .`。按文件暂存后检查：

```powershell
git diff --cached --check
git diff --cached --stat
git diff --cached
git commit -m "<message>"
$releaseSha = git rev-parse HEAD
git status --short --branch
```

对最终 commit 执行一次完整发布审计：

```powershell
cd backend
npm.cmd run audit:release
```

只要此后没有产生新 commit，就不重复运行相同的历史扫描。任何 amend、rebase 或新提交都会产生新 SHA，必须重新审计。

### 5.5 推送分支和 tag

```powershell
git push -u origin <release-branch>
git ls-remote origin refs/heads/<release-branch>

git tag -a <production-tag> $releaseSha -m "<release description>"
git push origin refs/tags/<production-tag>
git ls-remote origin refs/tags/<production-tag> 'refs/tags/<production-tag>^{}'
```

必须满足：

```text
本地 HEAD
  = GitHub 分支 SHA
  = annotated tag 解引用后的 SHA
```

tag 已推送后禁止移动、覆盖或删除。修复必须使用新 commit 和新 tag。

## 6. xiexiu 部署前 SOP

### 6.1 固定生产事实

```text
服务器：xiexiu
应用目录：/opt/xbot
发布记录：/opt/xbot-releases/CURRENT
服务：xbot.service
后端：127.0.0.1:3011
Node：/opt/node-v24.11.1
数据库：PostgreSQL xbot
生产 Secret：/opt/xbot/backend/.env，xbot:xbot 0600
```

### 6.2 只读预检

依次核对，不与 GitHub 网络命令并行绑定：

```bash
systemctl show xbot.service \
  -p ActiveState -p SubState -p MainPID -p ExecMainStartTimestamp -p NRestarts
pgrep -af 'scripts/supervisor.js|server.js --role='
ss -ltnp | grep ':3011 '
cat /opt/xbot-releases/CURRENT
curl -fsS http://127.0.0.1:3011/api/health
df -h /opt /var/backups
```

还必须查询：

- Engine 持久化状态；
- `submitting/submission_uncertain/reconciliation_required` Attempt；
- 活跃 Intent；
- 待确认 Order；
- 打开 Position；
- Watch outbox 状态；
- 当前 GMGN request / 429 基线。

### 6.3 正式停止 Engine

即使 Engine 已是 `fault_protected`，只要 `desired_running=true`，重启后仍可能尝试恢复。因此部署前必须调用正式 `/api/system/disarm`，并再次从数据库确认：

```text
armed=false
desired_running=false
status=stopped
dangerous_attempts=0
active_intents=0
pending_orders=0
```

不要直接修改 `trade_runtime_state`，必须使用应用 API 写入审计记录。

### 6.4 数据库备份

```bash
BACKUP=/var/backups/xbot/xbot-before-<tag>-<timestamp>.dump
sudo -u postgres pg_dump -Fc -d xbot -f "$BACKUP"
chown postgres:postgres "$BACKUP"
chmod 0600 "$BACKUP"
sudo -u postgres pg_restore --list "$BACKUP" >/dev/null
sha256sum "$BACKUP"
```

B 类发布还要在隔离数据库执行完整恢复验证。A 类无 Schema 变化时至少执行 `pg_restore --list`，并记录路径、大小与 SHA-256。

## 7. 新 release 预构建 SOP

### 7.1 从不可变 tag 获取

```bash
RELEASE_SHA=<40-character-sha>
RELEASE_TAG=<production-tag>
RELEASE=/opt/xbot-release-$RELEASE_SHA

test ! -e "$RELEASE"
git clone --filter=blob:none --single-branch --branch "$RELEASE_TAG" \
  https://github.com/ls569333469/xbot.git "$RELEASE"
cd "$RELEASE"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
git tag --points-at HEAD | grep -Fx "$RELEASE_TAG"
```

### 7.2 后端安装

无论 A/B 类都执行干净安装：

```bash
cd "$RELEASE/backend"
PATH=/opt/node-v24.11.1/bin:$PATH /opt/node-v24.11.1/bin/npm ci
```

服务器不重复完整 Release Audit，只核对已审计 SHA、tag、工作区和 release allowlist。只有本地最终 SHA 没有 Audit 证据时，服务器才补跑 `npm run audit:release`。

### 7.3 A 类前端复用

先核对新旧前端 tree：

```bash
OLD_FRONTEND_TREE=$(git rev-parse "$OLD_RELEASE_SHA:frontend")
NEW_FRONTEND_TREE=$(git rev-parse "$RELEASE_SHA:frontend")
test "$OLD_FRONTEND_TREE" = "$NEW_FRONTEND_TREE"
test -d /opt/xbot/frontend/dist
cp -a /opt/xbot/frontend/dist "$RELEASE/frontend/dist"
```

任何 tree 不一致、旧 `dist` 缺失或 public base 改变，都必须转为 B 类并重新构建。

### 7.4 B 类前端构建

```bash
cd "$RELEASE/frontend"
PATH=/opt/node-v24.11.1/bin:$PATH \
  VITE_PUBLIC_BASE=/xbot/ /opt/node-v24.11.1/bin/npm ci
PATH=/opt/node-v24.11.1/bin:$PATH \
  VITE_PUBLIC_BASE=/xbot/ /opt/node-v24.11.1/bin/npm run build
```

## 8. `.env`、Migration 与切换 SOP

### 8.1 `.env` 处理

```bash
cp -p /opt/xbot/backend/.env "$RELEASE/backend/.env"
```

只允许修改：

```dotenv
XBOT_RELEASE_SHA=<RELEASE_SHA>
XBOT_CODE_VERSION=<RELEASE_TAG>
```

其他业务和实盘开关原样保留。随后：

```bash
chown -R xbot:xbot "$RELEASE"
chmod 0600 "$RELEASE/backend/.env"
```

禁止：

- 把 `.env` 从本地上传或从 GitHub 下载；
- 在终端输出 `.env`；
- `source /opt/xbot/backend/.env`；
- 把 Secret 放在命令行参数、URL 或发布记录中。

### 8.2 切换前校验

```bash
cd "$RELEASE/backend"
sudo -u xbot env NODE_ENV=production XBOT_PROCESS_ROLE=execution \
  PATH=/opt/node-v24.11.1/bin:/usr/local/bin:/usr/bin \
  /opt/node-v24.11.1/bin/node scripts/check-env.js

sudo -u xbot env NODE_ENV=production XBOT_PROCESS_ROLE=execution \
  PATH=/opt/node-v24.11.1/bin:/usr/local/bin:/usr/bin \
  /opt/node-v24.11.1/bin/npm run migrate

sudo -u xbot env NODE_ENV=production XBOT_PROCESS_ROLE=execution \
  PATH=/opt/node-v24.11.1/bin:/usr/local/bin:/usr/bin \
  /opt/node-v24.11.1/bin/npm run audit:schema:production
```

A 类必须得到 `applied=[]`。出现任何新 Migration 立即停止并重新分类为 B 类。

### 8.3 原子切换

```bash
OLD=/opt/xbot
ROLLBACK=/opt/xbot-rollback-<old-short-sha>-<date>-<tag>

test -d "$OLD"
test -d "$RELEASE"
test ! -e "$ROLLBACK"

systemctl stop xbot.service
# 等待服务 inactive 且 3011 释放，最长 30 秒
mv "$OLD" "$ROLLBACK"
mv "$RELEASE" "$OLD"
systemctl daemon-reload
systemctl start xbot.service
```

启动后使用 60 次以内、每次 1 秒的有界轮询检查 `/api/health`。最初数次连接失败属于正常启动窗口；超过上限才进入回滚判断。

## 9. 部署后验收 SOP

### 9.1 硬状态先验收

必须同时满足：

- `/api/health.release_sha = RELEASE_SHA`；
- `process_role=execution`；
- `contract_version=p27.v1`；
- `event_contract_version=p27.events.v1`；
- 一个 Supervisor、一个 ingestion、一个 execution；
- 没有 `--role=all`；
- `NRestarts=0`；
- 仅 `127.0.0.1:3011` 监听；
- ingestion/execution heartbeat 小于 15 秒；
- 6551 WSS 为 `subscribed`；
- Watch outbox 无 pending/processing/failed；
- Engine 为 `stopped / desiredRunning=false / armed=false`；
- 危险 Attempt、活跃 Intent、待确认 Order 均为 0；
- 重启后 GMGN request 增量为 0；
- 重启后 GMGN 429 增量为 0。

### 9.2 Readiness 后验收

只执行：

```text
GET /api/system/readiness?probe=false
```

禁止在部署验收阶段使用 `probe=true`。标准结果：

```text
readyToArm=true
blockers=[]
scheduler.state=healthy
queueDepth=0
cooldownUntil=null
```

`FAST_PATH_SLO_NOT_VERIFIED`、`TRADE_ALERTS_NOT_VERIFIED` 等 advisory 必须记录，但不会自动启动 Engine，也不等价于服务故障。

### 9.3 公网入口

```text
https://xiexiu.io/xbot/api/health -> 200
https://xiexiu.io/xbot/            -> 200
https://xiexiu.io/tg/              -> 200
```

不得为了 XBOT 发布修改或重启 TGBOT。

### 9.4 发布证据

在 Linux 服务器上原子写入 `/opt/xbot-releases/CURRENT`：

```text
commit=<RELEASE_SHA>
tag=<RELEASE_TAG>
deployed_at=<ISO-8601>
stage=/opt/xbot
application_rollback=<ROLLBACK>
p26_rollback=<verified-p26-path>
database_backup=<BACKUP>
database_backup_sha256=<SHA256>
previous_commit=<OLD_RELEASE_SHA>
previous_tag=<OLD_RELEASE_TAG>
```

不要从 Windows here-string 直接写该文件，避免 CRLF。若必须从 PowerShell 发送脚本，发送前执行 `-replace "`r", ""`。

## 10. 回滚 SOP

### 10.1 A 类、无 Migration 变化

1. 保持 Engine 停止。
2. `systemctl stop xbot.service`。
3. 将失败的新 `/opt/xbot` 移到独立事故目录，不删除。
4. 将本次 `application_rollback` 原子移回 `/opt/xbot`。
5. 启动 `xbot.service`。
6. 核对旧 SHA、双角色、Engine stopped、订单对账和公网入口。
7. 更新 `CURRENT`，记录失败 release 与回滚时间。

### 10.2 B 类、已应用 additive Migration

- 不执行 down migration；
- 保留当前数据库 Schema；
- 只切回已验证兼容当前 Schema 的 rollback binary；
- 数据库恢复属于最后手段，必须单独批准，因为会覆盖部署后的交易数据；
- 回滚期间不得恢复新买入，只允许健康读取、订单对账和受控平仓。

## 11. 故障速查表

| 错误 | 根因 | 正确处理 |
|---|---|---|
| `Failed to connect to github.com:443` | VPN / 网络不可达 | 停在本地，切换网络，`git ls-remote` 成功后继续 |
| `Recv failure: Connection was reset` | HTTPS 链路中断 | 检查远端分支是否已出现；未出现时幂等重推，不重复 commit |
| SSH `banner exchange timeout` | VPN 路由或服务器链路抖动 | 公网 health 只读确认，短暂等待后重试 SSH，不重复生产写操作 |
| `unexpected EOF` | PowerShell/SSH/Bash 引号嵌套 | 改用 LF 脚本经 `ssh ... bash -s` 执行 |
| `.env: PRIVATE: command not found` | 错误地 `source .env` | 使用 `dotenv` 或 `scripts/check-env.js`，禁止 shell source |
| `dubious ownership` | root 读取 xbot 所有仓库 | `sudo -u xbot git -c safe.directory=/opt/xbot ...` |
| `CURRENT\r` / `--no-pager\r` | Windows CRLF 进入远端 | Linux 端生成文件，或发送前删除 `\r` |
| 启动后前几次 `curl` 失败 | Node/Supervisor 尚未监听 | 有界轮询，不立即回滚 |
| Readiness 超时 | RPC / 数据库状态计算慢 | 硬检查先完成，Readiness 单独 `probe=false` 且设置合理超时 |
| `npm ci` 漏洞告警 | 锁文件已有依赖风险 | 记录并单独修复；部署中禁止 `npm audit fix --force` |
| GMGN 累计 429 很大 | 查询了历史总量 | 比较部署前后差值或 `since_restart` |
| 保存策略后 Engine 停止 | 旧版将策略局部 Watch pending 当全局 blocker | 确认运行版本至少为 `p27.2-production-20260813`，并核对 Follow Watch 仅进入 advisory |

## 12. 时间目标

网络稳定、无故障时的目标：

| 发布类型 | 预计总时长 | 预计服务不可用窗口 |
|---|---:|---:|
| A 类后端 hotfix | 5-12 分钟 | 10-30 秒 |
| B 类完整应用发布，无新 Migration | 10-20 分钟 | 10-60 秒 |
| B 类含 Migration / 恢复演练 | 20-45 分钟 | 取决于 Migration，必须单独评估 |

测试、构建和备份在旧服务仍运行时完成。真正停机窗口只包含停止服务、目录切换、启动和健康轮询。

## 13. 2026-08-13 p27.2 参考证据

本次 hotfix 的最终证据：

| 项目 | 结果 |
|---|---|
| GitHub 分支 | `codex/p28-policy-isolation-hotfix` |
| Release SHA | `af8ce074ecb53a41785e7dcb3b47bbe84c15be05` |
| Production tag | `p27.2-production-20260813` |
| 旧生产 SHA | `9f019b498f2274e515524f5ff635632597fc2b7a` |
| 回滚目录 | `/opt/xbot-rollback-9f019b4-20260813-hotfix` |
| 数据库备份 | `/var/backups/xbot/xbot-before-p27.2-af8ce074-20260813-154003.dump` |
| 备份 SHA-256 | `091ea983add0141c91b49c08ee8ac17731c3529a2546ec431b3bb542fe541faa` |
| Migration | `applied=[]` |
| Schema Audit | 通过 |
| Supervisor | 1 个；ingestion 1 个；execution 1 个；`NRestarts=0` |
| 6551 | WSS `subscribed`；Watch outbox `22 succeeded` |
| Engine | `stopped / desiredRunning=false / armed=false` |
| Readiness | `readyToArm=true`；`blockers=[]` |
| GMGN | 重启后 request 增量 `0`；429 增量 `0` |
| 公网入口 | `/xbot/api/health`、`/xbot/`、`/tg/` 均为 HTTP 200 |

本次没有调用 GMGN Swap，没有产生真实交易。部署完成不代表自动恢复实盘。

## 14. 完成定义

只有以下全部满足，才能宣布“提交与部署完成”：

1. 本地 HEAD、GitHub 分支、production tag、服务器 health 和 `CURRENT` 使用同一 SHA。
2. 工作区干净，Secret 和非发布资产未进入 GitHub。
3. 数据库备份已校验，Migration 与 Schema Audit 通过。
4. Supervisor 双角色、端口、心跳、6551 和 Watch 正常。
5. Engine 保持停止，危险资金状态为 0。
6. Readiness 无 blocker。
7. 部署窗口 GMGN 请求、Swap 和 429 无异常新增。
8. XBOT 与 TGBOT 公网入口正常。
9. 回滚目录、备份和 `CURRENT` 证据完整。
10. 用户单独决定是否启动真实交易。
