# P13 白名单主导的配置收敛与旧路径治理方案

> 盘查日期：2026-07-24
> 状态：P13.1-P13.5 代码与生产 Watch 收敛已完成；生产库已应用 015 Migration。后端单元测试和前端构建已通过。剩余集成测试、生产行为验收与发布收尾已由 [P14](./P14_p13_acceptance_robinhood_live_and_release_closure_plan.md) 接管，本文件不再作为 Active Plan。
> 前置条件：P12 资金状态机与数据库 Migration 013 保持不变，不在本阶段回滚或绕过 Intent、Attempt、Reconciliation、Wallet Write Lane。

## 1. 目标

XBOT 的业务配置收敛为一条规则：

> 白名单负责决定买什么、由谁与谁发生什么互动时触发、单笔买多少、累计最多买多少、最多买几次，以及该 CA 的 TP、SL、滑点。

系统层只负责运行和资金一致性，不再维护一套与白名单重复的交易规则。前端主操作路径最终只保留：

1. 白名单与 X 关系配置。
2. 启动/停止新买入。
3. 仓位、订单、失败原因与告警查看。

## 2. 第一原则与边界

### 2.1 白名单是业务授权来源

以下字段只由白名单拥有：

- `chain_id`
- `contract_address`
- KOL Actor 与 Project Target 的显式关系
- 允许触发的事件类型
- `budget_per_trade`
- `total_budget`
- `allow_repeat_buy` / 最大买入次数
- `auto_tp_pct`
- `auto_sl_pct`
- `slippage`
- 状态与过期时间

添加或修改有效白名单后应热更新，不应要求再到设置页勾选 CA、链或重复解锁 Engine。

### 2.2 系统层只保留执行能力与紧急控制

系统层保留：

- 6551 Provider 连接状态。
- GMGN 凭据、RPC、链实现能力和余额检查。
- 一个全局“启动真实交易 / 停止新买入”开关。
- 一个紧急停止开关。
- Robinhood 等尚未验收链的代码能力门禁。

链是否进入自动交易范围，应由“该链已实现并验收 + 存在有效白名单”自动派生，不再由设置页维护第二份普通业务开关。

### 2.3 必须保留的不是业务限制，而是防重复扣款保护

以下模块不能作为“配置太多”直接删除，也不应放在普通设置页：

- Trade Intent / Attempt 幂等。
- Budget Reservation / Ledger 原子记账。
- Reconciliation 与 RPC Receipt 核验。
- 明确失败且未成交后才重试。
- Wallet Write Lane 与不确定状态 Quarantine。
- Chain Failure Circuit 对连续明确执行失败的基础设施保护。

这些模块不决定买哪个 CA，也不修改白名单金额；它们防止超时、重复回调和状态未知时发生重复买入或重复卖出。

## 3. 已识别问题与处理结果

> 本节保留问题来源和处理原则，不代表这些问题仍未修复；当前验收证据以第 6 节和第 11 节为准。

### 已修复：白名单变更会间接停止真实交易

`readiness-service` 的运行配置指纹包含当前有效白名单。Engine Armed 后新增、暂停或修改白名单，会产生 `LIVE_CONFIGURATION_CHANGED`，Readiness Monitor 最迟约 5 秒后进入故障保护。

当前实现已将白名单和关系变更改为热加载；只有 Provider、GMGN 凭据、RPC、链实现能力等执行基础设施变化才需要停止新买入。

### 已修复：6551 Watch 不是随白名单自动同步

历史上白名单只生成 Desired Watch，真实远端 Watch 需要人工调用 `watch-apply`，导致保存白名单不等于开始监控。现在已由白名单事务、Watch Sync Outbox 和 ingestion Watch Worker 自动完成同步；`watch-apply` 仅保留为带显式确认的运维补偿入口。

常规保存不需要用户重复 Apply 或重复授权；执行 Watch 维护也不需要解锁交易 Engine。

### 已修复：每条关系会额外 Watch 项目账号

历史版本的 `watch-reconciler` 曾同时将 KOL Actor 和 Project Target 加入 Desired Watch。当前实现只从有效关系生成 Actor Watch，Project Target 只作为匹配条件；本轮已清理 XBOT 管理的历史项目方 Watch。

正常情况下只需要 Watch Actor，并按关系事件合并 Follow、Reply、Quote、Retweet、Tweet/CA 能力。Project Target 不会自动成为第二个远端监控账号。

