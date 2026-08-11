# P21 账号研究独立化与新关注发现策略最终方案 A

> 版本：v2.2
>
> 状态：方案 A 已完成本地代码实施与自动化验证，等待 Migration rehearsal 和服务器部署
>
> 更新日期：2026-08-06
>
> 开发基线：本地当前工作区、Migration 036、Node 24

## 1. 最终决策

P21 采用方案 A，只做两项产品变更：

1. 将“账号清洗/账号研究”从动态喊单页面移出，放入 `KOL` 页面二级页签。
2. 在策略中心新增“新关注发现策略”，用于监控高权重账号的新关注事件，识别被关注账号是否为真实项目方，并解析唯一可信 CA。

P21 不再包含动态预算简化，不实施方案 B 的独立一级导航，也不建设新的运营控制台。

```text
KOL
├─ KOL 账号
└─ 账号研究

策略中心
├─ 固定 CA / 项目策略
├─ 动态喊单策略
├─ 新关注发现策略
└─ 新增策略
```

## 2. 变更边界

### 2.1 P21 范围

- 账号研究迁移到 `KOL` 二级页签；
- 动态喊单页面移除账号清洗区域；
- 新增关注发现 Policy、事件记录、解析状态和工作区；
- 复用 6551 Watch 合并与同步机制；
- 复用现有交易模板、资金门禁、Signal、持仓、对账和离场链路；
- 新增必要的数据库表、索引、API 和测试；
- 默认从 Record 阶段开始，不因部署或保存自动进入 Live。

### 2.2 明确不修改

- 固定 CA 策略的配置、匹配和交易行为；
- 动态喊单的关键词、Cashtag、Hashtag、CA 和项目名解析行为；
- P19 低延迟执行链路；
- P20 动态 Target 物化和交易流程；
- 现有逐链单笔金额、每日限额、重复买入和滑点语义；
- Quote、Swap、持仓、平仓、止盈止损、对账和重试；
- Engine 启停、实盘授权和现有全局安全门禁；
- 现有 API 版本，不新增 `/api/p21/*` 一类临时接口。

任何实现如果需要改变上述内容，必须退出 P21 范围并单独立项审核。

## 3. 选择方案 A 的原因

| 维度 | 方案 A：KOL 二级页签 | 方案 B：独立侧边栏 |
|---|---|---|
| 对现有导航影响 | 无一级导航变更 | 新增一级入口 |
| 用户理解 | 账号研究属于 KOL 管理 | 容易被理解为新的核心业务域 |
| 开发范围 | 小 | 中等 |
| 回归范围 | KOL、动态页、策略中心 | Layout、权限、移动导航、全局路由 |
| 上线风险 | 较低 | 较高 |

方案 A 符合“小范围修改、保持线上交易稳定”的原则。方案 B 仅保留为历史对比预览，不进入正式实现。

### 3.1 本轮历史经验修正

此前对 `@AgilePeter` 的实际研究显示，目标账号可能是创始人、CEO 或核心成员，自己不一定直接发布 CA；其 Bio 或原创内容可能只指向项目官方账号，例如 `@wen_officialx`，而 CA 由项目官方账号发布。P21 因此采用“人员 -> 项目账号 -> CA”的扩展解析，但只增加解析证据，不改变交易执行链路。

该关系链必须同时满足：

1. Target 账号被识别为 `founder`、`ceo`、`executive`、`core_contributor` 或 `team_member` 等项目人员身份；
2. Target 的 Bio 或原创内容提及关联账号；
3. 关联账号的 Bio 或原创内容反向提及 Target，形成双向关系；
4. 关联账号被识别为 `official_project` 或项目账号；
5. CA 只来自 Target/关联项目账号的自有 Bio、置顶原创、近期原创或官网，且仍需 GMGN 独立验证。

普通 KOL、生态账号或单向提及不会自动形成项目关系，也不会因为市值、流动性或 KOL 地址数量较多而获得交易授权。

