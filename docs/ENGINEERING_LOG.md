# xbot 工程日志与状态总览 (ENGINEERING_LOG.md)

本日志记录了 xbot 项目的阶段进展、工程标准文件索引、数据库架构变更及当前系统就绪状态。

---

## 1. 项目阶段状态总览 (Project Phases Status)

| 阶段编号 | 功能板块描述 | 当前状态 | 完工时间 | 核心验证结果 |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 0** | 可行性核验与 API 调测 | **DONE** | 2026-07-19 | GMGN 签名逻辑及 SocialData 数据结构调通。 |
| **Phase 1** | 信号面板与 KOL 白名单管理 | **DONE** | 2026-07-19 | 前端 Dashboard、KOL 面板、白名单 CRUD 入库通过。 |
| **Phase 2** | 纸交易与模拟系统 (Forward Sim) | **DONE** | 2026-07-19 | 模拟持仓、PnL 监控、模拟极值统计 (`sim_peaks`) 跑通。 |
| **Phase 3** | 真实小额自动买入与原子锁 | **DONE** | 2026-07-19 | `Armed` 状态锁、GMGN 自动 Cooking 下单与 `FOR UPDATE` 预算隔离锁跑通。 |
| **Phase 4** | 系统加固、CSV 导出与热重启 | **DONE** | 2026-07-19 | `.env` 安全掩码读写、touch 自动重载、Excel-BOM CSV 导出、`check-env` 启动自检跑通。 |
| **Phase 5** | X 真实数据对接与 TG 机器人集成 | **DONE** | 2026-07-19 | SocialData API 真实时间线/关注扫描通过；Telegram 消息异步 HTML 卡片推送通过。 |

> **2026-07-27 状态校正**：上表是早期原型阶段记录，不代表当前运行状态。P12-P16 已完成迁移演练与自动化回归；P17 Migration 024-025 已应用到当前数据库，后端已加载新代码，白名单热激活、临时故障恢复、紧凑启动与本地 DOM 验收已完成。生产环境仍需受控执行 P17 热添加、6551 可控断线恢复和用户确认后的 prepare/confirm。易变化的 Engine、`live_policy`、余额和 Provider 状态必须实时查询，不能从本日志推断。

---

## 2. 工程文档索引 (Documentation Index)

所有核心设计、交接与工程规范文档均归档于 `docs/` 目录下，并按照 `P-` 编号进行排序分类：

```text
D:\Axiangmu\xbot\docs\
├── README.md                                   # 唯一当前文档入口与 Active Plan 索引
├── ENGINEERING_LOG.md                          # 本日志：历史事实与变更时间线
└── 00_系统架构与全局设计\
    ├── PRD-MEME右侧交易系统.md                 # P0: 核心需求与风控设计文档 v1.2
    ├── P1_handover_report.md                    # P1: Phase 1 交接与开发指南
    ├── P2_audit_report.md                      # P2: Phase 1-3 深度安全性与高并发锁审计报告
    ├── P3_development_standards.md             # P3: xbot 前端与后台统一开发规范模板
    ├── P4_handover_report.md                    # P4: Phase 1-5 原型交接与操作指南
    ├── P5_audit_and_fix_report.md               # P5: 全链路审查与修复报告（降级/模拟方案全览）
    ├── P6_real_operation_iteration_plan.md      # P6: 从原型到真实运行的长期执行基线
    ├── P7_twitterapi_signal_mvp_execution_plan.md # P7: TwitterAPI.io 实现与前期验收记录
    ├── P8_6551_max_realtime_signal_execution_plan.md # P8: 6551 Max 历史实施与验收记录
    ├── P9_gmgn_live_trading_execution_plan.md       # P9.1: GMGN 实盘内核历史设计与实现证据
    ├── P10_real_trading_launch_gap_closure_plan.md  # P10: Readiness/进程守护历史收口记录
    ├── P11_final_live_trading_execution_plan.md     # P11: 四链真实交易验收记录
    ├── P12_definitive_failure_retry_and_four_chain_validation_plan.md # P12 资金状态机与 Robinhood 接入设计证据
    ├── P13_whitelist_owned_configuration_convergence_plan.md # P13 配置收敛实施证据
    ├── P14_p13_acceptance_robinhood_live_and_release_closure_plan.md # 当前唯一 Active Plan
    ├── P15_frontend_information_architecture_convergence_plan.md # P15 前端信息架构收敛实施证据
    ├── P16_advanced_exit_strategy_whitelist_templates_and_research_assistant_plan.md # P16 实现与剩余验收基线
    ├── P16_1_prelaunch_project_monitor_plan.md  # P16.1 未发币监控与固定 CA 触发纠偏
    ├── P17_whitelist_hot_activation_transient_recovery_and_compact_arm_plan.md # P17 当前发布与生产验收方案
    ├── maintenance_tool_registry.md               # 后台维护工具长期唯一登记表
    └── xbot-system-link-map.html                    # 当前系统架构与交易链路图
```

