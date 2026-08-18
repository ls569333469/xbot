# P36.1 统一横向 KOL 分类选择方案

> 文档状态：`IMPLEMENTED / LOCAL VERIFIED / NOT DEPLOYED`
>
> 设计日期：2026-08-18
>
> 基线：P36 KOL 自定义标签与固定项目工作区深链接
>
> 范围：KOL 列表和固定 CA 策略中的账号分类选择；不修改交易、Signal、Watch、Engine 或 GMGN 链路。

## 1. 修订原因

P36 将“所属生态”和“自定义标签”设计成两个独立筛选条件。数据模型是正确的，但前端同时保留两个激活状态后，用户会遇到以下问题：

```text
所属生态 = BSC
自定义标签 = Uniswap
结果 = BSC 与 Uniswap 的交集
```

用户只是希望查看 BSC 账号，却必须先理解并清除另一个筛选条件。两个条件没有交集时，页面显示空结果，容易误判为 BSC 分类没有账号。

P36.1 不改变后端数据分层，只统一前端分类入口并取消交集筛选。

## 2. 最终产品结论

KOL 页面和固定 CA 策略账号选择器统一使用一条横向“**KOL 分类**”：

```text
KOL 分类
[全部] [SOL] [BSC] [BASE] [ETH] [ROBINHOOD] [跨链] [未分类]
[Uniswap] [币安] [测试账号] [项目官方] [更多]
```

规则如下：

1. 所属生态和自定义标签并列显示。
2. 一次只能激活一个分类，不存在生态与标签交集。
3. 点击 `BSC`，立即显示全部 BSC 账号。
4. 点击 `Uniswap`，立即显示全部带有 Uniswap 标签的账号。
5. 搜索只在当前分类结果内继续缩小范围。
6. 切换分类不清除已经勾选的账号。
7. 固定 CA 策略继续保存现有规范化 Handle 和关系，不新增账号 ID 字段，也不保存“分类引用”。

## 3. 数据模型保持分离

统一展示不等于混用字段：

| 类型 | 数据来源 | 业务含义 |
|---|---|---|
| 所属生态 | `x_kol_accounts.chain_ids` | 公链或跨链归属 |
| 自定义标签 | `x_kol_labels` + `x_kol_account_labels` | 用户维护的账号分类 |

一个账号可以同时具有：

- 一个或多个有效生态归属。
- 最多 12 个自定义标签。

例如：

```text
@TrustWallet
所属生态：BSC
自定义标签：币安、钱包、项目官方
```

选择 `BSC`、`币安`、`钱包` 或 `项目官方` 时都可以看到该账号，但每次只按其中一个分类浏览。

## 4. 标签同名保护

### 4.1 全局唯一

自定义标签继续使用 `normalized_name` 唯一约束：

- Unicode `NFKC` 规范化。
- 去除首尾空白。
- 连续空白折叠。
- 英文转小写后比较。

`AI`、`ai` 和 ` AI ` 只能存在一个。

### 4.2 生态保留名称

自定义标签不得使用以下保留名称或其规范化变体：

```text
全部
SOL
BSC
BASE
ETH
ROBINHOOD
CROSS_CHAIN
跨链
未分类
```

后端创建和改名统一返回：

```text
HTTP 400
code = KOL_LABEL_RESERVED_NAME
```

前端在提交前提示，但后端校验是最终约束。不能只依赖前端阻止同名。

## 5. 统一分类 DTO

前端将两种数据投影为同一个只读分类模型：

```ts
type KolCategory =
  | { kind: 'all'; key: 'all'; name: '全部'; accountCount?: number }
  | { kind: 'ecosystem'; key: string; name: string; accountCount?: number }
  | { kind: 'custom'; key: string; name: string; accountCount?: number };
```

`key` 必须带类型前缀，防止前端状态碰撞：

```text
all
ecosystem:bsc
custom:7
```

界面只保存一个 `activeCategoryKey`，从状态结构上消除双条件同时生效的可能。

## 6. KOL 页面设计

### 6.1 横向分类栏

