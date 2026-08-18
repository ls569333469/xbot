# P36 KOL 自定义标签与固定项目工作区定向进入方案

> 文档状态：`IMPLEMENTED / LOCAL VERIFIED / NOT DEPLOYED`
>
> 设计日期：2026-08-18
>
> 基线：P35.1 生产代码 `4f0de6aaab0b715f5f5ce250a9aaf0423562ab9d`，P35 生产验收证据提交 `88ea62b3d39f9c6f14a90aeab390cb18382c1ef1`
>
> 范围：KOL 管理元数据、固定策略前端导航和相关 API；不修改固定 CA、动态喊单、关注策略的信号、授权、预算或 GMGN 交易链路。

## 1. 最终结论

P36 解决两个独立问题：

1. **KOL 缺少自定义标签**：现有 `chain_ids` 是业务使用的生态归属，只允许 `sol / bsc / base / eth / robinhood / cross_chain`，不能兼任用户自定义分类。P36 新增标签字典表和 KOL-标签关联表，不往 `chain_ids` 混入任意字符串。
2. **固定项目工作区丢失所选项目**：策略中心右侧已经选中项目，但“进入工作区”被写死为 `/strategies/fixed`。P36 改为 `/strategies/fixed?whitelistId=<id>`，并让固定工作区直接加载该项目的编辑页。

两项改动的运行边界：

- 新增、修改、移除 KOL 自定义标签不得改变 Engine 状态。
- 纯标签变更不得让 KOL Profile 重新核验，不得写入 6551 Watch Outbox，不得重新激活固定策略。
- 进入项目工作区只执行读请求，不保存策略、不生成 Signal、不调用 GMGN。
- `chain_ids` 继续只表示所属生态，不改变现有固定策略账号筛选和排序语义。

## 2. 代码调查结论

### 2.1 现有“生态标签”是固定业务字段

前端 `KolPage.tsx` 把标签选项写为固定枚举：

```text
SOL / BSC / BASE / ETH / ROBINHOOD / 跨链
```

后端 `domains/kol/service.js` 使用 `KOL_TAGS` 验证 `chain_ids`，任何其他值都返回 `Unsupported ecosystem tag`。前端类型 `EcosystemTag` 也只允许公链与 `cross_chain`。

`chain_ids` 不只是展示字段：

- KOL 列表按生态过滤。
- 固定白名单的账号规则页优先展示当前链账号，再展示跨链账号。
- 策略中心用它展示尚未配置的动态账号所属生态。

因此，把“交易所”、“项目方”、“AI”或“高胜率”写入 `chain_ids` 会混淆业务语义，也会破坏现有筛选逻辑。

### 2.2 KOL API 当前没有标签资源

当前 `/api/kol` 只提供 KOL 列表、创建、更新、开关、Profile 重试、删除和活动查询。KOL 创建与更新只读写 `x_kol_accounts.chain_ids`，数据库没有可复用标签字典或关联表。

还有一个契约细节：`frontend/src/lib/api.ts` 会将所有 `/api/kol/...` 响应当作 `KolAccount` 检查。新增 `/api/kol/labels` 时必须先区分 Label DTO，否则前端会误报 Schema Drift Warning。

### 2.3 固定项目 ID 在策略中心跳转时丢失

当前三类工作区跳转行为不一致：

| 策略 | 详情按钮当前路径 | 是否保留所选对象 |
|---|---|---|
| 动态喊单 | `/strategies/dynamic?kolId=<id>` | 是 |
| 关注策略 | `/strategies/follow-discovery?policyId=<id>` | 是 |
| 固定 CA / 项目 | `/strategies/fixed` | 否 |

`WhitelistPage` 已有成熟的 `api.whitelist.get(id) -> WhitelistWorkspace` 项目编辑链路，但只能从固定工作区列表的铅笔按钮调用。`FixedStrategyWorkspacePage` 不读取 Query Parameter，只渲染整个 `WhitelistPage`。

Git 历史表明：统一策略中心自 P20 建立时，固定项目详情按钮就没有携带 ID；旧白名单列表的项目编辑流程则一直可以打开具体项目。这是统一入口的功能遗漏，不是 GMGN 或后端策略问题。

## 3. 目标与非目标

### 3.1 目标