- **P0**：[PRD-MEME右侧交易系统.md](./00_系统架构与全局设计/PRD-MEME右侧交易系统.md)
- **P1**：[P1_handover_report.md](./00_系统架构与全局设计/P1_handover_report.md)
- **P2**：[P2_audit_report.md](./00_系统架构与全局设计/P2_audit_report.md)
- **P3**：[P3_development_standards.md](./00_系统架构与全局设计/P3_development_standards.md)
- **P4**：[P4_handover_report.md](./00_系统架构与全局设计/P4_handover_report.md)
- **P5**：[P5_audit_and_fix_report.md](./00_系统架构与全局设计/P5_audit_and_fix_report.md)
- **P6**：[P6_real_operation_iteration_plan.md](./00_系统架构与全局设计/P6_real_operation_iteration_plan.md)
- **P7**：[P7_twitterapi_signal_mvp_execution_plan.md](./00_系统架构与全局设计/P7_twitterapi_signal_mvp_execution_plan.md)
- **P8**：[P8_6551_max_realtime_signal_execution_plan.md](./00_系统架构与全局设计/P8_6551_max_realtime_signal_execution_plan.md)
- **P9**：[P9_gmgn_live_trading_execution_plan.md](./00_系统架构与全局设计/P9_gmgn_live_trading_execution_plan.md)
- **P10**：[P10_real_trading_launch_gap_closure_plan.md](./00_系统架构与全局设计/P10_real_trading_launch_gap_closure_plan.md)
- **P11**：[P11_final_live_trading_execution_plan.md](./00_系统架构与全局设计/P11_final_live_trading_execution_plan.md)
- **P12**：[P12_definitive_failure_retry_and_four_chain_validation_plan.md](./00_系统架构与全局设计/P12_definitive_failure_retry_and_four_chain_validation_plan.md)
- **P13**：[P13_whitelist_owned_configuration_convergence_plan.md](./00_系统架构与全局设计/P13_whitelist_owned_configuration_convergence_plan.md)
- **P14 Active**：[P14_p13_acceptance_robinhood_live_and_release_closure_plan.md](./00_系统架构与全局设计/P14_p13_acceptance_robinhood_live_and_release_closure_plan.md)
- **P15 已完成**：[P15_frontend_information_architecture_convergence_plan.md](./00_系统架构与全局设计/P15_frontend_information_architecture_convergence_plan.md)
- **P16 实现与验收**：[P16_advanced_exit_strategy_whitelist_templates_and_research_assistant_plan.md](./00_系统架构与全局设计/P16_advanced_exit_strategy_whitelist_templates_and_research_assistant_plan.md)
- **P16.1 已实现，待真实事件验收**：[P16_1_prelaunch_project_monitor_plan.md](./00_系统架构与全局设计/P16_1_prelaunch_project_monitor_plan.md)
- **P17 当前发布与生产验收**：[P17_whitelist_hot_activation_transient_recovery_and_compact_arm_plan.md](./00_系统架构与全局设计/P17_whitelist_hot_activation_transient_recovery_and_compact_arm_plan.md)
- **维护工具登记表**：[maintenance_tool_registry.md](./00_系统架构与全局设计/maintenance_tool_registry.md)
- **架构图**：[xbot-system-link-map.html](./00_系统架构与全局设计/xbot-system-link-map.html)

---

## 3. 数据库架构当前状态 (Database Schema Status)

当前 PostgreSQL `xbot` 的核心数据边界：

1. 信号域：`x_provider_events`、`x_activities`、`trade_signals`、`x_signal_relations`、`ca_whitelist`、`x_kol_accounts`。
2. 交易提交域：`trade_attempts`、`trade_orders`、`trade_attempt_events`、`prepare_tokens`。
3. 仓位与策略域：`positions`、`position_lots`、`strategy_groups`、`strategy_legs`。
4. 链上证据域：`chain_receipts`、`chain_readiness_evidence`。
5. 预算域：`budget_reservations`、`budget_ledger`；旧 `budget_tracking` 仅用于兼容历史结构。
6. 运行治理：`config`、`trade_runtime_state`、`service_heartbeats`、`provider_rate_events`、`notification_outbox`。
7. P12-P16 已新增：`trade_intents`、失败证据、重试决策、Wallet Write Lane、链级熔断、关系事件、Watch Sync Outbox、投研与未发币监控结构。
8. P17 已新增：`whitelist_activation_outbox`、白名单激活版本/状态、`arm_preparations` 及启动失败证据；专用测试库和当前数据库均已验证 Migration 000-025，生产升级备份与回滚点已形成。

---

## 4. 外部密钥配置自查表 (Environment Credentials Checklist)

系统已支持在前端 API 配置面板完成全部配置写入。自查变量：
- `SOCIALDATA_API_KEY`: 填入以激活 X 实盘数据拉取。
- `X_DATA_PROVIDER`: 当前为 `6551`（Max Watch + WSS）。
- `OPENNEWS_TOKEN`: 6551 Max REST/WSS 鉴权和应用 Provider 已接入；事件类型是否可进入 Live 仍按 P8 逐项验收。
- `TWITTERAPI_IO_API_KEY`: 已加入正式 Provider、密钥掩码、全 Key 限流和 Credits 熔断；P8 中保留为对照或显式回退能力，不与 6551 同时生成生产信号。
- `TG_BOT_TOKEN` 与 `TG_CHAT_ID`: 填入以接收实时 Telegram 卡片通知。
- `GMGN_API_KEY` 与 `GMGN_PRIVATE_KEY`: GMGN Agent API 鉴权及请求签名；`GMGN_PRIVATE_KEY` 不是链钱包私钥。

---

## 5. 最近变更记录 (Recent Engineering Updates)

*   **2026-07-26 (P16.1 未发币项目监控与固定 CA 触发纠偏)**:
    - 将已知 CA 与未发币项目拆成两条独立链路：固定 CA 的项目账号只保留身份或生态互动目标，只有生态账号行为可触发当前 CA；未发币监控不预填 CA，由项目来源或可选生态互动事件发现首个唯一有效 CA。
    - 新增 Migration 020、Launch Monitor CRUD/状态/Watch Impact、6551 Launch Matcher、Discovery 审计、同链同 CA 锁和原子白名单/Signal 物化；无 CA、多 CA、链格式错误和重复事件均失败关闭。
    - 历史固定 CA Project Direct Source 共 16 条已停用并保留身份；Migration 没有创建 Launch Rule、Signal、订单或远端 Watch 写入，已有交易证据不变。
    - 白名单页新增 `已知 CA / 未发币监控` 双入口和三步未发币工作区；桌面与 `390x844` DOM 验收通过，无 CA 输入或横向溢出。固定 CA 工作区明确不因项目账号自己的动态买入。
    - 修复旧数据或热更新状态缺少 `event_types` 时账号规则组件可能渲染失败的问题，固定 CA 与未发币表单统一归一化事件数组。
    - 后续白名单实测修复三处交互：研究候选的身份选择与候选删除拆分；生态账号建议支持关闭按钮、`Esc` 和点击外部关闭；Grok `display_name/role/association/confidence` 完整进入证据快照并显示在项目身份行。
    - 最终验证：后端单元测试 `213/213`，独立 `xbot_test` 数据库 Migration 000-020 与集成测试 `27/27`，前端 lint/build、桌面与 `390x844` DOM、`git diff --check` 通过。
    - 本轮没有保存真实未发币监控、同步 6551 Watch、启动 Engine 或发起交易；唯一剩余验收是用户选定真实项目账号、链、模板和金额后的首条真实未发币事件闭环。

