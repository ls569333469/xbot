# xbot 项目 Phase 1 完工与交接报告（P2/P3/P4/P5 开发指南）

## 1. 阶段完工总结 (Phase 1 Status)

本系统定位为基于 X（Twitter）KOL 动态与 CA 白名单绑定的多链 MEME 代币右侧交易系统。
当前已高标准完成 **Phase 1（信号面板 + 白名单管理）** 的全部基础工程与前后端代码，并通过了 Vite 生产环境构建编译验证。

### 1.1 系统架构与文件树 (File Directory Tree)
```text
D:\AI_Projects\xbot\
├── docs/                                    # 项目文档库
│   └── 00_系统架构与全局设计/
│       ├── PRD-MEME右侧交易系统.md          # 核心需求文档 v1.2
│       └── P1_handover_report.md            # 本交接报告
├── backend/                                 # 后端服务
│   ├── db/
│   │   ├── init.sql                         # 数据库 DDL (建表、唯一约束、索引)
│   │   └── seed.sql                         # 初始配置数据 (包含完整风控/多链初始数据)
│   ├── lib/
│   │   ├── db.js                            # PostgreSQL 连接池封装
│   │   ├── logger.js                        # 结构化日志库 (error/trade 自动落库)
│   │   ├── chain-config.js                  # 多链参数注册表 (Solana, BSC, Base, ETH, Robinhood)
│   │   ├── signal-extractor.js              # 正则提取文本中 CA 和 $TICKER 的核心库
│   │   ├── x-client.js                      # X 客户端抽象 (Phase 1 采用 mock 引擎)
│   │   └── notifier.js                      # 消息通知抽象层 (预留 Telegram Bot 接口)
│   ├── domains/                             # 业务领域控制器
│   │   ├── whitelist/                       # 白名单管理域
│   │   ├── kol/                             # KOL 账号管理域
│   │   ├── x-monitor/                       # X 监控域
│   │   ├── signal/                          # 信号匹配逻辑域 (包含三路并行匹配算法)
│   │   ├── config/                          # 系统参数动态配置域
│   │   └── system/                          # 系统健康/Dashboard 统计接口
│   ├── jobs/                                # 定时调度 Cron 任务
│   │   ├── x-poll-timeline.js               # KOL 时间线轮询 job
│   │   ├── x-poll-follows.js                # KOL 关注增量检测 job
│   │   └── signal-matcher.js                # 信号匹配匹配器 job
│   ├── cron.json                            # Cron 任务周期配置列表
│   ├── server.js                            # 入口服务 (Express API + WebSocket + Cron 编排)
│   └── package.json
└── frontend/                                # 前端面板 (Vite + React + TS)
    ├── src/
    │   ├── lib/
    │   │   ├── api.ts                       # API 请求封装 (已添加 Bearer Auth Token 机制)
    │   │   └── types.ts                     # TypeScript 全局类型定义
    │   ├── hooks/
    │   │   ├── WebSocketProvider.tsx        # WebSocket 共享连接 Context 容器
    │   │   └── useWebSocket.ts              # WebSocket 事件订阅 Hook
    │   ├── components/
    │   │   ├── Layout.tsx                   # 整体侧边栏布局
    │   │   └── ui/                          # UI 基础组件 (DataTable, Modal, Toast, ProgressBar 等)
    │   ├── pages/                           # 前端业务页面
    │   │   ├── Dashboard.tsx                # Dashboard 总览 (已接入 API 数据流)
    │   │   ├── WhitelistPage.tsx            # 白名单 CRUD + 分页/搜索 (已接入 API 数据流)
    │   │   ├── KolPage.tsx                  # KOL 管理 + 权重/关联链 (已接入 API 数据流)
    │   │   ├── SignalLog.tsx                # 实时信号流日志 + 筛选 (已接入 API 数据流)
    │   │   └── SettingsPage.tsx             # 引擎解锁/全局风控/监控配置 (已接入 API 数据流)
    │   ├── App.tsx                          # 页面路由注册
    │   └── main.tsx                         # 挂载渲染器
    └── package.json
```

---