- 保留固定“所属生态”字段和现有语义。
- 用户可以在添加或编辑 KOL 时搜索、创建、选择和移除自定义标签。
- 标签可被多个 KOL 复用，同一 KOL 可关联多个标签。
- 支持按自定义标签筛选 KOL，并在列表中直接看到标签。
- 从策略中心选中固定项目后，详情按钮直接打开该项目编辑工作区。
- 深链接刷新后仍能打开同一项目。

### 3.2 非目标

- 不允许自定义标签自动改变策略的允许链、金额、权重或优先级。
- 不用自定义标签触发信号或交易。
- 不将标签写入动态策略、关注策略或固定白名单的授权快照。
- 不改变现有 KOL 权重定义。
- 不因为进入固定项目工作区而自动保存或启用策略。

## 4. 数据库设计

P36 新增 Migration：

```text
053_p36_kol_custom_labels.sql
```

### 4.1 标签字典表

```sql
CREATE TABLE x_kol_labels (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  created_by text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (char_length(btrim(name)) BETWEEN 1 AND 24),
  CHECK (char_length(btrim(normalized_name)) BETWEEN 1 AND 24)
);
```

`name` 保留用户看到的大小写和中文；`normalized_name` 用于去重和查找。

### 4.2 KOL-标签关联表

```sql
CREATE TABLE x_kol_account_labels (
  kol_id integer NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  label_id bigint NOT NULL REFERENCES x_kol_labels(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kol_id, label_id)
);

CREATE INDEX idx_x_kol_account_labels_label
  ON x_kol_account_labels(label_id, kol_id);
```

这个模型保证：

- 一个标签只在字典中保存一次。
- 标签改名时不需要更新每个 KOL 行。
- 按标签过滤不需要扫描或拆分文本数组。
- 物理删除 KOL 时关联自动清理；被使用的标签不能被误删。

### 4.3 不回填 `chain_ids`

Migration 053 是可加性 Migration，不修改已有 `x_kol_accounts.chain_ids`，不做任何自动标签推测。所有现有 KOL 初始为零个自定义标签。

## 5. 标签规则

### 5.1 名称规范化

后端统一执行：

1. Unicode `NFKC` 规范化。
2. 去除首尾空白。
3. 连续空白折叠为一个半角空格。
4. `normalized_name` 转小写。
5. 拒绝控制字符、空名称和超过 24 个 Unicode 字符的名称。

`币安`、` 币安 ` 和重复创建的 `币安` 复用同一条标签；`AI` 与 `ai` 也不生成两条记录。

### 5.2 数量与生命周期

- 每个 KOL 最多关联 12 个自定义标签。
- 创建同名标签时返回现有标签，不报错。
- 从 KOL 移除标签只删除关联，不删除全局标签。
- 标签可改名；并发改名仍受 `normalized_name` 唯一约束保护。
- 只有 `account_count=0` 的标签可被删除；正在使用的标签返回 `409 KOL_LABEL_IN_USE`。

## 6. 后端 API 契约

### 6.1 Label DTO

```json
{
  "id": "7",
  "name": "项目方",
  "account_count": 4,
  "created_at": "2026-08-18T00:00:00.000Z",
  "updated_at": "2026-08-18T00:00:00.000Z"
}
```

`normalized_name` 是后端去重细节，不需要由前端保存或回传。

### 6.2 标签资源

```text
GET    /api/kol/labels?search=<text>
POST   /api/kol/labels                 { name }
PATCH  /api/kol/labels/:id             { name }
DELETE /api/kol/labels/:id
```

路由必须在 KOL 动态 ID 路由之前注册，并返回稳定错误码：

- `KOL_LABEL_INVALID`
- `KOL_LABEL_NOT_FOUND`
- `KOL_LABEL_LIMIT_EXCEEDED`
- `KOL_LABEL_IN_USE`

新建和改名使用现有 `x-operator-id`，不接受前端传入 `created_by`。路由层必须将 `KOL_LABEL_IN_USE` 映射为 HTTP 409，其他输入错误映射为 HTTP 400。

### 6.3 KOL DTO 和写入契约

KOL 读取响应新增：

```json
{
  "custom_labels": [
    { "id": "7", "name": "项目方" },
    { "id": "9", "name": "DEX" }
  ]
}
```

KOL 创建和更新请求新增：

```json
{
  "custom_label_ids": ["7", "9"]
}
```

契约规则：