*   **2026-07-25 (P16 高级策略、白名单模板与快速投研方案及实施)**:
    - 初始审计确认现有 GMGN Token Info、1 小时 Token 缓存、权重调度、6551 Profile Client、白名单多对多关系和 Strategy Group/Leg 可以复用；当时缺少模板、研究报告、6551 Tweets/Search/KOL Followers 封装和 Grok Client。
    - 新增 P16 方案，统一规划多段固定/移动止盈止损、白名单模板与复制、链 + CA 自动补全，以及 Robinhood 在内的 GMGN + 6551 快速投研助手。
    - 复核 GMGN 官方语义：`profit_stop.price_scale=100` 为上涨 100%，`loss_stop.price_scale=20` 为下跌 20%；当前简单策略语义正确，P16 将其固化为 Strategy Compiler 契约测试。
    - 投研结果严格区分 Project Target、Founder/CEO/Team 候选和高影响力 Actor；所有候选必须展示证据与置信等级，只能生成白名单草稿，不能自动保存、同步 Watch 或触发交易。
    - Grok/xAI 定位为可选第二阶段；MVP 使用 GMGN + 6551 即可完整工作。正式前端更新前必须先交付独立 HTML 原型供用户审核。
    - 补充 GMGN 无官方 X 的回退链路：先由 6551 精确搜索完整 CA，结果为空或冲突时由用户主动调用具备实时 X/Web 搜索能力的 Grok，再用 6551 回查候选；没有直接来源的结果始终保持“待确认”。
    - 复核现有关系模型发现 Actor/Target 强制不同且 Target 必填，无法正确表达项目官方账号直接发帖；P16 补充多项目身份账号、无 Target 的 Direct Source Rule，以及链负责人/产品经理/发射平台/KOL Actor 到项目账号的 Interaction Relation。
    - 将现有 `x_kol_accounts` 历史下拉记录纳入 P16 生态高权重账号库：保留历史账号，新增组织/角色备注、来源、证据、置信度、收藏和使用次数；推荐候选与 6551 Watch 分离，并用分页搜索替代一次加载全部账号。
    - 明确 6551 成本按唯一 Actor Watch 和事件并集增长，不按 CA 关系数重复：同一批 10 个 Actor 关联 100 个 CA 仍只有 10 个远端 Watch；P16 保存前增加复用/新增 Watch、事件扩展和月度消息投影摘要。
    - 根据对话结果收敛 P16：确认每链默认模板、投研一键生成草稿、多项目账号与生态 Actor、历史账号库、全局 Watch 去重和 GMGN 无 X 的 Grok 回退；剩余决策只有策略预设比例、具体 xAI 模型/预算和 HTML 原型审核。
    - 原型阶段先将标准 `XAI_API_KEY` 加入 `.env.example`、Settings API 允许列表和密钥掩码；仅确认掩码状态，未读取或记录真实值，该阶段尚未新增 Grok Client 或发起 xAI 请求。
    - 二次复核补充同链同 CA 合并、Direct Source/Interaction 事件语义拆分、专用创建工作区、事务 + Watch Outbox 原子边界和 Grok 去重/费用审计；独立交互原型为 `xbot-p16-whitelist-research-preview.html`。
    - 原型阶段的首轮生产改动仅增加 `XAI_API_KEY` 环境读写、允许列表与密钥掩码保护；Grok Client 与投研业务逻辑在后续实施轮次完成。
    - 根据原型审核反馈完成信息架构 V2：新增白名单收敛为“代币与模板、X 触发账号、资金与离场、确认保存”四步任务流；快速投研改为独立入口，研究结果仅回填草稿并返回账号步骤，右侧只保留进度而不重复表单。
    - 完成 Migration 017、旧 TP/SL 等价迁移、历史 Tweet Signal 证据迁移、版本化离场策略 Compiler、模板 CRUD、Direct Source、项目身份账号、账号库和 Watch 影响预览；Migration 不写远端 Watch，旧成交、仓位、Attempt 和 Order 保持不变。
    - 完成 GMGN Metadata/Security/Pool 快速投研、6551 官方账号 Profile 核验、可选 `grok-4.5 + x_search` 严格结构化扩展、单个/批量研究和一键生成白名单草稿；外部文本统一清洗，私网/文件 URL 被拒绝，研究结果不能自动保存或触发交易。
    - 正式数据库已应用 Migration 017；后端测试 `191/191`、独立数据库集成测试 `21/21`、P16 历史迁移演练、前端 build/lint 与正式 Schema Audit 均通过。桌面和 `390x844` 移动端完成列表、四步编辑、Direct Source、Interaction、策略和单个/批量投研只读验收，无横向溢出或控制台错误。
    - Supervisor 已安全拉起新代码，Engine 恢复既有 `desired_running=true / status=running` 意图；本轮没有保存白名单、修改 Watch、切换实盘参数或发起真实交易写请求。
    - 剩余 P16 工作仅按方案未勾选项执行：真实 GMGN/6551 只读契约、6551 Search/KOL 推荐、xAI 缓存与费用审计、消息投影摘要、Grok 候选回查，以及一笔用户确认金额的新策略真实 Buy/条件单/取消/Close。
    - 2026-07-26 实施后审计修复模板事件未应用、研究证据未随草稿保存、切换 CA 残留账号上下文、跨链复制配置、账号置信度可被降级、输入校验不完整和私网 IPv6 URL 漏检；单元测试增至 `195/195`。
    - 清理无引用的旧 P15 设置页 HTML 原型。P16 原型、Migration 演练和现有测试均有明确设计或回归用途，继续保留。
    - P16 最终复查新增 Migration 019，补齐研究任务取消、刷新恢复、并发上限、GMGN 报告复用、xAI Token 用量审计、候选关联说明及 6551 完整 CA Search 核验；失败项重试不再重复执行 GMGN 基础扫描。
    - 最终本地验证为后端单元测试 `204/204`、独立数据库集成测试 `23/23`、Migration 017 -> 018 -> 019 隔离演练、前端 lint/build 和桌面/`390x844` DOM 全部通过；迁移未改写 Position、Trade Attempt、Trade Order 或 Watch Outbox。
    - 本轮未触发真实 Grok、真实 Provider 契约探针或资金交易。最低实盘 Migration 已提升至 019，升级前的最终批准必须在恢复自动交易前重新执行。