## 4. 前端信息架构

### 4.1 KOL 页面

`/kol` 保持当前一级入口，新增二级页签：

```text
[KOL 账号] [账号研究]
```

`KOL 账号` 保持现有列表、标签、权重、启停和进入策略工作区行为。

`账号研究` 使用左侧批次、右侧结果的结构：

- 左侧：研究批次、数量和状态；
- 右侧顶部：账号输入、时间范围、开始研究；
- 右侧统计：样本数、直接意图率、CA 解析率、歧义率、胜率；
- 右侧表格：逐账号研究结果；
- 详情：逐帖证据、候选 CA、历史收益和失败原因。

账号研究只允许以下显式动作：

- 加入 KOL 账号库；
- 创建动态喊单策略草稿；
- 创建新关注发现策略草稿；
- 继续观察；
- 标记不建议。

这些动作不得自动创建 Live Policy、不得自动同步 Watch、不得启动 Engine。

### 4.2 动态喊单页面

动态喊单工作区保持现有四步交易配置。只移除账号清洗区域，不调整字段、模板、保存方式和运行语义。

动态页面继续显示与当前策略直接相关的内容：

- 词条与 CA 解析配置；
- 最近解析记录；
- 最近信号和交易结果；
- Revision、Watch 和运行阶段。

### 4.3 策略中心

策略中心新增页签“新关注发现策略”，继续复用当前正式版的左列表、右详情结构。

列表显示：

- 监控 KOL；
- 运行阶段；
- 允许链摘要；
- Watch 状态；
- 启用状态；
- 当前 Revision。

详情显示：

- 触发事件；
- 今日发现账号数；
- 唯一 CA 数；
- 项目身份判断方式；
- CA 证据来源；
- 复用的交易模板；
- 最近拒绝原因。

## 5. 统一前端设计标准

P21 不创建新的视觉体系，直接复用正式版 `frontend/src/index.css` 的设计语言。

### 5.1 字体与字号

字体栈：

```css
font-family: "Lato", "PingFang SC", "Microsoft YaHei", sans-serif;
```

字号只按角色使用，不允许同级标题出现多个大小：

| 角色 | 字号 | 用途 |
|---|---:|---|
| 页面标题 | 20px | 顶栏标题、工作区主标题 |
| 区块标题 | 17px | 页面内主要模块、步骤内容标题 |
| 面板标题 | 13px | 列表标题、卡片标题、字段组标题 |
| 导航文字 | 14px | 桌面侧边栏 |
| 正文和按钮 | 12px | 按钮、表格、主要配置值 |
| 辅助说明 | 11px | 描述、Revision、运行摘要 |
| 元信息 | 10px | 标签、状态、次要时间和证据来源 |

禁止出现没有角色依据的 `15px`、`18px`、`21px` 标题。

### 5.2 组件标准

- 桌面侧边栏宽度保持 240px；
- 顶栏高度保持 73px；
- 主操作使用正式版紫色；
- 运行成功使用绿色，警告使用黄色，错误使用红色；
- 普通按钮高度 38px；
- 步骤按钮桌面高度约 58-62px；
- 四步工作区沿用固定 CA 的横向 Stepper；
- 桌面使用左列表、右详情；
- 移动端状态区和 Stepper 纵向完整展开，不隐藏关键字段；
- 表格在移动端仅允许表格容器内部横向滚动；
- 不新增卡片套卡片、营销式大标题或与正式版不一致的圆角。

## 6. 新关注发现四步工作区

### 步骤 1：监控账号

- 从现有 KOL 账号库选择 Actor；
- 显示 X User ID 和 6551 身份核验状态；
- 选择 `record / paper / live` 运行阶段；
- 默认 `record`；
- 确认只处理 Actor 主动关注的新账号；
- 建立 Baseline，历史关注列表不生成 Signal；
- 同一 Actor 和 Target 的 Follow 行为永久幂等。