### 已修复：设置页保存 `.env` 存在未来丢配置风险

历史实现中 `env-settings.writeEnv()` 会按 `ALLOWED_KEYS` 重写整个 `.env`，后端还读取 GMGN API Host、Gas/Fee 调优、TG 通知和代码版本字段；该风险已由增量写入实现消除。

当前实现已保留未知键、注释和原有顺序，仅原子替换明确允许更新的键。

### 已收敛：链级资金限制与白名单重复

当前实盘事务还会阻断：

- `maxPerTrade`
- `dailyBudget`
- `weeklyBudget`
- `maxOpenPositions`
- `dailyLossLimit`
- 全局每日/每周 USD 上限

其中单笔金额、累计金额和次数已由白名单约束；重复的链级业务阻断已从普通实盘判定中移除，不再要求为每条链重复填写。

如果未来需要账户级灾难上限，应作为独立的“紧急总敞口上限”设计，默认关闭、单一含义、只在高级运维页显示，不能继续用多组相似预算叠加。

### 已收敛：全局风险阈值重复覆盖白名单决定

当前实盘还会因 Honeypot、SOL Mint/Freeze Authority、Rug Ratio、Liquidity 和全局 Price Impact 阈值拒绝交易。买卖税已经改为仅告警。

当前实现按“用户保存白名单即确认该 CA”的原则：

- Honeypot、Authority、Rug、Liquidity、Tax 改为告警和审计快照，不再阻断。
- 取消全局 `max_slippage_pct`；实际交易只使用白名单 `slippage` 和 GMGN Quote 的最小到账约束。
- 地址无效、无法 Quote、余额不足、链未实现、凭据无效等执行前提仍必须阻断。

### 已移除：`x_monitor_config` 是假配置且保存会停机

`timeline_poll_interval_sec`、`follows_poll_interval_sec`、`max_kol_per_round` 没有被当前 6551 WSS 生产链路读取，但保存它们会触发 `CONFIG_UPDATED_AND_DISARMED`。

设置页卡片、配置键、Seed 和 API 写入口已删除。6551 Heartbeat/Reconnect 仅作为内部 Provider 参数保留在高级诊断中，只读展示运行值。

### 已隔离：旧风险字段仍混在当前配置

- `consecutive_loss_limit` 和 `ca_cooldown_min` 只由旧 Paper Risk Manager 使用，不参与当前实盘。
- `reject_cooldown_ms` 只有校验，没有消费者。
- `security_check_enabled` 被后端强制为 `true`，前端开关没有实际意义。
- `defaultTpPct`、`defaultSlPct`、`defaultSlippage` 只有存储与校验，实盘使用白名单字段。

这些字段已从普通设置页和当前实盘决策中移除，Legacy 源码仅保留在显式回放边界内。

### 已修复：Dashboard 使用旧预算表和错误 PnL 单位

- `/api/system/budgets` 读取旧 `budget_tracking`，实盘实际使用 `budget_ledger` 与 `budget_reservations`。
- Dashboard 将 SOL、BNB、ETH 原生币 PnL 直接相加后显示为 USD。

当前预算展示读取 Ledger/Reservation；PnL 按成交时 USD 快照或链原生币分开显示，不混加原生币。

### 已修复：新数据库初始化不是单一路径

后端启动只执行 Migration；空数据库没有 `init.sql` 基础表时，Migration 001 会直接失败。`db-setup.js` 又硬编码数据库名 `xbot`，且重新执行 Seed 会覆盖现有配置。

当前已建立唯一的从零初始化路径：基础 Schema 纳入 Migration，使用 `DB_NAME`，Seed 只在空配置库初始化时插入默认值，不覆盖生产配置。

## 4. 旧路径分类

### 4.1 当前生产主链路，保留

- Supervisor 双进程。
- 6551 WSS -> Event Inbox -> Activity/Signal。
- Live Execution Queue -> Execution Service。
- Intent / Attempt / Order / Receipt / Position / Lot。
- Reconciler、Retry Orchestrator、Wallet Lane、Outbox。

### 4.2 显式回退，移出普通设置

- TwitterAPI.io Webhook、Stream、Follow Poll。
- SocialData Timeline Poll。
- Provider Usage 历史统计。