*   **2026-07-25 (维护工具退出日常前端并建立长期登记)**:
    - 从设置页移除 Robinhood 只读诊断、30 分钟限时验收、结束验收和生产批准操作；同时删除无消费者的前端验收 API 包装，后端路由、门禁、Migration 和测试保持不变。
    - 新增 `maintenance_tool_registry.md`，登记新链验收、6551 Watch 补偿、钱包隔离解除、链熔断重置、环境热重载、告警测试、测试库和审计脚本的唯一入口、前提、副作用和前端策略。
    - 核心 PRD 与开发规范明确：维护工具默认 Backend/CLI only；只有真实生产异常可显示条件式恢复入口；前端不可见不等于死代码。
    - Robinhood 已生产批准，限时验收当前未开启；本轮未修改任何后端验收状态、Engine、白名单、重试开关或资金参数。

*   **2026-07-25 (P15 前端信息架构与配置收敛)**:
    - 设置页收敛为“交易 / 运行状态 / 系统维护”三个任务视图；默认交易视图只保留真实交易启停、统一失败重试开关和白名单派生范围摘要。
    - 删除逐链失败重试表单，新增统一重试策略 API；用户只决定是否允许明确未成交后的重试，链级次数、窗口、费用上限和 Gas 保留由后端 Chain Manifest 统一派生。
    - GMGN、6551 运行指标移入运行状态并默认折叠诊断；Robinhood 验收、API、RPC 和数据库配置移入系统维护；重复 CA 列表改为白名单管理入口。
    - 后端完整测试 `179/179`、前端 production build、Lint 与 `git diff --check` 通过；桌面端和 `390x844` 移动端三个视图无横向溢出、控件裁切或重叠，页面重载后无新增控制台错误。
    - 现有 Supervisor 已重新拉起 ingestion/execution 进程加载新代码；Engine 仍为 stopped，五链失败重试仍全部关闭，本轮未修改任何实盘参数或执行资金写操作。

*   **2026-07-25 (P14 证据门禁与 Robinhood 接入复核)**:
    - 将 Contract Probe、Trade Intent、Retry Audit、Shadow 和 `manual_e2e` 统一到内容寻址代码版本；显式发布版本也附带源码哈希，代码变化后旧验收证据自动失效。
    - Contract Probe 上下文新增白名单资金参数、TP/SL、滑点、次数、到期时间及 Actor/Project/Event 关系；真实 Buy 创建 Attempt 前再次比对作用域上下文，验收中修改配置不能沿用旧证据。
    - 修复 Robinhood 未纳入 EVM CA 地址小写规范化与大小写无关查重的问题，防止同一 CA 重复创建或关系合并失败。
    - 新增严格校验生产库名称的测试库 `recreate/drop` 管理脚本；独立数据库集成测试 `21/21`、Migration 013-016 历史演练、后端 `173/173`、前端 lint/build 全部通过，两座临时测试库均已删除。
    - 当前后端与前端已恢复运行，Engine 为 stopped；Robinhood 仍无白名单、费用预留和最低 Gas 保留，钱包上次核验为 `0 ETH`，未开启验收作用域，未调用任何 Swap/Strategy 写接口。

*   **2026-07-24 (P14 P13 验收、Robinhood 实盘与生产收尾方案)**:
    - 新增 P14 作为唯一 Active Plan，接管 P13 专用测试库与生产行为验收、Robinhood 首次只读接入和真实自动 Buy/Close、四链更新后回归、逐链 Retry 与发布收尾。
    - 当前复核：Migration 013-015 已应用；后端单元测试 `161/161`、前端 production build 通过；无未决 Intent、无 Wallet Quarantine，五链 Circuit 均为 open，6551 WSS 心跳为 subscribed，Engine 为 stopped。
    - Robinhood 已有 Chain Manifest、数据库链约束、GMGN 只读和 EVM Receipt 基础，但缺少 `ROBINHOOD_RPC_URL`、钱包资金、Active 白名单、Contract Probe 和真实 Buy/Close 证据；同时确认 Readiness 只探测 Execution Chains，存在首次接入循环门禁。
    - 代码盘查发现 P13 已移除普通链 `enabled` 配置，但 Buy/Close Retry 仍检查 `chainConfig.enabled`，会导致启用 Retry 后仍被拒绝；列为 P14-A0 发布前 P0 修复。

*   **2026-07-24 (P14 门禁与 Robinhood 验收代码实施)**:
    - Migration 016 已应用，将代码能力、Contract Probe、限时验收作用域和生产批准拆成四层；Robinhood 代码能力标记为已接入，但生产批准继续关闭。
    - Live Policy 在正常状态只接受 `live_enabled=true` 链；限时验收存在时全系统只允许指定的一条白名单，作用域过期后保持空策略，不能自动恢复四链。
    - 新增 Robinhood 定向只读诊断，覆盖 Wallet、RPC、Token/Pool/Security/Quote 和 Strategy 查询；证据绑定代码版本、配置上下文、CA 和有效期，钱包仅保存哈希引用。
    - `manual_e2e` 不再因 Sell confirmed 自动通过，改为核验完整 Buy/Close、Receipt、Position/Lot、Strategy 和 Budget/Ledger；生产批准必须绑定同一次已完成验收和当前上下文。
    - Buy/Sell Retry 移除旧 `chainConfig.enabled` 依赖；Buy Retry 仍要求 Engine armed，Sell Retry 可在停止新买入时继续退出仓位。
    - 设置页新增 Robinhood 中文验收区，提供只读诊断、30 分钟验收、结束验收和生产批准四个明确动作；这些按钮不会自动启动 Engine。
    - 自动化验证通过：后端 `166/166`，前端 lint 与 production build 通过。此结果只证明代码契约，不代表 Robinhood 已完成真实 Buy/Close。
    - 本轮只编制和复核方案，没有修改 Engine、链门禁或调用任何资金写接口。