- `custom_label_ids` 缺失：更新时保留现有标签。
- 创建 KOL 时 `custom_label_ids` 缺失：使用空集合。
- `custom_label_ids: []`：明确移除该 KOL 的全部自定义标签。
- 未知 Label ID 使整个 KOL 保存事务回滚。
- 所有 KOL 写入端点返回完整 `custom_labels`，不能出现保存后前端标签短暂消失。

KOL 列表查询保留现有 `tag` 生态过滤参数，新增 `label_id`。不重用 `tag` 表示自定义标签，避免破坏已有链分类。

## 7. 后端事务与查询设计

### 7.1 创建 KOL

当前 `queries.create()` 直接使用全局 DB 连接。P36 需要改为接受 `executor`，使以下动作在一个事务中完成：

```text
BEGIN
  -> 创建或复用 KOL
  -> FOR UPDATE 锁定 KOL
  -> 验证所有 custom_label_ids
  -> 替换 x_kol_account_labels
  -> 读取完整 KOL DTO
COMMIT
```

Profile 仍按现有异步任务核验，标签不参与 6551 Profile 请求。

### 7.2 更新 KOL

现有 `updateKol()` 已有事务和 KOL 行锁。P36 在同一事务内替换标签关联。

必须保持现有边界：

- 只有 `x_handle` 变更才设置 `identity_reset=true`。
- 纯 `display_name / chain_ids / weight / custom_label_ids` 更新不重置 Profile。
- 纯标签更新不调用 `enqueueWatchSyncForHandles()`。
- 纯标签更新不调用 `enqueueWhitelistActivation()`。

如果同一次保存同时改变 `x_handle`，则继续执行原有身份重置和作用域 Watch 同步；标签功能不得禁用这个必要流程。

### 7.3 列表和详情投影

KOL 查询用 `LEFT JOIN LATERAL` 聚合标签 JSON，不直接 JOIN 后返回多行，避免一个 KOL 因多标签在列表中重复。`label_id` 过滤使用 `EXISTS`，命中关联表索引。

## 8. KOL 前端设计

### 8.1 添加/编辑 KOL 弹窗

当前“生态标签”改名为“所属生态”，保留现有固定选项。其下新增“自定义标签”选择器：

- 已选标签显示为可移除 chip。
- 输入框搜索现有标签。
- 无匹配项时显示“新增标签”命令。
- 创建同名标签时自动复用服务器返回的已有 ID。
- 达到 12 个后禁止继续添加，已选标签仍可移除。

选择器使用 Lucide `Tags / Plus / X` 图标，标签 chip 自动换行，不扩张弹窗宽度，并在 `390x844` 视口不产生横向滚动。

### 8.2 KOL 列表

- 现有生态快速筛选保留。
- 增加自定义标签筛选菜单，一次选择一个标签。
- 列表增加“自定义标签”展示，最多显示 3 个，其余显示 `+N`，完整内容放在 tooltip。
- 搜索同时匹配 Handle、显示名称和自定义标签名称。

### 8.3 标签管理

KOL 工具栏增加一个 `Tags` 图标按钮，打开标签管理弹窗：

- 显示标签名称和使用账号数。
- 支持改名。
- 未使用标签可删除。
- 正在使用的标签禁止删除，不提供隐式批量解绑。

这里不新建独立设置页，避免把小型分类工具扩张为另一个管理系统。

## 9. 固定项目工作区深链接

### 9.1 两个入口保持不同语义

- 页面顶部“进入固定策略工作区”：保持 `/strategies/fixed`，进入总列表。
- 已选项目详情区“进入工作区”：改为 `/strategies/fixed?whitelistId=${selectedFixed.id}`，直接打开当前项目。

详情按钮文案可改为“编辑当前项目”，减少与顶部总工作区入口的歧义。

### 9.2 加载流程

```text
StrategyCenterPage
  -> /strategies/fixed?whitelistId=123
  -> FixedStrategyWorkspacePage 读取 whitelistId
  -> WhitelistPage(initialWhitelistId=123)
  -> api.whitelist.get(123) + 并行加载 templates/KOL
  -> WhitelistWorkspace(editing=selectedEntry)
```

必须复用现有 `api.whitelist.get(id)` 和 `WhitelistWorkspace`，不创建第二套项目编辑表单。

### 9.3 异常和 URL 生命周期

