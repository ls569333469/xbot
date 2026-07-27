# P16.1 未发币项目监控与固定 CA 触发纠偏方案

> 编制日期：2026-07-26
> 状态：代码、Migration 与本地验收已完成；待首条真实未发币项目事件验收
> 目标：把“先有 CA 的白名单交易”与“先监控项目账号、后发现新 CA”拆成两条独立链路
> 边界：不修改已有仓位、订单、Trade Attempt、Receipt 或资金账本；不自动启用由历史错误规则推导出的首发监控

## 1. 审计结论

P16 的 Project Direct Source 存在业务方向错误：

```text
当前错误链路
固定 CA -> 项目账号 -> 项目账号再次发布该固定 CA -> 买入固定 CA
```

`x_signal_source_rules.whitelist_id` 强制绑定 `ca_whitelist`，Matcher 也只在事件中的完整 CA 等于该白名单 CA 时匹配。因此它只能表达“已知 CA 再确认”，不能表达未发币项目首发。

正确模型必须拆为：

```text
未发币项目监控
链 + 项目账号 + 可选生态互动 + 资金/离场模板
  -> 6551 事件首次出现唯一有效 CA
  -> 原子创建或复用具体 CA 白名单
  -> 生成一个可审计 Signal
  -> 首发监控自动进入已触发状态

已知 CA 白名单
链 + CA + 项目身份 + 生态账号行为
  -> 生态账号发布该 CA，或与项目账号互动
  -> 买入预先确认的固定 CA
```

## 2. 产品结构

白名单页使用两个平级视图：

1. `已知 CA`：保留 CA 自动补全、快速投研、模板、离场策略和生态账号配置。
2. `未发币监控`：不填写 CA；配置链、项目名称、项目账号、可选生态互动、资金与离场策略。

固定 CA 创建页不再提供“项目账号自己的 CA 动态”。项目账号只作为项目身份和生态互动目标；生态账号可以：

- 自己发布当前固定 CA；
- 回复、引用或转发项目账号，触发当前固定 CA。

未发币监控中：

- 项目账号发布、回复、引用或转发时，事件必须包含完整 CA 才能触发；
- 生态账号回复、引用或转发项目账号时，事件必须包含完整 CA 才能触发；
- 没有 CA 的关注或普通互动只保留在 Activity 中，不产生交易 Signal；
- 默认只接受第一个唯一有效 CA，成功发现后自动暂停该监控。

## 3. 数据模型

Migration 020 新增：

### 3.1 `project_launch_rules`

保存无 CA 的首发配置：链、项目名称、单笔金额、累计预算、滑点、重复买入设置、离场策略、状态、触发次数和过期时间。

状态：

- `active`：正在等待新 CA；
- `paused`：用户暂停；
- `triggered`：已发现首个 CA；
- `expired`：已过期。

### 3.2 `project_launch_sources`

保存项目官方、Founder、CEO 等首发来源账号及独立事件类型。一个规则至少需要一个项目来源账号。

### 3.3 `project_launch_relations`

保存生态 Actor -> 项目账号关系。只允许 `retweet/quote/reply`；事件没有完整 CA 时不交易。

### 3.4 `project_launch_discoveries`

保存首发发现审计：Rule、Activity、链、CA、生成/复用的白名单、Signal、触发类型和账号。

约束：每条被消费的 Launch Rule 保留一条 Discovery 审计；同链同 CA 全局只新建或复用一个具体白名单和一条 Signal，防止重复买入。

### 3.5 生成白名单

首发事件命中后，在同一数据库事务内：

1. 锁定 `chain + CA` 与 Launch Rule；
2. 校验 Rule 仍为 `active` 且未过期；
3. 拒绝没有 CA 或含多个有效 CA 的事件；
4. 创建或复用同链同 CA 的 Active 白名单；
5. 新建白名单时复制资金和离场策略快照；
6. 保存项目身份与生态关系；
7. 创建仅用于本次首发审计的 `source_kind=launch` Source Rule；普通 Matcher 不再次消费该 Rule；
8. 创建或复用唯一 Signal，并为当前 Rule 保存 Discovery；
9. 将 Launch Rule 改为 `triggered`。

## 4. 触发和去重

### 4.1 项目来源

```text
Actor 是 Launch Source
AND 事件类型已启用
AND 事件恰好包含一个符合所选链格式的 CA
```

### 4.2 生态互动

```text
Actor 是 Launch Relation 的生态账号
AND Target 是配置的项目账号
AND 事件类型已启用
AND 事件恰好包含一个符合所选链格式的 CA
```

### 4.3 去重

- 同一 6551 Tweet 重放：沿用 Provider Inbox 和 Signal canonical key 去重；
- 同一 Rule 的多个项目账号发布同一 CA：Discovery 唯一约束去重；
- 不同 Rule 发布同链同 CA：每条 Rule 保留 Discovery，但全局复用同一白名单和 Signal；
- 同一事件同时命中已有固定 CA 规则和 Launch Rule：复用已有 Signal，只消费 Launch Rule，不创建第二笔；
- 一条事件含多个有效 CA：失败关闭，只记录 Activity，不猜测买哪个。