### 步骤 2：发现与验证

- 配置允许链；
- 配置允许的官方 CA 来源；
- 配置账号最低年龄和原创内容要求；
- 配置允许或拒绝的平台与域名；
- Grok 官方 API 使用 x_search 检索 Target 的 Bio、置顶/原创内容、官方项目账号和关联人员；
- Grok 输出项目/人员/生态/KOL 分类、角色类型、候选 CA、Tweet/官网来源和 citations；
- 候选 CA 必须在 Grok 引用的 Target 或已验证项目账号自有证据摘录中出现；本地重新提取，不信任模型猜测；
- 关联项目账号产生的 CA 需要记录 Target、关联 Handle、关系证据、发布时间和 CA 来源；
- GMGN 对完整 CA 做地址级核验；
- 多候选或证据冲突必须拒绝，不按市值强行选择。

### 步骤 3：交易配置

- 直接选择现有交易模板；
- 展示模板中的逐链买入金额；
- 展示现有预算、重复买入、滑点和离场摘要；
- 不在 P21 中新增或重定义交易字段；
- 保存 Policy 时记录模板引用和不可变配置快照，避免后续模板修改影响旧事件。

### 步骤 4：确认并保存

- 显示 Actor、运行阶段、允许链和 CA 标准；
- 显示交易模板和 Watch 影响；
- 显示新 Revision；
- 保存成功后通过现有 Outbox 同步 Watch；
- 保存不得自动启动 Engine；
- Record 保存后真实 Swap 调用必须为 0。

## 7. 运行链路

```text
6551 new follow
  -> 确认 Actor 和 Follow 方向
  -> Baseline 与永久行为去重
  -> 写入 Follow 事件
  -> Grok 官方 Responses API + x_search 检索 Target、项目账号和人员关系
  -> Grok 返回候选 CA、Tweet/官网来源、发布时间、摘录和 citations
  -> 本地从 Grok 证据摘录重新提取完整 CA并校验作者归属
  -> GMGN 精确地址核验
  -> 唯一 chain + CA 判定
  -> 物化现有交易 Target / Signal
  -> 重新检查 Revision、时效、模板、预算、持仓和 Engine
  -> P19 现有执行链路
```

关注发现只负责从未知 Target 得到可信 `chain + CA`。人员账号的 CA 来源可以来自关联项目账号，但必须保留完整关系证据；一旦得到规范化 Target，后续必须进入现有交易链路，禁止新建第二套 Quote 或 Swap 实现。

## 8. 项目身份与 CA 标准

### 8.1 可接受的项目证据

- Target Profile/Bio；
- Target 置顶原创帖；
- Target 近期原创帖；
- Profile 直接链接的官方网站；
- GMGN 返回并与 Target X Handle 或 Website 对齐的信息。

### 8.2 人员关联项目证据

当 Target 是创始人、CEO 或核心成员时，允许通过关联项目账号取得 CA，但必须保留以下四类证据：

- Target 的身份分类和角色类型；
- Target -> 项目账号的 Bio/原创提及；
- 项目账号 -> Target 的反向提及；
- 项目账号自有 CA 来源与 GMGN Handle/Website 对齐结果。

关联账号必须是项目官方或项目账号。只有生态账号、普通 KOL、单向提及、搜索结果或 Grok 猜测不能作为人员关联 CA 来源。

### 8.3 不可作为 Live 授权的证据

- 回复区其他账号贴出的 CA；
- 转发或引用中不属于 Target 的 CA；
- 搜索摘要、广告页和非官方聚合页；
- Grok 根据名称或 Symbol 猜出的 CA；
- 只有名称/Symbol 相同、没有官方锚点的候选；
- 钱包地址、交易哈希或 URL 参数。
- 仅有人员账号与项目账号的单向关注或单向提及；
- 只有人员身份，没有项目官方账号的反向关系和自有 CA；
- 只有关联项目账号，没有可验证的 Target 人员身份。

