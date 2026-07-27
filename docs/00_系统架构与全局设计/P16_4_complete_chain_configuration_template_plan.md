# P16.4 完整链配置模板方案

> 状态：已实施并完成桌面/390px DOM 回归，待真实数据保存回显验收
> 日期：2026-07-27
> 预览：`xbot-p16-4-chain-template-preview.html`

## 1. 目标

链模板不再只是资金策略模板，而是复用一条链上创建白名单时真正重复填写的配置：

1. X 触发规则及生态 Actor；
2. 单笔金额、累计上限、滑点和买入次数；
3. 完整离场策略。

模板应用和保存都只修改本地草稿或 `whitelist_templates`，不得创建 6551 Watch。只有最终保存白名单后，Watch Outbox 才允许同步远端。

## 2. V2 模板边界

### 2.1 保存

- `schema_version = 2`
- `direct_source_rule_enabled`
- `direct_source_actor_handles`
- `direct_source_event_types`
- `relation_rule_enabled`
- `relation_actor_handles`
- `relation_event_types`
- `relation_target_policy = all_selected_project_identities`
- `budget_per_trade`
- `total_budget`
- `slippage`
- `allow_repeat_buy`
- `max_repeat_buys`
- `exit_strategy`

### 2.2 不保存

- CA、Symbol、项目名称和 Token metadata；
- 当前 CA 的项目官方、Founder、CEO 或建设者账号；
- 具体 actor-target 关系及其数据库 ID；
- Watch 状态、同步错误和 Outbox 状态；
- 已花预算、当前买入次数、持仓、订单和交易历史。

## 3. 应用语义

以 ROBINHOOD 模板 14 个生态账号、新 CA 投研得到 4 个项目身份为例：

```text
模板 Actor 14 个
        ×
当前 CA 项目身份 4 个
        =
56 条互动关系（同账号自关联除外）

6551 Watch = 14 个唯一 Actor，不按 56 条关系重复创建
```

项目身份始终来自当前 CA 的投研或手工确认。模板只保存目标策略，不复制旧 CA 的 Target。

## 4. 交互

1. 新建白名单选择链后自动应用该链默认模板。
2. 工作区上下文栏持续显示当前配置来源。
3. 第 1 步使用紧凑模板条展示 X、资金和离场摘要。
4. “更换”侧栏统一承载选择模板、复制已有和空白创建；复制入口按当前链分页加载全部白名单，不受列表当前页限制。
5. 修改当前草稿默认只影响当前 CA。
6. 工作区上下文栏始终提供“保存模板”，不再根据差异状态隐藏入口。
7. 模板选择抽屉提供“编辑所选”，进入只包含 X 触发与资金/离场的独立编辑模式，不要求先填写 CA。
8. 配置偏离来源时，第 3 步只显示差异类别和恢复来源配置，模板保存统一走固定入口。
9. 更新默认模板必须经过小型确认框，并明确列出不保存的数据。
10. 编辑已有白名单也允许应用或更新模板，但必须最终保存白名单后，白名单本身的改动才生效。

## 5. V2 单一路径

1. 生产数据库中的 ROBINHOOD 旧模板已原位替换为版本 5 的 V2 完整默认模板，包含 15 个 Relation Actor。
2. 后端只接受 `schema_version = 2`，缺失版本或 V1 请求直接拒绝。
3. 前端只展示和应用完整模板，不再保留“旧版资金策略”分支。
4. 模板仍使用现有 JSONB 字段，不复制项目 Target、关系 ID 或 Watch 状态。

## 6. 单一配置路径

以下入口统一使用同一配置快照物化逻辑：

- 自动应用链默认模板；
- 手工更换模板；
- 复制已有同链白名单；
- 快速投研返回白名单草稿；
- 恢复配置来源。

草稿显式持久化：

- Direct Source 规则启用状态和 Actor handles；
- Relation 规则启用状态和 Actor handles；
- Relation Target handles；
- Relation Target policy。

因此模板 Actor 可以先于项目身份存在。投研返回项目身份后，系统按策略自动生成关系矩阵。

## 7. 验收

- [x] V2 后端校验、Handle 标准化和去重测试。
- [x] ROBINHOOD 旧模板已替换为 15 个 Actor 的 V2 默认模板。
- [x] 后端拒绝缺失版本和 V1 模板，前端旧模板分支已删除。
- [x] 模板、复制和投研草稿统一快照路径。
- [x] 模板不保存项目 Target、关系 ID 或 Watch 状态。
- [x] Actor/Target 选择顺序可独立存在于草稿。
- [x] 同账号自关联只跳过该组合，不阻断整个矩阵。
- [x] 模板保存和应用不调用 Watch API。
- [x] 模板保存入口固定可见，现有模板可从选择抽屉直接进入独立编辑模式。
- [x] 复制来源 ID 在前端统一按字符串比较，兼容数据库数字 ID。
- [x] 桌面 DOM 草稿回归：模板应用、Actor/Target 矩阵、步骤往返、差异提示和确认框。
- [x] 390px DOM 回归：无横向溢出，抽屉与确认框完整可见，关系矩阵和最终 Watch 影响正确回显。
- [ ] 使用当前数据库真实模板完成保存、重新进入和回显验收。