## 5. Watch 规则

6551 Desired Watch 由以下来源取并集：

- Active 固定 CA 生态 Source；
- Active 固定 CA 生态 Interaction Actor；
- Active 未发币项目 Source；
- Active 未发币生态 Interaction Actor。

同一账号始终只有一个远端 Watch，事件 Flags 取并集。Launch Rule 触发、暂停或删除后通过现有 Outbox 重新计算；Migration 本身不写远端 Watch。

## 6. 历史纠偏

Migration 020 对历史 `source_kind=project`：

1. 保留 `whitelist_x_accounts` 项目身份和证据；
2. 将固定 CA Project Source Rule 设为 disabled；
3. 不删除历史 Signal、订单、仓位或交易证据；
4. 不自动创建 Active Launch Rule，避免升级后突然监听并买入未来新 CA；
5. 生态 Source 与 Interaction Relation 保持不变。

## 7. 安全边界

- EVM 地址格式不能识别具体链，用户创建 Launch Rule 时必须先选链；
- 首发路径不依赖 Symbol 或项目名称，GMGN Metadata 只能异步补全，不阻塞 Signal；
- Launch Rule 必须使用当前链模板中的资金、滑点和离场策略快照；
- 首发发现不绕过 Engine、Live Policy、Chain Readiness、预算、Wallet Lane、重试和对账；
- `source_kind=launch` 不参与后续普通事件匹配，只允许对应 Discovery 的首个 Signal；
- 未配置项目来源账号、事件无 CA、多个 CA、地址无效、Rule 非 Active 时均不交易。

## 8. 实施清单

- [x] Migration 020 与 init schema。
- [x] Launch Monitor CRUD、校验、Watch Impact 和状态切换。
- [x] 6551 Launch Matcher、原子发现、白名单物化和唯一 Signal。
- [x] Live Policy 与 Desired Watch 支持 Launch 审计来源。
- [x] 固定 CA 后端拒绝新增 Project Direct Source，保留生态 Source。
- [x] 白名单页新增 `已知 CA / 未发币监控` 两个视图。
- [x] 固定 CA 工作区删除项目 Direct Source，项目账号只作为身份/互动目标。
- [x] 未发币工作区支持项目多账号、可选生态互动、模板、策略和 Watch 影响。
- [x] 单元、集成、Migration、lint/build、桌面和移动端 DOM 验收。

## 9. 验收标准

1. 未填写 CA 可以保存 Active Launch Rule，但至少有一个项目账号。
2. 项目账号发布唯一有效 CA 时，只生成一个具体白名单和一个 Signal；每条被消费的 Rule 各保留一条 Discovery 审计。
3. 生态账号对项目账号的互动只有携带唯一 CA 才能触发。
4. 无 CA、多 CA、错误链格式、重复事件和重复账号均不会产生第二笔 Signal。
5. Launch Rule 触发后自动变为 `triggered`，不会继续发现第二个 CA。
6. 已知 CA 页面不再出现项目账号直接触发；生态 Source/Interaction 继续正常。
7. 历史 Project Direct Source 被停用但身份、Signal 和交易记录不丢失。
8. Migration 不改写 Position、Order、Trade Attempt、Receipt 或 Watch Outbox。

## 10. 实施与验收结果

2026-07-26 已完成：

- 正式本地数据库在 Engine 停止状态下应用 Migration 020；历史 Project Direct Source 共 16 条被停用并保留项目身份，没有创建 Launch Rule、Signal、订单或远端 Watch 写入；
- 后端单元测试 `213/213`，独立 `xbot_test` 数据库从 Migration 000 安装至 020 后集成测试 `27/27`；
- 前端 `oxlint`、TypeScript 与 production build 通过；
- 桌面和 `390x844` DOM 验收覆盖双入口、未发币空列表、三步工作区、无 CA 输入、项目来源/可选生态互动分区，以及固定 CA 无项目直接触发；移动端无横向溢出；
- 对旧数据或热更新状态缺少 `event_types` 的情况增加前端归一化与渲染保护；
- 修复研究候选无法独立移除、生态账号建议框无法可靠关闭，以及 Grok 角色/关联备注在白名单草稿中丢失的问题；候选选择与候选删除现在是两个独立动作；
- 验收过程只使用未保存的本地草稿账号 `@p161_preview`，没有保存真实未发币监控、同步 6551 Watch、启动 Engine 或发起交易。

唯一剩余产品验收：用户创建一条真实未发币监控后，用一条包含唯一有效 CA 的真实项目事件验证 `Activity -> Discovery -> 白名单 -> Signal -> 交易门禁`；该步骤涉及真实 Watch 和可能的实盘买入，必须由用户明确选择账号、链、模板和金额后执行。