### 8.4 唯一 CA 条件

进入 Live 前必须同时满足：

1. CA 格式与链一致；
2. GMGN 精确回显同一地址；
3. Token 可交易且链身份明确；
4. 直接项目账号场景下，X Handle、Website 或平台证据至少一项与 Target 一致；人员关联场景下，GMGN Handle/Website 必须与关联项目账号一致，且关系证据链完整；
5. 官方来源中没有并列冲突候选；
6. 当前 Policy Revision、Watch、时效和 Engine 有效；
7. 不存在同 CA 的 pending、open、closing 或 uncertain 仓位。

原盘和社区重启盘都真实但上下文无法区分时，结果必须为 `ambiguous`，不得仅按市值、流动性或 KOL 数量自动买入。

## 9. 数据与 API 设计

### 9.1 数据库

P21 只新增一份向前兼容 Migration 036，不修改 Migration 000-035。

建议新增：

- `follow_discovery_policies`：Actor、mode、enabled、template reference、snapshot、Revision、Watch 状态；
- `follow_discovery_events`：Actor、Target、Provider 时间、behavior key、解析阶段、证据摘要、拒绝码；
- 必要的唯一索引、状态索引和事件时间索引；
- `ca_whitelist.source` 或对应来源约束增加 `follow_discovery`，用于复用现有 Target 物化链路。

不新增第二套交易、持仓、预算或离场表。

### 9.2 API

保留并复用：

- `/api/actor-screening`：账号研究；
- `/api/kol`：KOL 账号库；
- `/api/x-monitor/6551/watch-plan`：全局 Watch 计划；
- 现有 whitelist/template、system、trade 和 dynamic-signal API。

新增独立领域资源：

```text
GET    /api/follow-discovery/policies
POST   /api/follow-discovery/policies
GET    /api/follow-discovery/policies/:id
PATCH  /api/follow-discovery/policies/:id
DELETE /api/follow-discovery/policies/:id
POST   /api/follow-discovery/watch-impact
GET    /api/follow-discovery/events
GET    /api/follow-discovery/events/:id
```

API 继续使用当前统一响应格式、管理员认证、错误码和审计字段。禁止复制 `/api/trade`、`/api/whitelist` 或 `/api/actor-screening` 的能力。

## 10. 后端模块边界

新增领域建议放在 `backend/domains/follow-discovery/`：

- `routes.js`：资源 API；
- `service.js`：Policy 保存、Revision 和事件查询；
- `resolver.js`：项目身份、证据和唯一 CA 决策；
- `event-worker.js`：异步处理 Follow 事件；
- `repository.js`：数据库访问；
- `errors.js`：稳定拒绝码。

必须复用：

- 6551 Consumer 和 Watch Sync；
- KOL identity；
- GMGN client 和缓存；
- dynamic target materialization；
- Signal risk manager；
- P19 live execution queue；
- 现有 position、reconciliation 和 exit service。

## 11. 关键安全规则

- Follow 事件必须以 X User ID 标识 Actor 和 Target；
- Handle 改名不得创建新身份；
- `behavior_key = follow:{actorUserId}:{targetUserId}` 永久幂等；
- Policy Revision 更新后，旧排队任务取消；
- Follow 解析和 Whitelist Activation 的 Provider 429/`RATE_LIMIT_BANNED` 都读取 `reset_at`，把下一次尝试排到冷却结束之后，不在冷却期间重复请求；
- Provider 429 只进入瞬态等待，不自动停止全局 Engine；
- Provider 恢复后只继续未过期事件；
- 官网抓取必须防 SSRF、限制重定向、超时、响应大小和内容类型；
- Grok 不可单独授权 CA；
- Record、Paper、Live 严格分层；
- 部署、Migration 和保存 Policy 都不得自动启动真实交易。