- 固定顺序沿用现有生态顺序：全部、SOL、BSC、BASE、ETH、ROBINHOOD、跨链、未分类、自定义标签、更多。
- 分类名称必须显示；账号数是可选展示，不为显示数字新增高频查询。
- 当前分类只有一个激活态。
- 生态分类始终可见；自定义标签最多直接显示 8 个，其他标签进入可搜索的“更多”菜单。
- 当前激活的自定义标签即使不在前 8 个，也必须提升到横向栏中显示。
- 桌面端允许换行，移动端横向滚动并隐藏滚动条。

KOL 页面当前使用服务端筛选，正式实现不额外拉取全量 KOL 只为计算生态数量；首版可以省略分类数字。固定 CA 工作区已经加载完整 KOL DTO，可直接对启用账号在本地计算数字。两处允许是否显示数字不同，但选择语义必须相同。

### 6.2 搜索和列表

- 搜索继续匹配 Handle、显示名称和所有自定义标签；生态浏览由横向分类栏负责，不为 P36.1 扩大后端列表查询语义。
- 搜索不会改变当前分类。
- 列表分别展示“所属生态”和“自定义标签”，保持数据含义清楚。
- 一个账号有多个标签时最多展示 3 个，其余显示 `+N`。

### 6.3 标签管理

新增、改名、删除仍从独立的标签管理入口完成。分类栏只负责筛选，不在分类栏中直接创建标签。

## 7. 固定 CA 策略设计

### 7.1 使用位置

“生态账号发布完整 CA”和“生态账号与项目账号互动”两条规则复用同一 `KolCategoryBar` 和账号选择器。

### 7.2 选择流程

```text
进入新增固定 CA
  -> 步骤 2 配置 X 账号
  -> 打开按分类选择 KOL
  -> 单选一个分类
  -> 勾选单个账号或全选当前结果，立即写入当前策略草稿
  -> 切换其他分类继续追加账号
  -> 点击完成只关闭选择区
  -> 生成明确账号名单和关系矩阵
```

分类切换只改变当前可见结果：

- 已勾选账号保留在 `selectedHandles`。
- 同一账号通过多个分类重复命中时按规范化 Handle 去重。
- “全选当前结果”只作用于当前分类和当前搜索结果。
- “清空”才会移除全部已选账号。
- 保留现有 `onSelectedHandlesChange` 即时更新语义，不新增第二套暂存/提交状态。
- `Esc`、点击关闭和“完成”都只关闭选择器，不撤销已经勾选的草稿账号。

### 7.3 保存语义

分类是选择工具，不是运行时授权条件。保存策略时继续写入：

- `direct_source_actor_handles`
- `relation_actor_handles`
- 明确的 `actor -> target -> CA` 关系

后续给标签新增或移除账号，不得静默改变已运行策略。需要更新策略时，用户重新进入工作区选择并保存。

## 8. 前端复用边界

新增共享组件：

```text
frontend/src/pages/kol/KolCategoryBar.tsx
```

组件输入：

- KOL 账号集合或分类统计。
- 当前分类 Key。
- 分类变化回调。
- 是否显示账号数。

组件不持有策略表单、不调用交易 API。`KolPage` 与 `AccountRulesStep` 使用同一分类 Key 和选择逻辑，避免两处语义再次分叉。样式全部限定在 `.kol-category-bar` 命名空间内，不修改通用 `.btn`、`.input`、`.segments` 或其他策略页面的全局规则。

KOL 页面把现有 `tag` 和 `labelId` 两个状态替换为单一 `activeCategoryKey`。发起列表请求时只映射出一个分类参数，并增加请求序号或 `AbortController`；较早请求晚返回时不得覆盖用户最后选择的分类结果。现有 200ms 搜索防抖和 5 秒 Profile 轮询继续保留。

## 9. 后端和 API 调整

### 9.1 必须调整

- 标签创建和改名增加生态保留名称校验。
- 新增稳定错误码 `KOL_LABEL_RESERVED_NAME`。

### 9.2 不需要调整

- 不合并数据库表。
- 不把自定义标签写入 `chain_ids`。
- 不修改 KOL 与标签多对多关系。
- 不修改固定 CA 策略授权快照。
- 不增加 GMGN 请求。
- 不删除后端同时接受 `tag + label_id` 的兼容能力；只保证新前端不会同时发送两者。

KOL 页面服务端查询可继续映射：

```text
ecosystem:* -> 现有 tag 参数
custom:*    -> 现有 label_id 参数
all         -> 不传分类参数
```

