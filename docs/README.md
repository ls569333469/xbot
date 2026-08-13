# XBOT 文档入口与当前迭代状态

> 更新时间：2026-08-13
> 当前执行基线：P27.2 策略隔离 hotfix 已以唯一 SHA `af8ce074ecb53a41785e7dcb3b47bbe84c15be05` 和 tag `p27.2-production-20260813` 发布并部署到 xiexiu；Migration `000-049` 零变更、Schema Audit、双角色 Supervisor、6551 WSS/Watch、Readiness 和部署窗口 GMGN/429 零增量均已验收。新增 KOL 或保存单条策略不再因 Watch 同步窗口停止全局 Engine；Engine 当前保持 stopped/disarmed，是否恢复真实交易由用户单独确认。

## 当前事实

| 范围 | 当前状态 |
|---|---|
| X 信号 | 6551 Max Watch + WSS 为生产主链路 |
| SOL | 真实 Buy 4 / Sell 4 / Receipt 8，全部仓位已关闭 |
| BSC | 真实 Buy 2 / Sell 2 / Receipt 4，全部仓位已关闭 |
| Base | 真实 Buy 1 / Sell 1 / Receipt 2，仓位已关闭 |
| Ethereum | 真实 Buy 1 / Sell 1 / Receipt 2，仓位已关闭 |
| Robinhood | 已完成真实 Buy/Close、Receipt 与生产批准，当前作为第五条正常交易链；限时验收未开启，验收能力仅保留为后台维护工具 |
| P13 | P13.1-P13.5 代码与生产 Watch 收敛已完成，Migration 015 已应用；专用测试库集成测试 21/21 与历史升级演练已通过，真实 Provider 正式生产行为验收仍纳入 P14 |
| P14 实施 | Migration 016、新链诊断、限时验收、完整 E2E 证据和生产批准门禁均已实现；Robinhood 已完成真实验收和生产批准，剩余工作只保留发布与自然失败观察 |
| P15 前端收敛 | 设置页已收敛为交易、运行状态和系统维护；新链验收操作已退出前端，维护工具统一登记 |
| P16 新能力 | Migration 017-019、离场策略 Compiler、白名单模板、CA 自动补全、Direct Source/Interaction、账号库、GMGN + 6551/xAI 快速投研、xAI 用量审计和四步工作区已实现；真实 Provider 契约探针、6551 KOL 推荐、消息投影摘要、PONS 真实 Grok 基准和新策略小额实盘仍待完成 |
| P16.1 触发纠偏 | Migration 020、未发币项目监控、首个唯一 CA 原子物化、全局 Signal 去重和 `已知 CA / 未发币监控` 双入口已实现；固定 CA 项目账号只保留身份/互动目标，不再直接触发；待真实未发币事件验收 |
| P17-P19 | 固定 CA 热更新、Watch 幂等、服务器部署收敛和低延迟实盘执行链路已实现；固定与动态策略复用同一 P19 最终交易门禁 |
| P20 | Migration 028-035、Candidate Index、动态解析、账号级策略、模板、Record/Paper/Live、方案 A 四步工作区和按链原生币预算已实现；部署前按 P20 测试方案完成回归 |
| P21 | Migration 036-037、账号研究独立化、新关注发现、Grok/x_search、人员-项目关联证据、作用域和共享交易链路已实现；真实交易验收仍需发布前单独执行 |
| P22 | Migration 038-039、GMGN 共享限流状态、冷却治理和 P21 verification snapshot 已实现；限流回归已通过，真实 Provider 状态以服务器实时检查为准 |
| P23 | 已完成全历史深度审计、第一批不可达旧代码清理、迁移职责收敛、Migration 000-040 演练、完整回归和隐私扫描；生产只读 Schema Audit、服务器发布和真实交易验收待执行 |
| P24-P26 | 单 Signal GMGN 边界、三策略成交基线恢复、Attempt 幂等与双角色 Supervisor 已实现；P26 已作为 P27 的可回滚应用基线 |
| P27 | Migration manifest `044`、Signal snapshot `045`、可靠 outbox `046`、精确本地回填 `047`、共享 GMGN 元数据 `048-049`、`p27.v1` REST 契约、可靠事件、设计系统和发布审计已实施并部署到 xiexiu |
| P28 | GitHub 分支/tag、服务器备份与隔离恢复、Migration `036-049`、双角色 Supervisor、Nginx/TGBOT、鉴权 API 和页面刷新 GMGN 零增量均已验收；生产三策略、6551 WSS/Watch 和允许启动配置已恢复，Engine 仍保持 stopped/disarmed，公网人工 DOM 与三策略真实资金闭环待执行 |
| P29 | GitHub 与 xiexiu 日常发布工作手册已建立；区分应用 hotfix、完整发布和纯配置操作，固化网络门、唯一 Audit、Engine/资金检查、备份、不可变 release、原子切换、回滚和部署后验收流程 |
| P30 | 动态喊单预设资产路由处于投研暂停状态；已定义词条到链/CA 的结构化映射、互动原帖所有权、回复/引用/直接转发边界、互斥路由和 GMGN 零额外调用标准；当前未授权实施 |
| P31 | 账号研究终态详情与固定 CA 快速投研调度回归已修复；实盘时投研降为单并发并服从真实交易优先、Trade Lease 与 429 冷却，本地已验收，尚未部署 xiexiu |
| P12 明确失败重试 | 核心代码和统一前端开关已实现；当前五链自动重试均关闭，只有用户主动开启后才生效 |