## 12. 测试方案

### 12.1 旧功能回归

- 固定 CA 创建、编辑、热更新和交易回归；
- 动态喊单 CA、关键词和容错匹配回归；
- P19 执行延迟、预算、持仓和离场回归；
- 6551 Watch 合并与 Outbox 回归；
- Engine 启停和管理员认证回归。

### 12.2 账号研究

- KOL 二级页签切换；
- 历史批次、重试和失败状态；
- 研究结果创建草稿但不创建 Watch；
- 动态页面不再出现账号清洗；
- 桌面和手机布局无文本重叠或全页横向溢出。

### 12.3 关注发现

| 场景 | 预期 |
|---|---|
| 首次部署建立 Baseline | 不生成 Signal |
| 关注普通个人账号 | `FOLLOW_ACCOUNT_NOT_PROJECT` |
| 项目账号没有 CA | `FOLLOW_CA_NOT_FOUND` |
| Bio 有唯一完整 CA | GMGN 核验后 resolved |
| 回复区出现 CA | 非官方来源拒绝 |
| 官网和 Bio 冲突 | ambiguous |
| 原盘和重启盘无法区分 | ambiguous |
| 人员账号提及项目账号且项目账号反向提及 | 仅在人员角色、项目身份、CA 和 GMGN 均通过时 resolved |
| 人员账号单向提及普通 KOL | 不建立项目关联，按 CA 规则拒绝 |
| 同一账号取消后重新关注 | 永久去重，不重复买入 |
| 保存新 Revision 时存在旧任务 | 旧任务取消 |
| Provider 429 | 瞬态等待，Engine 不自动停止 |
| Provider `RATE_LIMIT_BANNED` 带 `reset_at` | 按 `reset_at` 等待，禁止冷却期间重复请求 |
| Record 模式 | Swap 调用为 0 |
| Engine 停止 | 不进入真实提交 |

## 13. 实施顺序

### 阶段 1：前端边界调整

1. 在 KOL 页面新增账号研究二级页签；
2. 复用现有 `/api/actor-screening`；
3. 从动态页面移除账号清洗 UI；
4. 在策略中心加入关注发现页签和空状态；
5. 完成正式版字号和响应式回归。

### 阶段 2：Follow Record

1. Migration 036；
2. Follow Policy、event repository 和 API；
3. 6551 Watch demand 合并；
4. Baseline、方向确认和永久去重；
5. 项目身份与 CA Resolver；
6. 只记录，不创建真实交易。

### 阶段 3：Paper

1. 将 resolved Target 接入现有 Signal；
2. 复用现有模板、预算和持仓门禁；
3. 完成歧义、Provider 和 Revision 故障测试；
4. 用真实 Follow 事件验证解析结果。

### 阶段 4：小额 Live

1. 固定 CA 和动态喊单全量回归；
2. 生产数据库只读预检；
3. Record 观察窗口通过；
4. Paper 证据通过；
5. 单账号、单策略、小额 Live；
6. 人工确认后逐步扩大范围。

## 14. 发布与回滚

发布前：

- 以服务器当前生产 commit 为部署基线；
- 停止真实交易并确认 `armed=false`、`desiredRunning=false`；
- 备份 `/opt/xbot`、Nginx 配置和数据库；
- 检查 Git 提交不包含 `.env`、API Key、私钥、Token、日志和生产数据；
- 后端测试、集成测试、Schema audit、前端 lint/build 全部通过。

上线顺序：

1. 部署代码和 Migration 036；
2. 保持 Engine 停止；
3. 回归固定 CA 和动态喊单；
4. 开启账号研究页面；
5. 开启 Follow Record；
6. 验证后再单独批准 Paper 和 Live。

回滚时关闭 Follow Discovery Worker 和入口即可。固定 CA、动态喊单、现有持仓、对账和离场继续由原链路运行。