它们不应与 6551 同时工作。代码继续保留以便历史数据和专项回放，但已由以下 Feature Flag 隔离，默认全部关闭，且不在普通设置页和设置 API 中出现：

- `XBOT_LEGACY_X_PROVIDERS_ENABLED`
- `XBOT_LEGACY_PAPER_ENABLED`
- `XBOT_LEGACY_SHADOW_ENABLED`

生产 X Provider 固定为 `6551`；旧 Provider 的 Webhook、轮询、Stream 和用量接口在默认状态下不可达。需要专项回放时只能由运维直接修改环境变量并重启，不能从前端误开启。

### 4.3 Paper/Shadow 路径，迁移后删除或独立打包

- `paper-engine.js`
- `signal-matcher.js` 的 Paper 执行分支
- `price-monitor.js`
- Paper 手工平仓 API
- `paper_spent_budget`、`paper_buy_count`、`sim_peaks`
- `SHADOW_LIVE_ENABLED` 与 Shadow 表

生产 Cron 当前全部禁用，且普通 API、运行模式和前端均已隔离 Paper。执行隔离前已核对生产数据库：没有 Paper 仓位，仅有 8 条已关闭的 Live 仓位；因此不需要保留生产 Paper 平仓入口。Shadow 仅在显式 Legacy Flag 与 `SHADOW_LIVE_ENABLED=true` 同时满足时启动。

### 4.4 可直接清理的代码管理噪声

- 源码头部的旧绝对路径 `D:\AI_Projects\xbot\...`。
- 前端 API 客户端中无页面消费者的方法。
- `cron.json` 中已被常驻服务替代的 `order-sync` 和永远禁用的 `budget-reset`。
- 根目录运行日志继续保持 Git Ignore；根目录 PEM 虽未被 Git 跟踪，但属于重复秘密文件，应确认 `.env` 私钥可用后迁移到仓库外安全目录，再人工删除。

## 5. P13 目标配置模型

### 普通设置页

- 真实交易状态：运行中 / 已停止 / 故障保护。
- 启动真实交易 / 停止新买入。
- 6551 连接、Watch 同步、最近事件和用量，只读。
- GMGN 与四链连接状态，只读。
- 紧急停止。

### 白名单页

- CA、链、名称和符号。
- 多条 `Actor -> Project Target` 关系。
- 每条关系的触发事件：Follow、Reply、Quote、Retweet、Tweet/CA/关键词提及。
- 单笔金额、累计金额、最大买入次数。
- TP、SL、滑点、状态和过期时间。
- 保存后自动同步 6551 Actor Watch，并显示“待同步 / 已监控 / 失败”。

### 高级诊断页

- Retry、Failure Evidence、Fee Envelope 的当前固定策略，只读为主。
- Wallet Quarantine 与人工解除。
- Chain Failure Circuit 与人工复位。
- Reconciliation、RPC、GMGN Rate Limit 和 Provider Heartbeat。

## 6. 复查后的状态与强制约束

| 项目 | 当前状态 | P13 要求 |
|---|---|---|
| 删除旧轮询配置 | 已完成 | 不再恢复 `x_monitor_config` |
| 6551 WSS 重连默认值和说明 | 已完成 | 心跳只表示连接存活，不参与事件延迟 |
| 配置指纹移除白名单 | 已完成 | 白名单、关系、金额、事件不触发 Engine 故障保护 |
| 策略从有效白名单派生 | 已完成 | 不再手工填写 `whitelist_ids/chains` 才能交易 |
| 关系级事件类型 | 已完成 | 每条 Actor -> Target 独立选择事件 |
| Actor-only Watch | 已完成 | Project Target 只用于匹配，不创建远端 Watch |
| Watch 自动同步 | 已完成 | 白名单提交后 Outbox -> Worker -> 6551 |
| 重复链级门禁收敛 | 已完成 | 业务约束归白名单，资金一致性保护保留 |
| Token Security 告警化 | 已完成 | 税率等告警，技术不可执行条件继续阻断 |
| Dashboard Ledger 化 | 已完成 | 预算来自 Reservation/Ledger，PnL 单位明确 |
| `.env` 增量写入 | 已完成 | 保留未知键、注释和顺序，原子替换 |
| 空库/生产库统一初始化 | 已完成 | 同一 Migration 体系，Seed 不覆盖生产配置 |
| Paper/Legacy 退出 | 已完成隔离 | 代码保留，生产入口默认关闭，专项回放需显式 Flag |

