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

---

## 2. 工程文档索引 (Documentation Index)

所有核心设计、交接与工程规范文档均归档于 `docs/` 目录下，并按照 `P-` 编号进行排序分类：

```text
D:\AI_Projects\xbot\docs\
├── ENGINEERING_LOG.md                          # 本日志：项目状态与变更跟踪总览
└── 00_系统架构与全局设计\
    ├── PRD-MEME右侧交易系统.md                 # P0: 核心需求与风控设计文档 v1.2
    ├── P1_handover_report.md                    # P1: Phase 1 交接与开发指南
    ├── P2_audit_report.md                      # P2: Phase 1-3 深度安全性与高并发锁审计报告
    ├── P3_development_standards.md             # P3: xbot 前端与后台统一开发规范模板
    └── P4_handover_report.md                    # P4: Phase 1-5 完工交接与实盘操作指南
```

- **P0**：[PRD-MEME右侧交易系统.md](file:///D:/AI_Projects/xbot/docs/00_系统架构与全局设计/PRD-MEME%E5%8F%B3%E4%BE%A7%E4%BA%A4%E6%98%93%E7%B3%BB%E7%BB%9F.md)
- **P1**：[P1_handover_report.md](file:///D:/AI_Projects/xbot/docs/00_系统架构与全局设计/P1_handover_report.md)
- **P2**：[P2_audit_report.md](file:///D:/AI_Projects/xbot/docs/00_系统架构与全局设计/P2_audit_report.md)
- **P3**：[P3_development_standards.md](file:///D:/AI_Projects/xbot/docs/00_系统架构与全局设计/P3_development_standards.md)
- **P4**：[P4_handover_report.md](file:///D:/AI_Projects/xbot/docs/00_系统架构与全局设计/P4_handover_report.md)

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
- `X_DATA_PROVIDER`: 设为 `socialdata`（真实拉取）或 `mock`（前向测试模拟器）。
- `TG_BOT_TOKEN` 与 `TG_CHAT_ID`: 填入以接收实时 Telegram 卡片通知。
- `GMGN_API_KEY` 与 `GMGN_PRIVATE_KEY`: 真实交易接口授权及钱包私钥。

---

## 5. 最近变更记录 (Recent Engineering Updates)

*   **2026-07-19 (EVM 多链与精度自适应加固)**:
    - **代币精度解耦**：移除 `trade-engine.js` 原先硬编码的 `10^9` 数量缩放，改为在开仓与平仓前动态请求 GMGN 的 `getTokenInfo` 获取目标 MEME 代币真实精度（如 18 或 6），防范挂单 TP/SL 时代币额度算错被拒。
    - **EVM 包装代币地址修正**：配置了 BSC (WBNB) 与 Base (WETH) 的真实链上智能合约地址，替换原先的 mock 占位符。
    - **EVM 交易离线签名升级**：在本地解析 GMGN 原始交易体并格式化为 `ethers` 可签名的交易参数（补齐 chainId 等），安全打通 EVM 交易提交广播。

*   **2026-07-20 (P0 级全链路审查修复)**:
    - **[P0-1] 止盈止损平仓引擎路由修正**：`price-monitor` 在触发 TP/SL 时原来无论是否实盘都调用 `paperEngine`（纸交易），导致链上持仓不会被卖出。现按 `GMGN_API_KEY` 存在与否分流至 `tradeEngine.closeRealPosition`。
    - **[P0-2] 链级风控默认值修正**：`risk-manager` 中 `chain_enabled` 原为 `=== true`，当用户未在前端配置链时为 `undefined`，所有信号被 `CHAIN_DISABLED` 拦截。改为 `!== false`，默认允许所有链。
    - **[P0-3] Armed 状态持久化**：引擎解锁状态从内存变量改为持久化到 DB `config` 表。服务重启后自动从 DB 恢复，避免每次重启需手动重新解锁。
    - **[P0-4] init.sql 补全 `sim_peaks` 列定义**：全新环境部署时不再依赖 `ALTER TABLE` 动态补列。