## 15. 验收标准

P21 完成必须同时满足：

- 账号研究只出现在 KOL 二级页签；
- 动态喊单页面不再夹带账号清洗；
- 方案 A 成为唯一正式信息架构；
- 页面字号严格符合第 5 节标准；
- 新关注发现拥有独立 Policy、Revision、Watch 和事件审计；
- Baseline 不产生 Signal；
- 多候选和证据冲突失败关闭；
- 创始人/CEO/核心成员可通过双向关系发现关联项目，但普通 KOL 不可借此获得授权；
- 关联账号、关系方向、角色类型和 CA 来源全部进入事件审计；
- Grok 不能单独授权 CA；
- Record 不产生 Swap；
- 新策略复用现有交易模板与 P19 执行链路；
- 固定 CA、动态喊单、预算、持仓和离场行为无回归；
- 部署和保存策略不自动启动 Engine；
- GitHub 和发布包不包含隐私凭据。

## 16. 最终链路定义

```text
账号研究 = KOL 下的独立投研工具，只产出研究结果或未启用草稿
动态喊单 = 高权重账号发帖后的 CA、符号和关键词解析
新关注发现 = 高权重账号关注未知账号后的项目身份与唯一 CA 发现
固定 CA = 已知项目和已知 CA 的精确关系策略
P19 = 唯一真实资金执行链路
```

P21 的目标不是重构整个系统，而是在不改变现有正常交易行为的前提下，把账号研究放回正确位置，并补齐“未知新关注账号发现唯一可信 CA”的独立策略能力。

## 17. 实施结果与部署门槛

### 17.1 已完成

- `KOL` 页面增加“账号研究”二级页签，动态喊单页面不再包含账号清洗区域；
- 策略中心增加“新关注发现策略”和独立四步工作区；
- Follow Policy、事件队列、Grok 官方 x_search 研究、候选证据校验、唯一 CA 解析、GMGN 精确验证、物化和运行时授权已接通；
- Record 不创建 Whitelist 或 Signal，Paper 创建 `signal_only` 审计信号，Live 复用 Whitelist Activation 与 P19；
- Follow 生成的 Whitelist 不进入固定 CA 页面，也不参与固定 CA 的唯一约束；
- Whitelist Activation 可以从 Follow Policy 加载 Actor，并复用现有 6551 Watch 同步；
- Profile 官网只读取显式 URL 字段，不再把头像或任意嵌套 URL 当作官网；
- Schema Audit 已增加 Migration 036、P21 表、字段和关键索引检查；
- 设置页增加 `P21_FOLLOW_DISCOVERY_ENABLED` 总开关，默认关闭，只影响 ingestion/监控进程，不启动 Engine；
- 桌面与 390px 移动端已经完成页面渲染和横向溢出检查。

### 17.2 “每个 KOL 一条策略”的准确语义

每个 KOL 只允许存在一份**未归档的当前配置**，并不限制该 KOL 后续产生的 Follow 事件、Target、CA 或交易数量。数据库使用 `WHERE archived_at IS NULL` 的部分唯一索引约束当前配置。

前端“删除”已经改为“停用并归档”：Policy 会切换为 `paused + disabled`，待处理事件会取消，系统生成的 Follow Whitelist 会归档，但历史事件、Signal 和交易审计不会被物理删除。归档后可为同一个 KOL 新建一份当前策略；相同 Actor/Target Follow 行为仍永久去重。

### 17.3 当前验证结果

- 后端完整测试：`401/401` 通过；
- 前端：`npm.cmd run lint` 通过；
- 前端：`npm.cmd run build` 通过；
- `git diff --check` 通过；
- 未启动实盘、未部署服务器、未提交或推送 GitHub。

### 17.4 服务器部署前仍必须完成