固定 CA 工作区已经加载 KOL DTO，可在前端按 `chain_ids/custom_labels` 筛选，不需要为每次点击增加请求。

策略选择器只统计和展示 `enabled !== false` 的账号，保持现有 `AccountPicker` 边界；KOL 管理页仍可查看禁用账号。不能因为统一分类而让禁用账号重新进入策略候选。

固定策略候选账号继续使用现有 `sortAccounts(accounts, chainId)` 排序；分类栏只过滤可见集合，不改变当前策略链优先的排序语义。

## 10. 测试矩阵

### 10.1 分类行为

- 点击 BSC 后只存在 `ecosystem:bsc` 一个激活分类。
- BSC 有账号时立即显示，不受先前自定义标签影响。
- 点击 Uniswap 后只存在 `custom:<id>` 一个激活分类。
- 点击全部恢复完整列表。
- 搜索只缩小当前分类结果。
- 模拟 BSC 请求延迟返回、Uniswap 请求先返回时，最终页面仍必须保留 Uniswap 结果。
- 删除或改名当前激活标签时按稳定 Label ID 更新；标签不存在时回到全部。

### 10.2 多标签和选择保留

- 同一账号可以显示多个自定义标签。
- 同一账号通过不同分类重复命中时不重复加入。
- 从 BSC 选中账号，再切换 Uniswap，BSC 已选账号仍保留。
- 全选当前结果不影响其他分类中已选账号。
- 清空后已选账号和关系预览同时归零。
- 关闭选择器后重新打开，已选账号保持不变。
- 禁用 KOL 不进入固定策略候选或分类数量。

### 10.3 名称保护

- 创建 `BSC`、`bsc`、` BSC ` 均返回 `KOL_LABEL_RESERVED_NAME`。
- 改名为生态保留名称同样被拒绝。
- 普通标签仍按规范化名称复用。
- 已存在的同名历史标签不会在运行时自动删除、改名或解绑。

### 10.4 安全回归

- 分类和标签操作不改变 Engine 状态。
- 不写 6551 Watch Outbox 或 Whitelist Activation Outbox。
- 不产生 GMGN 请求或 429。
- 保存固定策略仍走原有 Outbox、授权账本和交易门禁。
- 原有 `GET /api/kol?tag=...&label_id=...` 组合查询继续通过兼容测试。
- 分类点击、搜索、更多菜单和关闭选择器不得调用策略保存、Arm、Watch 或交易 API。
- 桌面与 `390x844` 无横向页面溢出、遮挡或文本裁切。

## 11. 实施范围

预计正式实现仅修改：

```text
backend/domains/kol/label-service.js
backend/tests/kol-service.test.js
backend/tests/p36-kol-labels.integration.js
backend/tests/p36-1-unified-kol-category.test.js
frontend/src/pages/kol/KolCategoryBar.tsx
frontend/src/pages/kol/kol-category.ts
frontend/src/pages/KolPage.tsx
frontend/src/pages/whitelist/AccountRulesStep.tsx
frontend/src/index.css
相关 P36.1 前端 DOM、请求竞态与策略 Payload 回归测试
```

不得修改 GMGN、Signal、Trade Intent、Position、动态喊单、关注策略解析或生产运行开关。不得改写 `replaceEcosystemSources`、`replaceRelationMatrix`、Watch 影响计算或白名单保存 Payload；统一分类只替换候选账号的过滤和展示。

## 12. 安全复核与实施顺序

### 12.1 发布前数据审计

P36.1 不新增 Migration，也不增加数据库约束。部署前先查询是否已经存在与生态保留名称冲突的自定义标签：

```sql
SELECT id, name, normalized_name
FROM x_kol_labels
WHERE normalized_name = ANY(ARRAY[
  '全部', 'sol', 'bsc', 'base', 'eth', 'robinhood',
  'cross_chain', '跨链', '未分类'
]);
```

如果返回记录，部署必须暂停；由用户确认新的标签名称后通过正常标签改名接口处理。禁止 Migration 自动重命名、删除标签或批量解绑账号。

同时确认 P36 Migration 053 已应用且 Schema Audit 通过。P36.1 自身不得绕过历史 Migration 校验。

### 12.2 两个独立提交