P13.1-P13.5 的代码、迁移和生产配置收敛已完成。生产 ingestion/execution 心跳与 6551 WSS 状态已通过运行中的双进程 API/数据库心跳复核；本轮 Watch 收敛未解锁 Engine，也未触发交易。

## 7. 单一配置来源

1. 白名单和 `x_signal_relations` 决定 CA、链、Actor -> Project Target、关系事件、金额、次数、TP、SL 和滑点。
2. `x_signal_relations.event_types` 是关系事件的唯一业务来源；全局事件列表只保留 Provider 能力和已验证事件的只读 allowlist。
3. 有效、未过期且至少存在一条有效关系的白名单自动进入 Live 资格；不再手工维护 `live_policy.whitelist_ids` 和普通 `chains` 开关。
4. Chain Manifest、RPC、GMGN 凭据、余额、Receipt 能力、紧急停止和真实交易开关属于执行基础设施。
5. `ca_whitelist.project_x_handles` 只能作为派生投影，关系表是唯一写入来源。
6. 同一 Actor 的同一活动对同一链同一 CA 只生成一个信号；命中的多个关系写入 `matched_relation_ids`。Follow 的“只触发一次”范围保持为 Actor + CA，取消后重新关注不生成新信号。

## 8. 执行顺序

### P13.1：关系与 Watch 正确性

1. 为 `x_signal_relations` 增加 `event_types`，完成旧数据显式迁移和前端逐条选择。
2. Matcher 按 Actor、Target 和关系事件类型匹配。
3. Desired Watch 只生成 Actor，并合并同一 Actor 被多个 CA/关系引用的事件能力。
4. 白名单事务提交前写入 Watch Sync Outbox；由 ingestion 进程 Worker 幂等执行 Add/Update/Delete。
5. 同一 Actor 的多个变更合并；失败保留 `pending/error`，不回滚白名单；只有没有任何有效关系时才允许延迟删除 Watch。

### P13.2：热加载与策略收敛

1. 配置指纹只保留执行基础设施和紧急控制，白名单变化不触发 `LIVE_CONFIGURATION_CHANGED`。
2. Live Policy 从有效白名单和有效关系实时派生，缓存预热器同步使用同一来源。
3. 业务配置保存不要求再次解锁 Engine；只有执行基础设施、交易模式和紧急控制变化才停止新买入。
4. 保持 P12 Intent、Attempt、Reservation、Ledger、Reconciliation、Wallet Lane 和 Quarantine 不变。

### P13.3：重复门禁与安全策略收敛

1. 删除普通交易路径中的链单笔/日周预算、最大持仓数、每日亏损和全局 USD 重复阻断。
2. 保留白名单金额、累计预算、最大买入次数、余额、Gas Reserve、状态未知保护和资金一致性检查。
3. 买卖税、流动性、Rug 等按用户授权转为告警快照；地址非法、Quote 失败、余额不足、链未实现、凭据失效、状态不确定仍阻断。
4. 已知 Honeypot、Authority 和无法验证的关键安全事实必须在执行策略中明确分类，不能仅靠删除阈值实现隐式放行。
5. Robinhood 继续保留 UI 和 Manifest，但 `executionImplemented=false` 时不可进入 Live。

### P13.4：可靠性与观测

1. `.env` 改为增量更新、保留未知键和注释、临时文件原子替换。
2. Dashboard 改用 Reservation/Ledger；PnL 按成交时 USD 快照或按链原生币分开显示。
3. 补齐 Watch、Signal、Intent、Attempt、Order、Receipt 的关联状态和延迟指标。
4. Watch Worker 仅由 ingestion 进程运行，Execution 进程不得重复调用 6551 Watch 写接口。

### P13.5：旧路径与安装验收

1. Paper、TwitterAPI.io、SocialData 和旧 Job 已建立 Feature Flag 与可达性清单；生产默认只允许 6551，旧入口保留但不可达。
2. 基础 Schema 已纳入统一 Migration，使用 `DB_NAME`，Seed 只在明确空配置库时执行。
3. 已在隔离测试库完成 000-015 Migration、历史 Trade/Position/Ledger 不变和 014/015 断言；生产库已应用 015 Migration。
4. 四链分别完成最小真实 Signal -> Buy -> Close 回归；Robinhood 只做只读能力验收。
5. 完成 P13 新测试后，才能删除旧字段、Paper 路由和历史预算表。