- `whitelistId` 不合法或已被删除：显示一次错误通知，清除参数并回到固定列表。
- 直接刷新深链接：仍使用详情 API 打开相同项目，不依赖列表当前页。
- 取消或保存项目：清除 `whitelistId`，回到固定列表，避免刷新后重复打开已结束的编辑会话。
- React Strict Mode 下用已处理 ID 锁防止详情请求重复执行。

## 10. 交易与运行隔离

### 10.1 不进入交易契约

P36 自定义标签不得出现在：

- `dynamic_policy_context_hash`
- `follow_discovery_context_hash`
- `asset_snapshot`
- `authorization_snapshot`
- Engine scope / manifest hash
- GMGN request context

标签只属于 KOL 管理元数据。

### 10.2 不增加 GMGN 请求

- 标签 CRUD 只读写 PostgreSQL。
- 固定项目深链接本身只读取已有白名单详情、模板和 KOL 列表，不新增 GMGN 调用代码。
- 现有 `WhitelistWorkspace` 在打开一个 CA 后会自动调用研究域补全代币资料；缓存未命中时可能产生一次低优先级 GMGN `token_info` 读取。旧列表铅笔入口也有相同行为，这不是 P36 新增调用，但验收审计必须单独列出，不能误记为标签或导航调用。
- 标签 CRUD 的 GMGN 请求和 429 增量必须均为 `0`；固定项目打开操作应区分“P36 导航请求”和“旧工作区元数据补全请求”，且不得出现 Swap。

### 10.3 不停止全局 Engine

代码发布本身按 P29 B 类流程进入一次受控维护窗口；发布完成后，任何日常的标签创建、关联、改名、解绑与固定项目打开动作都不得：

- 调用 `/api/system/disarm`。
- 重启 Supervisor、ingestion 或 execution。
- 改变 `armed / desiredRunning / status`。
- 让无关策略转为 paused。

## 11. 预计修改文件

### 11.1 后端

1. `backend/db/migrations/053_p36_kol_custom_labels.sql`
2. `backend/domains/kol/label-service.js`
3. `backend/domains/kol/queries.js`
4. `backend/domains/kol/service.js`
5. `backend/domains/kol/routes.js`
6. `backend/scripts/audit-db-schema.js`
7. `backend/tests/kol-service.test.js`
8. `backend/tests/p36-kol-labels-and-fixed-deeplink.test.js`

### 11.2 前端

1. `frontend/src/lib/types.ts`
2. `frontend/src/lib/api.ts`
3. `frontend/src/pages/KolPage.tsx`
4. `frontend/src/pages/kol/KolLabelPicker.tsx`
5. `frontend/src/pages/kol/KolLabelManager.tsx`
6. `frontend/src/pages/StrategyCenterPage.tsx`
7. `frontend/src/pages/strategy/FixedStrategyWorkspacePage.tsx`
8. `frontend/src/pages/WhitelistPage.tsx`
9. `frontend/src/index.css`

### 11.3 文档

1. `docs/00_系统架构与全局设计/P36_kol_custom_labels_and_fixed_workspace_deeplink_plan.md`

实施时不修改 GMGN、Signal、Trade Intent、Position、平仓、动态解析或关注解析文件。如果出现这些无关差异，必须停止并重新评估范围。

## 12. 测试矩阵

### 12.1 标签纯函数与服务

- 中文、英文和数字标签正常。
- 首尾空格、全半角差异、连续空格和大小写正确去重。
- 空标签、控制字符和超长标签被拒绝。
- 同一 KOL 重复 Label ID 去重。
- 第 13 个标签被拒绝。
- 未知 Label ID 让 KOL 保存完整回滚。
- 标签改名后所有 KOL 读取到新名称。
- 正在使用的标签不能删除。

### 12.2 KOL 兼容回归

- 原有 `chain_ids` 枚举验证不放宽。
- 旧 KOL 请求不传 `custom_label_ids` 仍可正常创建和更新。
- 纯标签更新保留 `x_user_id` 和 `profile_status=verified`。
- 纯标签更新不产生 Watch Outbox 或 Whitelist Activation Outbox 新记录。
- KOL 开关、Profile 重试和物理/逻辑删除返回的 DTO 不丢失 `custom_labels`。
- 按生态与按自定义标签过滤可独立使用。
- 多标签 KOL 在列表中只出现一次。

### 12.3 固定项目深链接