*   **2026-07-24 (P14 Robinhood 只读网络与配置补漏)**:
    - 从 Robinhood 官方文档确认主网 `chainId=4663`，Public RPC 为 `https://rpc.mainnet.chain.robinhood.com`；官方明确该端点限流且不建议生产，XBOT 仅将其用于首次 Contract Probe/小额验收，正式批准前仍需稳定 Provider RPC。
    - 实测官方 RPC 返回 `0x1237`、最新区块约 3 秒新鲜、连续响应约 330-520ms 且区块持续增长；GMGN 推荐高档 Gas 约 `0.338408 gwei`。
    - GMGN Robinhood 钱包链上余额经官方 RPC 只读核对为 `0 ETH`，因此未开启验收作用域、未启动 Engine、未调用 Swap 或 Strategy 写接口。
    - 修复 P14 配置遗漏：设置 API、`.env.example` 和前端支持 Robinhood 最大费用预留与最低 Gas 保留；开启限时验收前强制要求 RPC 和两项正数配置，设置页显示 RPC、费用、Gas、余额和白名单状态。
    - 移除逐链费用预留的隐藏默认值；所有链 Readiness 和执行准备均要求显式正数配置，缺失时明确返回费用/Gas 配置阻断，不再产生前后端口径漂移。
    - 自动化验证：后端 `168/168`，前端 lint/build 通过；真实 Contract Probe 仍需充值、真实白名单及关系后执行。

*   **2026-07-24 (P14 独立数据库验收)**:
    - 新建隔离测试库安装 Migration 000-016 后，数据库集成测试 `21/21` 通过；测试发现旧预算 fixture 假设新库链天然获批并期待已删除链预算，已改为测试显式批准 SOL 且只断言白名单本金/费用语义，未放宽生产门禁。
    - Migration 演练扩展至 013-016：13 张历史业务表字段/行数保持不变，历史 Attempt/Intent、预算/Ledger、八张 Robinhood CHECK、P13 Watch Outbox/关系事件、P14 Evidence Context/Acceptance Scope 全部通过，Outbox 行数 `1 -> 1`。
    - 两座临时测试库均已删除；生产库未执行故障注入或测试 fixture 写入。

*   **2026-07-24 (P12 本地复核、错误修复与生成物清理)**:
    - 本地源码已包含 P12-A/P12-B 交易内核，但当前业务数据库仍停在 Migration 012，`trade_intents`/`wallet_write_lanes` 尚不存在；运行中的旧后端未重启，避免在没有新备份时自动应用 013。
    - 当前 Engine 为 `fault_protected`、`armed=false`，没有未平 Live Position；6551 心跳正常。历史 ETH Sell Attempt `#119` 已 confirmed，旧日志中的 `CHAIN_NATIVE_PROCEEDS_UNVERIFIED` 是成交确认前的历史告警，不是当前未决订单。
    - 修复前端滚动升级兼容问题：缺少 P12 链配置字段时不再向数值输入框传入 `NaN`；Position 列表 Schema Drift 检查不再误判平仓子接口；API 对 HTML/空响应返回清晰错误，不再直接抛出 JSON 解析异常。
    - 源码无完全重复文件，P12 新模块均被生产入口引用；Paper、TwitterAPI.io、SocialData、Shadow、Robinhood UI 和测试资产按可达性清单保留。
    - 删除停止进程留下的旧 Supervisor/ingestion/execution/Codex 前端日志和可重建的 `frontend/dist`；运行中服务占用的四个日志、数据库备份、PEM、`.env` 与依赖目录保留。
    - 验证通过：后端单元测试 `146/146`、独立数据库集成测试 `21/21`、Migration 013 历史回填演练、前端 oxlint/TypeScript/production build。测试库和构建产物在验收后已删除。

*   **2026-07-23 (P12 独立数据库迁移与集成验收)**:
    - 新建独立测试库实际执行 Migration 001-013；数据库集成测试 `21/21` 通过，覆盖 6551 去重、关系匹配、Readiness、预算并发、部分平仓、Strategy 竞态与双 Retry Worker `SKIP LOCKED` 领取。
    - 集成测试发现并修复 `trade-intent-repository.js` 中 `next_retry_at` 的 PostgreSQL `timestamptz/text` CASE 类型冲突；修复后完整集成套件通过。
    - 新增 `npm.cmd run test:migration:p12`：只接受名称含 `test` 的空数据库，构造 013 前历史交易图并核对 13 张业务表、Intent 回填、预算/Ledger 关联、Outbox 和八张 Robinhood 链 CHECK。
    - Migration 013 历史演练结果：1 条历史 Attempt 对应 1 条 Intent，13 张表旧字段和行数未变化，Outbox `1 -> 1`，八张 Robinhood 链约束全部生效。
    - 本轮未读取密钥、未调用 GMGN Swap/Strategy、未启动后端，也未修改生产数据库；生产 Migration、四链更新后真实 Buy/Close、逐链重试开放仍未执行。

*   **2026-07-23 (P12 交易可靠性内核代码实施，生产验收未完成)**:
    - 新增 Trade Intent、多 Attempt、稳定 `source_key`、活动 `scope_key`、失败证据、Retry Decision、Terminal Audit、Late Confirmation 和 Multiple Fill 事故处理。
    - GMGN Swap/Strategy 写请求继续保持 HTTP 零自动重试；只有 `definitive_failed_no_fill` 可调度下一 Attempt，timeout、5xx、429、非 JSON 和缺 Order ID 均保持 `uncertain` 或阻断。
    - 新增同链同钱包 Wallet Write Lane/Quarantine 与链级连续失败熔断；钱包隔离只阻断对应链钱包，链熔断只阻断故障链新 Buy，人工解除必须记录操作者、原因和证据。
    - Chain Manifest 统一四链和 Robinhood 的链参数、交易默认值、Receipt/费用能力；Robinhood 已改为 `chainId=4663`、Gas 币 ETH，但 `enabled=false`、`retryEnabled=false`、`executionImplemented=false`。
    - 前端设置、信号、仓位和交易记录已显示 Intent/Attempt、重试剩余次数、失败证据、费用信封、钱包隔离和链熔断，并提供带审计原因的人工处置入口。
    - 代码复核补齐历史 Signal 来源键回填、重复 Signal 终态恢复、Provider 首响应失败进入证据队列、无 Hash 观察期钱包隔离、目标链独立 Readiness 和进程中断前置 Attempt 恢复。
    - 离线验证通过：后端 `146/146`、前端 oxlint、TypeScript 与 production build、`132` 个 JavaScript 文件语法检查和 `git diff --check`。
    - 该阶段仅完成代码和离线自动化验证；后续独立测试库 Migration 已通过，但四链更新后真实 Buy/Close 回归、生产指标告警和 Robinhood 真实闭环仍未完成，不能宣称 P12 全部完成。