运行时 `live_policy`、Engine Armed 状态和链开关会随测试变化，必须以数据库/API 实时结果为准，不能从历史文档推断。

## 当前入口

1. [P20 账号级关键词动态交易方案](./00_系统架构与全局设计/P20_account_scoped_keyword_signal_execution_plan.md)：当前动态策略架构、接口、运行链路和发布标准。
2. [P20 动态策略测试方案](./00_系统架构与全局设计/P20_dynamic_strategy_test_plan.md)：本地、独立测试库、Paper/Live 和服务器发布验收步骤。
3. [P21 账号研究与关注发现方案](./00_系统架构与全局设计/P21_account_research_and_follow_discovery_plan.md)：账号研究、新关注事件、Grok/x_search、证据和唯一 CA 链路。
4. [P22 GMGN 预热与限流治理方案](./00_系统架构与全局设计/P22_gmgn_warmup_and_rate_limit_remediation_plan.md)：共享限流、冷却、缓存和 Provider 审计。
5. [P23 实盘就绪分层与历史链路治理方案](./00_系统架构与全局设计/P23_live_readiness_scope_and_architecture_remediation_plan.md)：二次确认、策略作用域、GMGN 调用、服务编排和发布治理。
6. [P24 单信号 GMGN 执行边界与全局调用治理方案](./00_系统架构与全局设计/P24_single_signal_gmgn_execution_boundary_plan.md)：未触发零调用、单信号单会话、全局 Provider Gate 和三策略并发治理。
7. [P25 三策略成交基线恢复与 GMGN 契约统一方案](./00_系统架构与全局设计/P25_three_strategy_execution_baseline_and_gmgn_contract_remediation_plan.md)：以 GitHub 已成交固定 CA/P20 为基线，修复 P24 回归并统一 P21、GMGN Security/Gas/Quote/Swap 执行标准。
8. [P26 三策略生产硬化与人工验收方案](./00_系统架构与全局设计/P26_three_strategy_production_hardening_and_manual_acceptance_plan.md)：Attempt 幂等、双角色进程、恢复和人工实盘验收基线。
9. [P27 服务器同步前全链路收口方案](./00_系统架构与全局设计/P27_server_sync_preflight_and_three_strategy_contract_convergence_plan.md)：统一字段、元数据、事件、前端设计、Migration trust、Secret 和服务器发布验收。
10. [P27 自动验收报告](./00_系统架构与全局设计/P27_automated_acceptance_report_2026-08-12.md)：记录代码、Migration、数据库恢复、DOM、GMGN 调用与发布边界的自动验收证据。
11. [P28 xiexiu 服务器部署与 GitHub 发布方案](./00_系统架构与全局设计/P28_xiexiu_server_deployment_and_github_release_plan.md)：记录唯一 release SHA、GitHub 分支/tag、服务器备份、Migration `036-049`、双角色 Supervisor、Nginx/TGBOT、冷启动验收和待执行实盘恢复。
12. [P29 GitHub 与 xiexiu 部署工作手册](./00_系统架构与全局设计/P29_github_and_xiexiu_deployment_operations_runbook.md)：日常 hotfix/完整发布分流、故障速查、原子切换、回滚和完成定义。
13. [P30 动态喊单预设资产路由方案](./00_系统架构与全局设计/P30_dynamic_preset_asset_routing_plan.md)：词条到链/CA 的显式映射、互动原帖解析、互斥选择、Revision 快照、6551 补读和 GMGN 边界的待授权实施方案。
14. [P31 研究链路可见性与调度收敛方案](./00_系统架构与全局设计/P31_account_research_result_visibility_and_status_convergence_plan.md)：账号研究终态详情、失败可观测性，以及固定 CA 快速投研的交易优先动态调度。
15. [维护工具登记表](./00_系统架构与全局设计/maintenance_tool_registry.md)：后台验收、事故恢复、Provider 补偿和 CLI 工具的长期唯一清单。
16. [P14 历史生产收尾方案](./00_系统架构与全局设计/P14_p13_acceptance_robinhood_live_and_release_closure_plan.md)：已实施能力与历史验收证据。
17. [P16 高级策略、模板与快速投研方案](./00_系统架构与全局设计/P16_advanced_exit_strategy_whitelist_templates_and_research_assistant_plan.md)：当前实现、自动化验收和剩余真实验收清单。
18. [P16.1 未发币项目监控与固定 CA 触发纠偏](./00_系统架构与全局设计/P16_1_prelaunch_project_monitor_plan.md)：双链路边界、Migration 020、实现与验收结果。
19. [P15 前端信息架构收敛](./00_系统架构与全局设计/P15_frontend_information_architecture_convergence_plan.md)：日常前端、运行状态和维护边界。
20. [P13 配置收敛与旧路径治理](./00_系统架构与全局设计/P13_whitelist_owned_configuration_convergence_plan.md)：白名单配置收敛实现证据。
21. [P12 统一迭代方案](./00_系统架构与全局设计/P12_definitive_failure_retry_and_four_chain_validation_plan.md)：资金状态机和明确失败重试设计证据。
22. [系统架构与交易链路图](./00_系统架构与全局设计/xbot-system-link-map.html)：当前生产链路、买入、平仓、新链扩展边界。
23. [核心 PRD](./00_系统架构与全局设计/PRD-MEME右侧交易系统.md)：产品需求和维护工具前端边界。
24. [工程日志](./ENGINEERING_LOG.md)：按时间记录实现和验收事实，不作为并行执行方案。
25. [外部官方资料](./external/)：GMGN、6551 等 Provider 的本地官方文档快照。
26. [P12 生产可达性清单](./00_系统架构与全局设计/P12_production_reachability_inventory.md)：生产主链路、显式回退、测试资产和暂不删除项。