1. 在专用测试数据库完整执行 Migration 000-036，并运行 `audit:schema:test`；
2. 停止真实交易，确认 `armed=false`、`desiredRunning=false`；
3. 备份生产代码、Nginx 配置和 PostgreSQL；
4. 对服务器当前 commit、环境配置和本地发布 commit 做差异核对；
5. 部署后先验证固定 CA、动态喊单和持仓/离场回归，再仅开启 Follow Record；
6. Record 观察通过后，分别审批 Paper 和单 KOL 小额 Live，不因部署自动开启 Engine。

### 17.5 P21.1 研究链路修正（2026-08-06）

前一版实现错误地把 6551 的帖子查询当成 Follow Resolver 的主要内容来源，Grok 只做身份分类。这会把 6551 的帖子分页、漏帖和限流问题错误地带入 CA 发现链路；也违背了 P16 已确认的 `grok-4.5 + x_search + citations` 能力边界。

正式职责调整为：

```text
6551 Follow 监听
  -> 稳定 Actor/Target User ID 与 Follow 时间进入事件队列
  -> Grok 官方 Responses API + x_search 检索目标账号、项目账号、人员关系和候选 CA
  -> 本地校验候选 CA 是否出现在 Grok 引用的自有证据摘录中
  -> GMGN 精确验证 chain + CA、可交易状态和官方 Handle/Website 对齐
  -> 唯一候选进入现有 Whitelist / Signal / P19 执行链路
```

P21 不再在 Follow Resolver 中调用 6551 Profile、Tweets、Tweet by ID 或 X 主页补取作为 CA 主路径。6551 的职责仅为实时 Follow 监听、稳定 User ID 和行为去重；Grok 搜索失败或无可验证 CA 时进入等待/拒绝，不降级为猜测地址，也不自动买入。

Grok 研究结果必须包含：目标身份、角色类型、关联项目账号、候选 CA、作者 Handle、Tweet ID 或官网 URL、发布时间、原文证据摘录、evidence_id、citations 和置信度。Grok 返回的地址只能作为候选，系统必须从证据摘录重新提取并与 GMGN 返回地址逐字核对。

安全与速度约束：

1. P21 Follow Research 强制使用官方 `https://api.x.ai/v1/responses`，因为第三方代理不保证 `x_search` 能力；
2. x_search 只用于异步 Follow 研究，不进入 6551 WSS 消费热路径；
3. Worker Lease 必须覆盖 xAI 搜索最长耗时并定期续租，避免搜索期间旧任务被重复认领；
4. 多个有效 `chain + CA`、关系证据不足、引用无法对应原文或发布时间晚于 Follow 事件时，均不交易；
5. 研究失败只影响当前 Follow 事件，不停止固定 CA、动态喊单或全局 Engine。

### 17.6 P21.2 Grok 职责收敛与快速发现（2026-08-06）

Grok 阶段只负责尽快识别目标账号所关联项目的完整 CA，并返回可复核的来源证据。提示词不得包含 GMGN、交易授权、可交易状态或后续执行规则；这些职责属于独立的确定性校验和交易阶段，不能反向限制 Grok 的检索方式。

Grok 官方 Responses API 同时开放 `x_search` 与 `web_search`。模型应优先检查目标账号简介、置顶内容、近期原创、账号链接、关联项目账号和官网；找到唯一且证据充分的完整 CA 后立即返回，仅在目标为人员账号或证据不足时扩大关系检索范围。模型不得为了完成字段而补写不存在的地址；存在多个可信地址或证据冲突时应全部返回，由后续代码拒绝歧义结果。

修正后的职责边界：

```text
6551 Follow 监听
  -> Grok 使用可用搜索工具快速发现 CA 和原始证据
  -> 本地重新提取并核对证据中的完整 CA
  -> GMGN 独立执行链、地址和交易状态验证
  -> 复用现有授权与交易执行链路
```