*   **2026-07-23 (P12 统一迭代方案重排与 Robinhood 只读契约确认)**:
    - 生产数据库重新核对：SOL `4/4`、BSC `2/2`、Base `1/1`、ETH `1/1` 真实 Buy/Sell Attempt 均 confirmed，对应 Receipt 共 `16` 条 confirmed，四链 Live Position 全部 closed。
    - 原 P12 中“Base 尚未平仓、ETH 尚未测试”的状态已作废；P12 重排为 A 架构与文档治理、B 明确失败重试、C Robinhood 接入、D 稳定与受控清理。
    - Robinhood 官方链参数确认为 Arbitrum EVM L2、`chainId=4663`、Gas 币 ETH；GMGN Wallet、Gas、Trenches、Token、Security、Pool、Quote 和 Strategy List 只读请求均成功。
    - Robinhood 钱包当前余额为 `0 ETH`，未调用 Swap 或其他资金写接口；代码仍保持禁用，真实接入必须经过最小 Buy/Close 和 RPC Receipt 验收。
    - 架构图纠正 Robinhood 的建模：它是 GMGN Provider 下的 EVM Chain Manifest，不是 Robinhood Provider；Binance 不能替代 Robinhood CA 交易。
    - 新增 `docs/README.md` 作为唯一当前文档入口；P9-P11 保留为历史证据，不再作为并行 Active Plan。

*   **2026-07-22 (P9.1 严格实施完成，保持资金门禁关闭)**:
    - 完成 GMGN `/v1` Client、严格 Adapter、14 weight/s 全 Key Scheduler、四链 Execution、Attempt/Order/Strategy/Lot/Receipt/Budget、Always-on Reconciler、安全 Close、Readiness 和前端控制台的 P9.1 代码更新。
    - 新增生产进程角色：`npm.cmd run start:ingestion` 独占 6551 WSS/Ingestion，`npm.cmd run start:execution` 独占 API、全部 GMGN 调用、Reconciler、Live Queue、Outbox 和单个内存 Scheduler；`NODE_ENV=production` 禁止 `all` 角色。
    - 数据库迁移器增加 PostgreSQL advisory lock；`009_p9_shadow_evaluations.sql` 已应用并只增加 Shadow Evaluation 结构。Shadow 默认关闭，关闭时不创建轮询 Timer。
    - EVM Receipt 校验增加 RPC chainId、唯一钱包区块余额差和 replacement 恢复：旧 Hash dropped 后只接受同一 GMGN Order 明确返回的不同新 Hash，否则保持人工对账。
    - 浏览器复核修复移动端固定侧栏导致的页面横向溢出；小屏改为顶部可滚动图标导航，Settings/Positions/Signals 页面宽度与视口一致，Trade Log 宽表仅在表格容器内滚动。
    - 前端鉴权加载收口：缺少本地 `ADMIN_TOKEN` 时不再请求 Settings 数据、不查询 Engine 状态且不发起 WebSocket 握手；填写 Token 并刷新后才启动动态数据，浏览器复测 5 秒新增 401 为 0。
    - P9.1 清单只勾选已有代码或数据库证据；真实 RPC/reorg、生产 429=0、24 小时且 50 条 Shadow、告警验收、Admin Token 轮换、T0-T14 和 M9-M11 保持未完成。
    - 最终验证：后端 `103/103`、前端 lint、production build、`117` 个 JS 文件 `node --check`、`check-env` 和 `git diff --check` 均通过。
    - 本轮没有调用 GMGN Swap、Strategy Cancel 或任何真实资金写接口；最终保持 `TRADING_MODE=signal`、Engine Locked、`LIVE_TRADING_ENABLED=false`、`SHADOW_LIVE_ENABLED=false`，四链继续不可 Live。

*   **2026-07-22 (P9.1 亚秒交易路径与 GMGN 429 零触发方案)**:
    - P9 从 Solana-only 调整为 `sol/bsc/base/eth` 公共交易内核，各链按 `implemented -> contract_tested -> shadow_verified -> live_enabled` 独立解锁，不因代码存在而自动开放实盘。
    - 新增 6551 亚秒 Fast Path：原始 Inbox 快速提交、关系与风险快照缓存、实时 Quote、预算/权重原子预留和单次 Swap；本地 `receive_to_signal` P95 目标 `<=300ms`，WSS 收到到 GMGN accepted 工程目标 `<=1s`，不把 6551 上游或链上 confirmed 延迟算入承诺。
    - GMGN 统一采用全 Key Weighted Rate Scheduler：官方 20 weight/s 基础上内部硬上限 14 weight/s；每笔新交易预留 Quote 2 + Swap 5 共 7 weight；热订单 1 秒查询后按 2/5/15-30 秒降频，稳定策略不得永久每秒查询。
    - P9.1 M8 要求前端展示官方/内部权重桶、查询阶段、实时可用权重、队列、429 冷却与每笔订单的上次/下次查询；初期只读，计时和调度始终由后端执行。
    - 429 改为全局冷却状态：读取 reset header/body、暂停至 reset+jitter、写请求不自动重试、首次触发告警并降低上限；生产目标为主动 429 为 0，限流测试仅使用 mock/fixture。
    - 修正 GMGN `client_id` 语义：它是短时鉴权防重放 UUID，不是业务幂等键或订单查询键；无 `order_id` 的 timeout 进入 `submission_uncertain`，不能自动重试。
    - 增加 Position Lot、Strategy Group/Leg、Chain Receipt、多链 USD/Native 预算、Transactional Outbox、Prepare Token 一次性 CAS 和至少 24 小时且 50 条有效 Signal 的 Shadow Live 门禁。