## 启动与测试

项目启动、端口、测试数据库隔离和安全边界统一见根目录 [README](../README.md)。生产 `npm start` 由 Supervisor 先执行 `npm run migrate` 再启动 `ingestion/execution`；业务角色不再隐式执行迁移，本地 `server.js --role=all` 仍可自举。首次应用 P12 Migration 前必须先停止新交易并备份生产数据库。默认 `npm.cmd test` 不写数据库，`npm.cmd run test:integration` 必须显式提供名称包含 `test` 的独立测试库；迁移演练还要求另一座空测试库。

## 当前发布顺序

| 顺序 | 工作流 | 资金动作 |
|---:|---|---|
| 1 | 停止新买入，保留已有订单对账与持仓退出；完成代码、依赖、Migration 和 Secrets 审计 | 不新增交易 |
| 2 | 提交并推送同一 commit；服务器备份、升级 Node、`npm ci`、Migration 及只读 Schema audit | 保持新买入关闭 |
| 3 | 固定链路和 Record 冒烟通过后，按需启用 Paper 或单账号小额 Live | 由用户明确启动 |

## 历史文档

- P9：GMGN 托管交易内核、限流、订单与 Receipt 设计和实现证据。
- P10：真实交易门禁、Readiness 和进程守护的历史收口方案。
- P11：四链最终真实交易执行与验收记录。
- P1-P8：原型、审计、Provider 选型和 6551/TwitterAPI.io 演进记录。

历史文档保留用于审计，不应继续使用其中的“当前为 Mock”“实盘冻结”“ETH 未测试”等状态判断。

## 文档规则

1. 当前状态只更新本文件、当前 Active Plan 和架构图；P12-P15 保留设计、实施与验收证据，P16 同时记录已实现能力与剩余真实验收，不反向改写历史文档。
2. 一个功能只有一个 Active Plan；设计、实施记录和验收证据分开表述。
3. `DONE` 必须绑定代码、自动化测试或真实 Provider/Order/Receipt 证据，不能只表示页面存在。
4. 数据库数量、余额、`live_policy` 和 Engine 状态属于易变化事实，文档必须写核对时间。
5. `.env`、PEM、API Key、完整钱包地址和未脱敏外部响应不得写入文档、日志示例或测试 fixture。
6. 测试目录是验证资产，不是生产执行入口；只有生产可达性和测试覆盖都确认后才允许删除代码。
7. 维护工具必须登记在 `maintenance_tool_registry.md`；前端无入口不能作为删除后端工具的依据。