结构化输出仍保留目标身份、必要的项目关系、候选 CA、作者、URL、Tweet ID、发布时间、原文摘录和 evidence_id。这些字段用于审计和确定性复核，不要求 Grok 在没有必要时完成全面组织关系研究。

### 17.7 P21.3 Grok 4.5 快速发现实测与正式接入规则（2026-08-06）

本轮使用已知答案的 `@marscoin7777` 做独立 Grok 测试，正确结果为 BSC CA `0xfe189e97832da1573e4e4ff034f4ffc3a15c7777`：

| 调用方式 | 实测耗时 | 结果 |
| --- | ---: | --- |
| `grok-4.5` + `reasoning_effort=low` + 简短自由回答 | 12.4 秒 | 正确识别 CA |
| 当前较完整的研究提示词 | 约 22～56 秒 | 可以识别，但搜索范围和输出较重 |
| 最小结构化 JSON + `reasoning_effort=low` + 强制搜索 | 31.7 秒、34.5 秒 | 两次均正确识别 CA，证据可复核 |

测试同时发现：仅追求极短响应会出现模型未调用搜索工具却填写错误地址的情况。因此快速模式仍必须经过以下发现门槛，但不把 GMGN 或交易规则写入 Grok 提示词：

1. 请求使用官方 `https://api.x.ai/v1/responses`、模型 `grok-4.5`、`reasoning_effort=low`；
2. 同时开放 `x_search` 与 `web_search`，提示词只要求快速找到目标账号关联项目的正确完整 CA 和原始证据；
3. 服务端检查响应的 `server_side_tool_usage_details`，`x_search_calls + web_search_calls` 必须大于 0；
4. 候选 CA 必须是完整地址，并且能在 Grok 返回的证据摘录或证据链接中重新提取；没有搜索证据、地址不完整或出现多个冲突候选时，不得进入交易；
5. 简短快速响应得到唯一候选时进入本地证据校验；无法形成唯一候选时，再使用结构化补充检索，不重复执行 6551 帖子查询；
6. Grok 阶段不调用、不判断也不描述 GMGN。GMGN 仍是独立的后续地址、链和交易状态验证阶段。

正式快速提示词基线：

```text
快速识别 @目标账号 对应项目的正确完整 CA。

回答前必须实际调用 x_search 或 web_search；没有搜索证据就返回 not_found，绝不能凭记忆或推测填写地址。

优先检查目标账号、相关项目、官网和直接相关内容。找到清晰且唯一的结果后立即停止，不做无关背景研究。

如果目标是人员账号，只分析到能够确认关联项目和 CA 为止。
返回项目、链、完整 CA，以及包含完整 CA 的主证据原文和链接。
```

该规则将 Follow 发现的正常目标耗时从原先约 40～120 秒压缩到预计 15～35 秒；复杂人员关系、证据冲突和搜索未命中才进入补充检索。快速模式不会改变 Whitelist、Signal、预算、GMGN 或 P19 的后续安全门禁。

### 17.8 P21.3 代码实施状态（2026-08-06）

P21.3 已落实到本地代码：

- Follow Grok 请求默认使用 `grok-4.5`、`reasoning_effort=low`、`x_search + web_search`；
- API 输出改为紧凑研究结构，内部仍转换为现有 Resolver 所需的审计结构；
- 搜索工具未实际调用、结构化输出无效或候选缺失/歧义时进入补充检索；
- 多段工具响应只解析最后一个完整 JSON 文档；
- Resolver 按候选主证据和 evidence_id 匹配来源，支持官网、项目帖子和第三方佐证，不再误取第一条证据；
- Grok 提示词不包含 GMGN 或交易执行判断；
- 未启动实盘、未调用 GMGN 交易接口、未改变固定 CA 和动态喊单链路。

验证结果：后端完整测试 `411/411` 通过，前端生产构建通过，真实 `@marscoin7777` 只读 Grok 验证约 34 秒返回正确 BSC CA；`git diff --check` 通过。