*   **2026-07-21 (P9 GMGN 托管钱包真实交易方案)**:
    - 深度复盘 P6/P8、GMGN 官方本地文档、交易引擎、风控、订单同步、价格监控、数据库、前端和当前测试覆盖，确认“单笔真实买入已验证”不等于“自动 Live 已完成”。
    - P9 将 6551 Signal 与资金执行分开验收，定义 Trade Attempt、Provider Order、Strategy、Position 和 Budget Ledger 的独立状态与职责。
    - 正式执行统一采用 GMGN Agent API 托管钱包；旧本地钱包签名流程、卖出失败后伪关闭、Locked 时停止对账和 Live 双卖风险列为阻断项。
    - 执行顺序固定为：保护现有 CUPSEY 仓位 -> Client/Adapter -> 数据库与预算 -> SOL 开仓 -> Always-on Reconciler -> 安全平仓 -> 前端与告警 -> 受控真实测试 -> 单关系小额自动 Live。
    - 当前基线验证为后端 52/52、环境检查、前端 lint 和 build 全部通过；自动交易、真实平仓、崩溃恢复和资金对账测试仍待 P9 实施。

*   **2026-07-21 (P8 复核与冗余代码清理)**:
    - 修正 P8 Follow 验收冲突：`wanshenme -> neet_sol` 已在 P7 产生永久信号，P8 重关必须跨 Provider 去重；首次 Follow 正向闭环改用一条从未触发过的新关系。
    - 将默认离线测试与 Max 外部探针、Watch 付费变更分离；`test:6551-max-access` 默认不再建立 WSS，只有显式 `--wss` 才测试短暂订阅。
    - 删除已被替代或不再符合当前契约的临时脚本：Pro/Follow 探针、TwitterAPI.io 高频关系探针、旧 Arm、旧 GMGN 签名、会改写真实 `.env` 的保存脚本。
    - 手动平仓脚本不再自动选择第一条持仓或使用硬编码 Token；现在必须显式传入 Position ID 和 `--confirm`。
    - 将独立 matcher 断言迁入正式 `node:test`，新增 handle 大小写、无 `$` 关键词边界、CA 与优先级覆盖；后端测试增至 17 项。
    - 清理前端无用 import、无用回调参数、重复 Token 读取和 Hook 依赖；拆分 Toast/WebSocket Context，保持 Fast Refresh 文件边界清晰。

*   **2026-07-21 (6551 Max 权限基线与 P8 执行入口)**:
    - 新增 `backend/scripts/test-6551-max-access.js` 与 `npm run test:6551-max-access`，测试仅查询 Watch 列表并建立短暂 WSS 订阅，不执行任何 Watch 变更或交易。
    - Max Watch 列表返回 HTTP 200、358ms、`cost=0`；当前远端 3 条为 `RootDataCrypto`、`leakmealpha`、`WY_mask`，均只开启 Tweet + CA，在完成所有权确认前禁止自动删除。
    - WSS 476ms 建连、654ms 完成 `twitter.subscribe`，`ping/pong` 成功，确认 Max 权限已正式生效。
    - 新增 P8 作为当前执行入口：6551 负责事件驱动实时信号，TwitterAPI.io 保留为前期验收记录和显式回退能力；第一阶段严格保持 Signal-only 与 Locked。
    - P8 将更新拆分为 Provider、Watch 所有权同步、单例 WSS、Inbox/语义去重、真实行为验收、断线/计费/24 小时测试、50/200 账号扩容和 Paper 门禁；GMGN 应用交易契约继续独立重构。

*   **2026-07-21 (6551 Pro 全矩阵与 GMGN 链上闭环)**:
    - Pro 阶段一次性矩阵测试的 12 项只读调用中 10 项成功，Watch 按套餐预期返回 403，Retweet Users 两条不同推文均返回 HTTP 400；确认扣费 8 points。升级 Max 后临时 Pro 脚本已退役，结果保留在 P7。
    - 使用官方 `gmgn-cli@1.5.2` 成功读取绑定 Solana 托管钱包及 `0.500001 SOL` 初始余额，并完成 NEET Token Info、Security、Pool 和 0.005 SOL Quote。
    - 真实买入 `0.005 SOL -> 18.700189 NEET` 与全部卖回 `18.700189 NEET -> 0.004984157 SOL` 均达到链上 `confirmed`；最终余额 `0.498010896 SOL`、NEET 为 0，完整闭环成本约 `0.001990104 SOL`。
    - 新增 `npm run audit:solana-tx`，通过 Solana 主网 RPC 独立确认两笔交易无错误、网络费各 5,010 lamports；总余额差额还包含路由/平台成本及可能可回收的代币账户租金。
    - 本次真实交易由官方 CLI 独立执行，XBOT 始终保持 Signal/Locked、Active Position=0、Trades Today=0、Budget 为空。
    - 发现应用内 `gmgn-http`/`trade-engine` 仍是旧交易契约且错误复用 GMGN API PEM 私钥作为链钱包私钥；正式 Live 前必须切换到 `/v1/trade/swap -> query_order -> confirmed` 托管钱包流程。