## 2. 本地开发部署指南 (Local Setup & Run)

请指导接手同事按照以下步骤在 Windows 开发环境启动系统进行测试：

### 2.1 数据库部署 (PostgreSQL)
1. **创建数据库**：
   使用本地 PostgreSQL 控制台或 pgAdmin 创建一个名为 `xbot` 的空数据库：
   ```sql
   CREATE DATABASE xbot;
   ```
2. **导入表结构**：
   执行 `backend/db/init.sql` 创建白名单、KOL、活动记录、交易信号、持仓、预算跟踪和系统日志等表：
   ```bash
   psql -U pm_user -d xbot -f D:\AI_Projects\xbot\backend\db\init.sql
   ```
3. **初始化配置数据**：
   执行 `backend/db/seed.sql` 导入系统所需的初始链级配置、全局风控阈值和监控扫描间隔：
   ```bash
   psql -U pm_user -d xbot -f D:\AI_Projects\xbot\backend\db\seed.sql
   ```

### 2.2 后端服务启动
1. **配置环境变量**：
   将 `backend/.env.example` 复制为 `backend/.env`，填写您本地的配置：
   - 必须配置 `DB_USER` 和 `DB_PASSWORD`；
   - 本地开发调试时，`X_DATA_PROVIDER` 保持为 `mock`（会模拟马斯克推特并产生 CA 命中，方便联调）；
   - `ADMIN_TOKEN` 默认为 `<ADMIN_TOKEN>`（前端发送 API 时会自带此 Token 作为 Bearer 鉴权）。
2. **启动服务**：
   ```bash
   cd D:\AI_Projects\xbot\backend
   npm install
   npm run dev
   ```
   后端将在 `3011` 端口启动，并同时建立 WebSocket 服务在 `/ws` 地址上。系统启动后有 60 秒全局冷静期，冷启动结束后的 Cron 任务会启动。

### 2.3 前端服务启动
```bash
cd D:\AI_Projects\xbot\frontend
npm install
npm run dev
```
前端将在 `5173` 端口启动。Vite 配置了代理，所有前端发往 `/api` 和 `/ws` 的请求将被自动转发到后端的 `3011` 端口，无需处理跨域问题。

---

## 3. 后续开发蓝图 (Next Phases Developer Guide)

同事接手后应依次实施 Phase 2 至 Phase 5 的研发：

### 3.1 Phase 2 — 纸交易与模拟系统 (Paper Trading)

**目标**：在不消耗真实资金的情况下，模拟买入，记录持仓收益，统计 KOL 信号命中胜率。

#### 核心修改点与新文件：
1. **新建虚拟交易引擎** `backend/domains/trade/paper-engine.js`：
   - 当 `jobs/signal-matcher.js` 匹配到一条信号且生成 `recorded` 状态的记录时：
     - 调用只读 API 获取当前代币实时价格（可从 GMGN 获取，或利用 mock 模拟一个波动价格）。
     - 在数据库 `positions` 表中创建一条 `status = 'open'` 的模拟持仓记录，`amount_in` 和 `entry_price` 记录当时时间的价格。
2. **新建持仓价格监控** `backend/jobs/price-monitor.js`（在 `cron.json` 中配置 10 秒/次）：
   - 读取所有 `status = 'open'` 的 position。
   - 轮询获取当前代币价格，更新 `position.pnl_pct` 和当前价格。
   - 检查是否命中该 CA 对应的白名单止盈百分比（`auto_tp_pct`）或止损百分比（`auto_sl_pct`）。
   - 如果命中，将模拟持仓更新为 `status = 'tp_hit'` 或 `'sl_hit'`，并记录 `closed_at` 及最终 `pnl`。
3. **完成风控干调 (Dry Run)** `backend/domains/signal/risk-manager.js`：
   - 实现 PRD 第 9 节的四层 24 项风控规则。
   - 对信号匹配出的交易进行风控检测，但仅将检测结果记录在 `trade_signals.risk_check` (JSONB) 中，不拒绝执行。