- 顶部总入口仍为 `/strategies/fixed`。
- 选中 MARSCOIN 后详情按钮携带它的 `whitelistId`。
- 深链接跳转后直接显示 MARSCOIN 编辑内容，不显示无关项目列表作为第一屏。
- 直接刷新 URL 仍打开 MARSCOIN。
- 目标不在白名单列表第一页时仍可打开。
- 无效或已删除 ID 只提示一次并回退总列表。
- React Strict Mode 下详情 API 只执行一次有效加载。
- 取消、保存与浏览器后退行为一致。

### 12.4 Migration 与前端

- Migration 053 在空库、P35 快照库和生产备份恢复库通过。
- Migration 二次执行零变更，Schema Audit 覆盖两张表、约束、外键和索引。
- 后端全量与集成测试通过。
- 前端 `lint` 、TypeScript 和 Vite production build 通过。
- KOL 弹窗在桌面和 `390x844` 视口没有溢出、重叠或文本裁切。
- 标签长名称、12 个已选标签和 `+N` 列表状态完成 DOM 回归。

### 12.5 生产运行验收

- 记录标签操作前 Engine、Watch Outbox、Whitelist Activation Outbox、GMGN request 和 429 基线。
- 在一个已核验 KOL 上新增、筛选并移除测试标签。
- Engine 全程保持 `running / armed / desiredRunning=true`。
- KOL Profile 保持 `verified`，Watch/Activation Outbox 增量为 `0`。
- 在策略中心选中一个非列表第一项的固定项目，直接进入该项目并正确返回。
- 标签操作的 GMGN request 和 429 增量均为 `0`。
- 固定项目打开若命中旧工作区元数据补全，单独记录低优先级 `token_info`；不得出现 Swap 或交易域请求，且不得出现 429。

P36 不修改交易执行代码，生产验收不要求再做一笔真实 GMGN Swap；以 P35.1 已完成的三策略实盘基线和 P36 的零 GMGN 增量证据为准。

## 13. 实施顺序与提交边界

### 13.1 提交一：固定项目深链接

1. 修改策略中心项目详情按钮。
2. 固定工作区读取 `whitelistId`。
3. `WhitelistPage` 复用现有编辑加载函数。
4. 补齐深链接、刷新、无效 ID 和取消/保存测试。

建议提交：

```text
fix: deep-link selected fixed strategy workspace
```

### 13.2 提交二：KOL 自定义标签

1. Migration 053 和 Schema Audit。
2. Label Service、KOL 投影与事务内关联写入。
3. API 契约与前端 Schema Drift 分流。
4. Label Picker、Label Manager、KOL 列表展示与筛选。
5. 标签、KOL 兼容、Migration、DOM 和零副作用测试。

建议提交：

```text
feat: add reusable KOL custom labels
```

两个提交合并为一个 P36 Release，但必须可独立审查和回退。不捎带格式化其他页面或重构交易域。

## 14. GitHub 与 xiexiu 部署

P36 同时修改 Migration、API 契约和前端，按 P29 **B 类完整应用发布**执行：

1. 从当前 verified baseline 创建 `codex/p36-kol-labels-fixed-deeplink`。
2. 完成两个独立代码提交和一个文档/验收提交。
3. 执行后端全量、集成、Migration 演练、Schema Audit、前端 lint/build、DOM 回归和 Release/Secret Audit。
4. 推送分支并核对 40 位 Release SHA。
5. 经独立批准后创建不可变 P36 production tag。
6. xiexiu 只读预检，核对在途资金状态、Watch、Engine、GMGN/429 基线。
7. 正式 Disarm，数据库备份和隔离恢复验证。
8. 干净安装、前端生产构建、Migration 053、二次零变更和生产 Schema Audit。
9. 原子切换 Supervisor，核对 ingestion/execution 角色唯一、`NRestarts=0`、WSS subscribed、Readiness 无新 blocker。
10. 在用户批准后恢复 Engine，完成第 12.5 节的零交易写入生产验收。

代码发布需要一次维护窗口，但发布后用户日常新增 KOL、编辑标签或打开固定项目必须属于 P29 C 类业务配置操作，不得再次重启或停止生产。

## 15. 回滚策略