*   **2026-07-21 (6551 Pro 权限与容量实测)**:
    - Pro Token 的 `twitter_user_tweets` 与 `twitter_follower_events` 均返回 HTTP 200，单次各消耗 1 point，实测延迟分别为 1291ms 与 194ms。
    - `twitter_kol_followers(neet_sol)` 返回 HTTP 200、约 359ms，但未识别此前已关注的 `wanshenme`，不能据此替代任意 KOL 的实时关注检测。
    - `twitter_watch` 与 `twitter_watch_add` 均返回 HTTP 403 `please upgrade to a higher plan`；`twitter_wss` 握手未成功。当前 Pro 不具备自定义 Watch/WSS 权限，与控制台消费规则中仅 Max 适用一致。
    - Pro 的 10,000 points/月额度若用于逐账号 REST 轮询，50 个账号只能约 3.6 小时一次，200 个账号只能约 14.4 小时一次，无法满足 300ms-1s 信号目标。
    - Max 套餐页已确认支持最多 600 个自定义监控账号。P7 已补充 50/200 账号在不同事件活跃度下的额度耗尽时间；升级后仍需实测事件 payload、延迟、补发和不足 20 条推送的计费规则。
    - 再次核对 6551 官方仓库最新 main 提交，本地 Skill 与官方版本一致；Watch/WSS 事件类型覆盖 XBOT 所需的发帖、回复、引用、转发、CA 和新关注。
    - 可行性结论为“Max 可用于 Signal-only MVP 合约验收，但尚未达到 Paper/Live 上线标准”；官方未提供延迟 SLA、断线重放协议，Reply/Quote/Retweet 的目标账号字段也需真实 payload 验证。

*   **2026-07-21 (P7 TwitterAPI.io Signal-only 主链路实施)**:
    - 新增 `signal/paper/live` 运行边界，服务重启强制 Locked；Signal-only 不调用 Risk、GMGN 或交易引擎，也不创建持仓。
    - TwitterAPI.io 已接入 Profile、Followings、关系探针和 Tweet Stream 订阅；缺 Key 时失败关闭，不回退 Mock。
    - Follow 使用完整 baseline 与按 KOL 增量快照，新增关注提交后立即本地匹配；取消后重关、同 KOL+CA、分页缺口均有永久幂等保护。
    - Webhook 支持标准 Tweet 与 `fast_tweet` payload，共享 Secret、时间窗、Provider event ID 和数据库唯一约束共同防重放。
    - Provider 统一处理 `401/403/429/5xx/timeout/network`，记录 calls、credits、延迟、错误、USD 估算、剩余额度和熔断状态。
    - API 路由和 WebSocket 均使用 `ADMIN_TOKEN`；后端默认仅监听 `127.0.0.1`。当前历史默认 Token 必须在公网部署前轮换。
    - 后端 14 项自动化测试通过，覆盖 Signal-only、Follow baseline/新增/重关/gap/fan-out、Webhook 重放及 Provider 重试；前端构建、环境自检和数据库 schema 审计通过。
    - 当前仍保持 `TRADING_MODE=signal`、`X_DATA_PROVIDER=socialdata`、Stream 关闭、交易引擎 Locked；没有执行真实 TwitterAPI.io 请求或真实交易。

*   **2026-07-21 (P7 TwitterAPI.io 真实 Followings 验收)**:
    - `X_DATA_PROVIDER` 已切换为 `twitterapi`，但 Follow/Stream/Matcher/Price/Order Cron 继续关闭，只进行有界人工请求。
    - `wanshenme` Profile 显示 66 个 Following；完整 baseline 单页完成，写入 66 条 seen，未生成历史 Activity、Signal 或 Position。
    - 第三个 60 秒增量周期发现新增关注 `neet_sol`，生成 Activity `48` 与 Signal `28`；Signal 状态为 `signal_only`，CA 为 `Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump`。
    - 检测观察窗口约 62 秒，Live/Paper 预算与买入次数均为 0，Position 为 0。
    - 取消关注后 Provider 确认为 `false`，重新关注后确认为 `true`；三个后续增量周期均未生成第二条 Activity 或 Signal。
    - 最终保持 Activity=1、Signal=1、Follow once=1、Position=0，Live/Paper 预算和买入次数均为 0，真实重关去重验收通过。
    - 本次累计 13 个正式请求、1036 Credits、估算 `$0.01036`，Provider 错误为 0；Tweet Stream 真实验收仍待执行。

*   **2026-07-21 (TwitterAPI.io 关注关系 MVP 探测)**:
    - TwitterAPI.io `check_follow_relationship` 已使用真实 Key 返回有效关注状态，单次响应约 `0.8-1.2s`。
    - 免费层实测限制为每 5 秒最多一次请求，连续运行时仍可能返回 `HTTP 429`；测试探针已调整为默认 6 秒并支持自动退避。
    - 新增白名单映射 `neet_sol -> Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump`，KOL 继续使用 `wanshenme`。
    - 当前仍保持 `TRADING_MODE=paper`、`engine_armed=false`；下一步先完成 `signal` 模式隔离，再把 TwitterAPI.io 接入正式信号链路。

*   **2026-07-19 (EVM 多链与精度自适应加固)**:
    - **代币精度解耦**：移除 `trade-engine.js` 原先硬编码的 `10^9` 数量缩放，改为在开仓与平仓前动态请求 GMGN 的 `getTokenInfo` 获取目标 MEME 代币真实精度（如 18 或 6），防范挂单 TP/SL 时代币额度算错被拒。
    - **EVM 包装代币地址修正**：配置了 BSC (WBNB) 与 Base (WETH) 的真实链上智能合约地址，替换原先的 mock 占位符。
    - **EVM 交易离线签名升级**：在本地解析 GMGN 原始交易体并格式化为 `ethers` 可签名的交易参数（补齐 chainId 等），安全打通 EVM 交易提交广播。

*   **2026-07-20 (P0 级全链路审查修复)**:
    - **[P0-1] 止盈止损平仓引擎路由修正**：`price-monitor` 在触发 TP/SL 时原来无论是否实盘都调用 `paperEngine`（纸交易），导致链上持仓不会被卖出。现按 `GMGN_API_KEY` 存在与否分流至 `tradeEngine.closeRealPosition`。
    - **[P0-2] 链级风控默认值修正**：`risk-manager` 中 `chain_enabled` 原为 `=== true`，当用户未在前端配置链时为 `undefined`，所有信号被 `CHAIN_DISABLED` 拦截。改为 `!== false`，默认允许所有链。
    - **[P0-3] Armed 状态持久化**：引擎解锁状态从内存变量改为持久化到 DB `config` 表。服务重启后自动从 DB 恢复，避免每次重启需手动重新解锁。
    - **[P0-4] init.sql 补全 `sim_peaks` 列定义**：全新环境部署时不再依赖 `ALTER TABLE` 动态补列。
