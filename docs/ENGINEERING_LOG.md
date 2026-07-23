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

> **2026-07-22 状态校正**：上表中的 `DONE` 表示原型功能代码与页面已经形成，不表示真实 Provider、Paper 或 Live 已通过持续运行验收。当前项目状态以 P6/P8/P9.1 为准：P8 负责 6551 实时信号验收，P9.1 负责 GMGN 托管钱包交易状态机、限流、对账、平仓和逐链小额 Live 灰度；两者分别验收，当前自动实盘继续冻结。

---

## 2. 工程文档索引 (Documentation Index)

所有核心设计、交接与工程规范文档均归档于 `docs/` 目录下，并按照 `P-` 编号进行排序分类：

```text
D:\Axiangmu\xbot\docs\
├── ENGINEERING_LOG.md                          # 本日志：项目状态与变更跟踪总览
└── 00_系统架构与全局设计\
    ├── PRD-MEME右侧交易系统.md                 # P0: 核心需求与风控设计文档 v1.2
    ├── P1_handover_report.md                    # P1: Phase 1 交接与开发指南
    ├── P2_audit_report.md                      # P2: Phase 1-3 深度安全性与高并发锁审计报告
    ├── P3_development_standards.md             # P3: xbot 前端与后台统一开发规范模板
    ├── P4_handover_report.md                    # P4: Phase 1-5 原型交接与操作指南
    ├── P5_audit_and_fix_report.md               # P5: 全链路审查与修复报告（降级/模拟方案全览）
    ├── P6_real_operation_iteration_plan.md      # P6: 从原型到真实运行的长期执行基线
    ├── P7_twitterapi_signal_mvp_execution_plan.md # P7: TwitterAPI.io 实现与前期验收记录
    ├── P8_6551_max_realtime_signal_execution_plan.md # P8: 当前 6551 Max 实时信号执行方案
    └── P9_gmgn_live_trading_execution_plan.md       # P9.1: 多链 GMGN 实盘、Fast Path 与限流方案
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

---

## 3. 数据库架构当前状态 (Database Schema Status)

当前 PostgreSQL `xbot` 数据库表结构均已完成物理加固，核心表清单：
1.  **`ca_whitelist`**：白名单规则，包含每日最大买入次数及止盈/止损线。
2.  **`x_kol_accounts`**：KOL 推特监控账号及权重。
3.  **`x_activities`**：采集到的推文与关注变更流。
4.  **`trade_signals`**：匹配生成的待交易信号（通过唯一约束防重：`UNIQUE(activity_id, whitelist_id, signal_type)`）。
5.  **`positions`**：实盘/模拟持仓表。
    *   *加固字段*：`sim_peaks` (JSONB, 用于记录纸交易/实盘波动最高点与最高亏损)；`sell_tx_hash` (TEXT, 记录出场链上哈希)。
6.  **`budget_tracking`**：链级每日限额追踪表，包含并发事务锁定隔离。
7.  **`system_configs`**：存放风控规则阈值等配置。

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
