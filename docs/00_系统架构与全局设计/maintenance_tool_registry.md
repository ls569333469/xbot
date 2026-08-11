# XBOT 维护工具登记表

> 文档性质：长期有效的项目级能力登记表，不是并行迭代方案。
> 适用范围：新链验收、事故恢复、Provider 补偿、数据库迁移和发布前核验。
> 产品边界：维护工具默认只存在于后端或 CLI，不得因为接口已经存在就进入日常前端。

## 1. 强制规则

1. 日常前端只承载用户决策、业务数据和持续运行状态。
2. 新链诊断、限时实盘验收和生产批准属于后台维护能力，不提供常驻前端入口。
3. 只有用户必须立即处理的生产异常，才允许显示条件式恢复入口；异常消失后入口自动消失。
4. 改变交易范围、解除隔离、重置熔断、修改凭据或批准新链的动作必须使用 `ADMIN_TOKEN`、显式确认文本和审计记录。
5. 新增、修改或删除维护工具时，必须同步更新本表、核心 PRD、自动化测试和生产可达性说明。
6. 前端没有入口不等于死代码。删除工具前必须确认后端路由、脚本、测试、迁移和事故处置流程均无依赖。

## 2. 当前保留工具

| 工具 | 入口 | 前端策略 | 使用场景 | 关键约束与副作用 |
|---|---|---|---|---|
| 新链只读诊断 | `POST /api/trade/chains/:chain/diagnose` | 不展示 | 新链首次接入或核心交易契约变化后，核验 Wallet、RPC、Token/Pool/Security/Quote 和 Strategy | 需要明确确认；不创建交易订单，但会写入 Readiness Evidence |
| 限时实盘验收 | `POST /api/trade/chains/:chain/acceptance/start`、`POST /api/trade/acceptance/finish` | 不展示 | 新链生产批准前，用一条白名单完成真实 Buy/Close 闭环 | 最长 30 分钟、全系统唯一、只允许一条白名单；不会自动启动 Engine；结束前不得恢复普通策略 |
| 新链生产批准 | `POST /api/trade/chains/:chain/approve` | 不展示 | 完整 Buy/Close、Receipt、Position/Lot、Strategy 和 Budget/Ledger 证据通过后开放新链 | Engine 必须停止；需要当前代码与配置证据；写审计记录 |
| 6551 Watch 补偿应用 | `POST /api/x-monitor/6551/watch-apply` | 仅保留只读“预览监控变更”；不展示写入按钮 | Watch Sync Outbox 无法自动收敛时的人工补偿 | 仅 `signal` 模式且 Engine 停止；需要显式确认；受用量门禁保护 |
| 钱包写入隔离解除 | `POST /api/trade/wallet-lanes/release` | 仅在交易记录页出现隔离异常时显示 | 已通过 GMGN Order、Tx、Receipt 或余额证据排除未知资金写入后恢复同链钱包 | 必须填写原因和证据；不得凭业务报错直接解除；写事故审计 |
| 链级失败熔断重置 | `POST /api/trade/chain-circuits/:chain/reset` | 仅在对应链熔断时显示 | 连续明确失败原因已修复并完成核验后恢复新买入 | 必须填写原因；不清除历史 Attempt 或失败证据 |
| 环境与凭据热重载 | `POST /api/system/env`、`POST /api/system/env/gmgn-private-key` | 保留在“系统维护” | 修改 RPC、端口、数据库连接或轮换 GMGN 签名私钥 | 修改后停止新买入并由 Supervisor 重启；不得在日志或文档输出秘密值 |
| 外部告警测试 | `POST /api/system/alerts/test` | 保留在“系统维护” | 验证外部告警通道 | 只写通知 Outbox，不执行交易 |
| 测试库与 Migration 演练 | `test:integration`、`test:migration:p12`、`test:db:manage` | CLI only | 发布前验证完整 Schema、历史回填和约束 | 只允许名称包含 `test` 的独立数据库；拒绝生产库 |
| 生产 Migration phase | `npm run migrate` / `scripts/run-migrations.js` | CLI only | Supervisor 启动业务角色前按文件名顺序应用未完成迁移 | 必须使用部署目标 `.env`；迁移失败时不启动 `ingestion` 或 `execution`；不由业务角色重复执行 |
| 环境、Schema 与链上审计 | `scripts/check-env.js`、`scripts/audit-db-schema.js`、`audit:solana-tx` | CLI only | 启动检查、数据库结构核验、历史 Solana 交易独立复核 | 默认只读；不得输出 API Key、私钥或完整未脱敏凭据 |

## 3. 不属于日常前端的原因

### 3.1 新链验收

验收工具解决的是“新执行链能否被批准进入生产”，不是“用户今天是否允许自动交易”。它会临时把全系统 Live Policy 收窄到一条白名单，误操作会影响所有正常 CA，因此不得作为设置页常驻按钮。

### 3.2 事故恢复

钱包隔离解除和链熔断重置具有明确的生产恢复价值，但只应在异常真实存在时出现。正常状态下展示这些控制会制造重复配置和误操作风险。

### 3.3 Provider 补偿

白名单保存后的 6551 Watch 同步由 Outbox 和 ingestion Worker 自动完成。`watch-apply` 只处理自动同步无法恢复的异常，不得成为普通白名单工作流的第二入口。

Outbox Worker 只能自动接管当前批次明确涉及的 Actor；其他远端 Watch 继续保持非托管。远端 flags 覆盖全部白名单必需事件即可视为同步，Provider 自动附加的额外事件由信号匹配层过滤，不得因此反复删除重建 Watch。

## 4. 新增工具登记模板

每个新工具必须记录：

- 工具名称和代码 Owner。
- 唯一入口（API、CLI 或异常条件式 UI）。
- 是否涉及真实资金、交易范围、凭据或数据库写入。
- 调用前置条件、显式确认文本和审计落点。
- 正常完成、失败、超时和回退行为。
- 自动化测试与生产可达性。
- 前端展示策略及退出日常界面的条件。

未登记的维护工具不得进入前端，也不得作为发布流程的隐含步骤。