1. 后端提交：只增加保留名称校验、错误码和单元/集成测试。
2. 前端提交：增加共享分类栏，接入 KOL 页面和 `AccountPicker`，补齐请求竞态与 Payload 回归。

后端提交可以独立部署和回滚；前端提交回滚后仍使用原 `tag/label_id` API。两者都不需要数据回填。

### 12.3 必须保持的正式行为

- KOL 创建/编辑中的“所属生态”和“自定义标签”多选编辑器保持分开，因为这里是在修改账号元数据，不是筛选账号。
- KOL 列表和固定策略账号选择才使用统一横向分类栏。
- 固定策略勾选账号继续即时更新草稿，不引入新的确认事务。
- 账号自关联继续由现有关系矩阵逻辑排除。
- 只读分类操作不写 Outbox，不改变 Engine，不调用 6551 或 GMGN。

### 12.4 回归与回滚门槛

- 后端全量测试、P36 PostgreSQL 集成测试、前端 lint/build 和 DOM 回归全部通过。
- 对同一组选中账号，更新前后的固定策略保存 Payload 必须完全一致。
- 浏览器验证 KOL 页面快速切换分类无旧响应覆盖。
- 发布后先只验收 KOL 分类读取，再进入一个固定 CA 草稿验收账号选择；不要求真实 Swap。
- 任一 Watch/Activation Outbox、Engine 状态或 GMGN 请求出现非预期增量，立即回滚应用代码并保留加性 P36 Schema。

## 13. 验收标准

P36.1 只有满足以下条件才可进入正式代码实施：

1. KOL 页面和固定 CA 策略使用同一横向分类组件。
2. 生态与自定义标签并列展示，但一次只激活一个分类。
3. 点击 BSC 立即看到所有 BSC 账号，不需要清除其他条件。
4. 账号支持多个标签，策略跨分类选人时保持已选结果并去重。
5. 自定义标签不能与生态保留名称同名。
6. 策略保存明确账号和关系，不保存动态分类引用。
7. 分类功能不增加 GMGN、Watch 或 Engine 副作用。
8. 旧组合查询 API、KOL 多标签编辑、固定策略保存 Payload 和关系矩阵均无回归。
9. 生产不存在保留名称冲突，或已在用户确认后通过正常接口完成改名。

## 14. 本地实施与验证记录

实施日期：2026-08-18。

已完成：

- 后端在统一标签规范化入口增加 `KOL_LABEL_RESERVED_NAME`，创建和改名共用同一校验。
- 新增共享 `KolCategoryBar` 和纯分类模型，KOL 页面与固定 CA `AccountPicker` 共用分类语义。
- KOL 页面只保留一个 `activeCategoryKey`，并用请求序号阻止旧响应覆盖最后一次分类选择。
- 固定策略继续使用原 `selectedHandles`、`onSelectedHandlesChange`、`sortAccounts`、关系矩阵和保存 Payload。
- 新增 P36.1 分类边界、请求竞态和固定策略回调契约测试。

本地验证结果：

- 后端全量单元测试：650/650 通过。
- P36.1、P36、白名单关系和模板定向回归：25/25 通过。
- P36 PostgreSQL 集成用例通过，未产生 Watch 或 Activation Outbox 副作用。
- 隔离数据库 `xbot_p36_test` 的 Migration 053、Schema Audit 和保留名称冲突审计通过，冲突数为 0。
- 前端 `oxlint` 和生产构建通过。
- 正式页面 DOM 回归通过：KOL 生态/自定义标签单选分类、固定策略跨分类选择保持、“完成”和 `Esc` 关闭、桌面及 `390x844` 布局均正常，控制台无错误。
- 浏览器验收只修改未保存草稿，没有保存策略、同步 Watch、启动 Engine 或调用真实 Swap。

已知环境说明：

- 完整隔离集成套件 39 项中有 1 项旧 P12 `SKIP LOCKED` 并发用例连续失败；P36.1 未修改该交易重试模块，其余 38 项通过。
- 当前 `backend/.env` 指向的默认本地数据库尚未应用 Migration 053，本轮没有绕过 Migration 校验或修改该数据库。
- GitHub 推送和 xiexiu 部署尚未执行；部署前仍须在目标生产库执行只读冲突审计与 Schema Audit。
