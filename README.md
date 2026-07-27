# XBOT

XBOT 使用 6551 实时 X 信号和 GMGN Agent API 执行链上交易。当前状态以 [文档总入口](./docs/README.md) 为准；后台验收、事故恢复和 Provider 补偿能力统一登记在 [维护工具清单](./docs/00_系统架构与全局设计/maintenance_tool_registry.md)，不作为日常前端功能。

## 启动

首次安装依赖：

```powershell
cd backend
npm.cmd install
cd ..\frontend
npm.cmd install
```

启动受 Supervisor 管理的后端双进程：

```powershell
cd backend
npm.cmd start
```

启动前端开发服务器：

```powershell
cd frontend
npm.cmd run dev
```

前端默认访问 `http://127.0.0.1:5173`，并将 `/api` 和 `/ws` 代理到后端 `http://127.0.0.1:3011`。后端启动时会按顺序执行尚未应用的数据库 Migration；首次部署 P12 前必须先停止新交易并完成数据库备份。

## 测试边界

```powershell
cd backend
npm.cmd test
cd ..\frontend
npm.cmd run build
```

默认单元测试不写数据库。数据库集成测试必须显式配置名称包含 `test` 的独立数据库：

```powershell
$env:XBOT_TEST_DB_NAME='xbot_test'
cd backend
npm.cmd run test:integration
```

测试守卫会拒绝缺少测试库、测试库名称不含 `test`，或测试库与生产库同名的情况。不得使用生产数据库执行故障注入、并发领取或 Migration 测试。

测试库可使用受保护命令创建为空库或删除；脚本同样拒绝生产库名和不含 `test` 的名称：

```powershell
cd backend
npm.cmd run test:db:manage -- recreate xbot_p14_migration_test
npm.cmd run test:db:manage -- drop xbot_p14_migration_test
```

Migration 013-016 的历史数据回填与 P14 验收表必须在另一座空测试库单独演练：

```powershell
$env:XBOT_TEST_DB_NAME='xbot_p12_migration_test'
cd backend
npm.cmd run test:migration:p12
```

迁移演练会拒绝非测试库和非空数据库，并核对历史 Order、Receipt、Position/Lot、Strategy、预算、Ledger 与 Outbox 在回填前后保持不变，同时验证 P13 Watch/关系与 P14 Evidence/Acceptance 表。

## 安全边界

- `.env`、PEM、API Key、钱包完整地址和数据库备份均不得提交到 Git。
- GMGN Swap/Strategy 写请求没有 HTTP 自动重试；只有 P12 状态机证明上一 Attempt 明确失败且未成交后，才可能创建下一 Attempt。
- P12 自动重试默认对所有链关闭，只有用户在设置页主动开启后才生效。
- SOL、BSC、Base、Ethereum 和 Robinhood 均已接入统一交易内核；新链诊断、限时验收和生产批准只允许通过后台维护接口执行。

文档总入口见 [docs/README.md](./docs/README.md)，系统链路图见 [xbot-system-link-map.html](./docs/00_系统架构与全局设计/xbot-system-link-map.html)。