- 深链接回滚：回到 `/strategies/fixed` 总列表路由，不影响白名单数据。
- 标签代码回滚：旧代码忽略新表和 DTO 字段，`chain_ids` 与交易表不受影响。
- 生产紧急回滚时不在事故窗口直接 DROP 标签表；保留加性 Schema，回退应用目录并停止新标签写入。
- 需要完整 Schema 回退时，使用部署前备份在受控维护窗口恢复，不手工删除生产数据。

## 16. 最终验收标准

P36 只有同时满足以下条件才能标记完成：

1. “所属生态”和“自定义标签”在数据模型、API 和前端中完全分离。
2. 自定义标签支持创建、复用、关联、解绑、改名、未使用删除和列表筛选。
3. 纯标签操作不重置 Profile，不写 Watch/Activation Outbox，不停止 Engine。
4. 选中固定项目后的详情按钮直接打开该项目，深链接刷新仍正确。
5. 顶部总工作区入口、固定列表编辑和旧 `/whitelist` 兼容入口无回归。
6. 后端全量、集成、Migration、Schema Audit、前端构建和 DOM 回归全部通过。
7. xiexiu 运行验收中 Engine 保持正常；标签操作 GMGN request 和 429 增量均为 `0`，固定项目打开仅允许审计到旧工作区既有的低优先级元数据补全，不允许出现 Swap 或 429。

P36 在上述条件全部通过前，不修改 P35.1 production tag，不部署 xiexiu。

## 17. 本地实施与验收结果

实施日期：2026-08-18。

### 17.1 已完成内容

- 新增 Migration 053、`x_kol_labels` 和 `x_kol_account_labels`。
- 新增标签列表、创建、改名和未使用删除 API。
- KOL DTO、创建、更新、开关和 Profile 重试响应统一携带 `custom_labels`。
- KOL 标签关联与 KOL 保存处于同一事务；未知标签 ID 整体回滚。
- KOL 页面完成“所属生态”与“自定义标签”分离，支持标签选择、创建、筛选、改名和删除保护。
- 删除当前筛选标签（包括最后一个标签）后，筛选自动复位为“全部自定义标签”，不会留下无效筛选状态。
- 策略中心固定项目详情入口携带 `whitelistId`，直接复用原 `WhitelistWorkspace`；刷新、取消和无效 ID 回退均已处理。

### 17.2 自动验证证据

- P36 与 KOL 定向单测：`14/14` 通过。
- 后端全量单测：`645/645` 通过。
- 后端全部数据库集成测试：`39/39` 通过。
- 全量集成回归使用未被运行中后端占用的独立测试库，避免后台 retry worker 与测试 worker 竞争测试记录。
- P36 PostgreSQL 集成测试验证 Profile 保持、事务回滚、多标签不重复及 Watch/Activation Outbox 零增量。
- Migration 053 在独立 `xbot_p36_test` 空库基线上成功应用；二次执行 `applied=[]`。
- Schema Audit：`SCHEMA_AUDIT_OK=xbot_p36_test;MODE=test`。
- 前端 `npm run lint` 和 `npm run build` 通过。

### 17.3 浏览器回归证据

- 桌面端 KOL 列表正确区分所属生态和自定义标签。
- `390x844` 下 KOL 编辑弹窗、标签选择器和标签管理弹窗无横向溢出，`document.scrollWidth=390`。
- 使用中的标签删除按钮为禁用状态。
- 标签 HTTP 创建、改名和删除闭环通过。
- `/strategies/fixed?whitelistId=143` 直接打开所选项目；刷新保持项目，取消后清除参数。
- 非法 `whitelistId` 只显示一次错误并返回固定列表。
- 浏览器 Console 无 error 或 warning。

### 17.4 GMGN 与本地基线说明

- 标签 CRUD 未产生 GMGN 请求，也未产生 429。
- 打开测试白名单时记录到一次 `source=research / stage=token_info`，来源是 P16 以来 `WhitelistWorkspace` 的既有自动元数据补全；没有 Swap、Quote 或交易调用，也没有 429。
- 本地 `xbot` 数据库尚未应用 Migration 053，因为 Migration Runner 先发现已应用的 052 校验和与当前仓库文件不一致：数据库前缀 `919f8f334683`，仓库前缀 `8535fff242f5`。本轮没有绕过校验或修改生产式本地库，功能和 Migration 验收均使用独立 `xbot_p36_test`。
- 尚未提交、推送、创建 production tag 或部署 xiexiu；服务器验收仍需后续单独批准。