4. **前端持仓页面与统计面板实现**：
   - 前端增加 `PositionsPage.tsx` 用于实时观测模拟持仓盈亏。
   - 前端增加 `TradeLog.tsx` 查看历史交易报表。
   - Dashboard 增加纸交易胜率统计和最大盈利/亏损等统计图表。

---

### 3.2 Phase 3 — 真实小额自动买入 (Real Small-Scale Auto Trading)

**目标**：对接真实 GMGN OpenAPI，实现自动发送小额买单并挂单 TP/SL。

#### 核心修改点：
1. **实现真实 GMGN 客户端** `backend/lib/gmgn-http.js`：
   - 使用 Ed25519 规范对请求进行签名（格式：`message = {path}:{query}:{body}:{timestamp}`）。
   - 实现 `swap(params)`：发送买卖指令。
   - 实现 `cooking(params)`：实现买入 + 同时挂止盈/止损一体化指令（适用于 SOL/BSC/Base）。
   - 实现 `createStrategyOrder(params)`：对于不支持 Cooking 的链（如 ETH/Robinhood），先执行 swap，在成交后，单独调用此方法补充挂止盈/止损单。
2. **升级风控判定** `backend/domains/signal/risk-manager.js`：
   - 将风控逻辑由 Dry Run 模式变更为拦截阻断模式。风控失败的信号，其状态设为 `rejected` 并不予开仓。
   - 实现**日亏损熔断**、**连续亏损熔断**的状态拦截机制。
3. **实现订单确认与同步** `backend/jobs/order-sync.js`：
   - 监控条件单和限价单在链上的实际成交状态，及时与本地 `positions` 表状态同步。
4. **事务锁隔离保护**：
   - 在 `domains/trade/trade-engine.js` 真实买入开仓方法中，执行事务嵌套。
   - 必须使用 `SELECT ... FOR UPDATE` 锁住对应的 `ca_whitelist` 记录及 `budget_tracking` 记录。
   - 锁定完毕后在事务内再次校验预算，通过后再向外部 GMGN API 发送下单请求，订单成功返回后再写入开仓数据并扣除预算，最后 `COMMIT` 事务。防止并发执行时产生重复买入或预算超扣。

---

### 3.3 Phase 4 — X 真实数据源对接 (X Data Provider)

**目标**：移除 `x-client.js` 中的 mock 代码，接入真实的推特数据源。

#### 核心修改点：
1. **对接 SocialData API**：
   - 在 `backend/lib/x-client.js` 中新增 `SocialDataClient` 实现。
   - 轮询调用 SocialData API 的 `/v1/twitter/tweets` 获取 KOL 推文，以及 `/v1/twitter/friends/list` 获取关注列表。
   - 计算 50 个 KOL 产生的 API 请求量及费用，优化轮询节拍。
2. **消息通知集成**：
   - 完善 `backend/lib/notifier.js` 里的接口，集成 Telegram Bot，在发生真实交易、TP/SL 触发以及预算达到警告线时及时向 TG 频道推送高亮卡片通知。

---

## 4. 关键架构要点提示 (Key Architectural Highlights)

接手开发的小伙伴应该牢记以下 PRD 评审后确立的技术重点：

1. **唯一性硬约束 (Unique Constraints)**：
   - `trade_signals` 表上建有 `UNIQUE(activity_id, whitelist_id, signal_type)`。
   - `positions` 表上建有 `UNIQUE(signal_id)`。
   - 哪怕 Cron 重叠或 API 超时重试，依靠 Postgres 唯一约束也能保障百分之百不重复开仓。
2. **两路执行策略 (Execution Flow)**：
   - SOL, BSC, Base 链：支持 Cooking，发送单笔一体化订单。
   - ETH, Robinhood 链：不支持 Cooking，发送 Swap 买单 → 轮询成交 → 创建 Strategy Order 条件单。
3. **可插拔链注册 (Multi-Chain Registry)**：
   - 添加新链时，仅需在 `backend/lib/chain-config.js` 的 `CHAIN_REGISTRY` 字典内新增一个条目（定义好链标识、Gas 符号、是否支持 Cooking 等特性字段），系统便可自动动态适配，前端亦无需调整。