## 9. 验收标准

- 保存白名单后，远端只增加需要监控的 Actor，不额外增加 Project Target。
- Watch 自动同步成功后，不需要进入设置页重复 Apply 或重复授权。
- Engine 运行中新增、暂停、修改白名单不会触发 `LIVE_CONFIGURATION_CHANGED`。
- 同一 CA 可绑定多个 Actor，同一 Actor 可绑定多个 CA，远端 Watch 仍按 Actor 去重。
- 每条关系可独立选择 Follow、Reply、Quote、Retweet、Tweet/CA/关键词提及。
- 满足白名单关系、事件、金额、次数和状态时，不再被重复链级业务预算阻断。
- 状态未知的 Attempt 不重试，也不允许同链同钱包再次写入；明确失败且未成交时仍按 P12 重试。
- Dashboard 预算来自 Reservation/Ledger，PnL 不混加不同原生币后伪装成 USD。
- 设置页不存在不生效的轮询、连续亏损、CA 冷却或默认 TP/SL/滑点配置。
- 设置页只能看到 6551 Max；Mock、SocialData、TwitterAPI.io、Paper、Shadow 和旧 `P8_VERIFIED_LIVE_EVENT_TYPES` 不再作为普通配置源。
- 未知 `.env` 键和注释不会因设置保存而丢失。
- 空数据库和现有生产数据库使用同一 Migration 体系启动。

## 10. 不在 P13 中做的事情

- 不回滚 P12 Intent/Attempt/Retry/Reconciliation。
- 不删除 Robinhood UI 和 Chain Manifest。
- 不在没有数据迁移与回归测试时直接 DROP 旧表或字段。
- 不把测试目录当成生产冗余删除；测试文件只在对应生产功能删除后同步收口。

## 11. 本次复查与执行结果

- 后端单元测试：`161/161` 通过。
- 前端生产构建：通过。
- `git diff --check`：通过。
- 专用数据库 Migration 演练：`000-015` 通过；13 条历史 fixture 表的行和原有列保持不变，Robinhood 链约束和 Watch Outbox 均存在。
- 集成测试：此前记录为 `21/21`；本轮未复跑，因为当前环境未设置 `XBOT_TEST_DB_NAME` 且没有可用的专用测试库，不能用生产库替代。发布前必须按 `backend/tests/README.md` 创建独立测试库后复跑。
- 生产数据库复查：`positions` 仅有 8 条已关闭 Live 仓位，没有 Paper 仓位；生产库已应用 `015_p13_relation_events_and_watch_outbox.sql`。
- 生产进程复查：数据库心跳显示 ingestion/execution 均为 fresh/running，6551 WSS 为 `subscribed`，Watch Sync Worker 为 enabled/running 且无错误；Engine 当前为 stopped，既有原因是 `CHAIN_CONFIGURATION_CHANGED`，不会因代码部署或 Migration 自动下单。
- 事件能力：6551 的 `tweet/retweet/quote/reply/follow` 为只读代码契约；具体 CA 是否触发仍由白名单关系的 `event_types` 决定。
- Watch 存量收敛：执行前 Desired `2`、远端 `15`、XBOT 管理 `8`；已明确接管 `@heyibinance`，并删除 `@asteroid_bags`、`@blackbullsol`、`@cupseytoken`、`@neet_sol`、`@playkintara`、`@solangelestv`、`@tripletsol`。执行后 Desired `2`、远端 `8`、XBOT 管理 `2`，`@heyibinance` 与 `@xueqiu88` 均为 `in_sync`，阻断项 `0`，动作 `0`，Watch Outbox `pending/failed=0`。
- Watch 所有权边界：远端剩余 6 条非 XBOT 管理 Watch 被保留；验收应检查 XBOT 管理范围，而不是要求远端总 Watch 数等于 Desired 数。
- 残余风险：Robinhood 已具备 UI、Chain Manifest、数据库链约束、GMGN 只读和 EVM Receipt 基础，但 `executionImplemented=false`，尚未完成 Production RPC、首次 Contract Probe 和真实 Buy/Close；这些工作由 P14 接管。旧 Provider/Paper/Shadow 代码未删除，仅做默认关闭隔离，避免误删历史回放能力。
