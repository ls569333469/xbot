# P42 模板同步与交易配置快照方案

> 状态：已复核，按低风险边界实施（v1.2）
> 日期：2026-08-31
> 关联：P16.4 完整链配置模板、P17 热激活、P23 运行授权、P27 信号契约快照

## 1. 目标

为已经存在的固定 CA 提供“模板预览 -> 批量同步 -> 结果审计”的维护路径，解决逐个打开策略修改金额、累计预算、重复买入次数和离场策略的问题。

本方案的最高优先级约束是：

1. 不影响当前正常买入、平仓、保护策略同步和 Signal 消费；
2. 不新增 Engine 全局暂停、链级暂停或 CA 级交易门禁；
3. 不重置历史买入次数、已花预算、持仓、订单或交易记录；
4. 同步失败只影响本次同步的单个 CA，不能暂停其他 CA 或 Engine；
5. 模板名称修改、模板应用和模板同步必须与 6551 Watch 同步及 Activation Outbox 解耦。

## 2. 现状与风险

完整的 `PUT /api/whitelist/:id` 会把活动白名单置为 `live_activation_state=syncing` 并创建 Activation Outbox。Activation 尚未完成时，Signal matcher 可能把新信号记录为 `signal_only`，交易队列也会等待 `live_ready`。因此模板同步禁止复用完整白名单更新接口和 Activation retry 接口。

当前交易执行读取白名单的实时配置，而已记录 Signal 没有完整的交易配置快照。若只批量更新白名单，尚未提交的旧 Signal 可能错误使用新金额、滑点或离场策略。P42 增加 Signal 创建时的交易配置快照，明确配置生效边界。

## 3. 模板名称修复

模板后端已经支持 `whitelist_templates.name` 的创建和更新。前端不得再把名称写死为 `${chain} 默认模板`。

要求：

- 模板编辑页增加名称输入框；
- 保存使用用户输入的名称，名称去除首尾空格并限制 80 个字符；
- 按实际编辑的模板 ID 更新，不能总是更新链默认模板；
- 默认模板状态保持原值，除非用户明确切换；
- 保存模板只写 `whitelist_templates`，不写 CA、Watch、Signal、Engine 或交易表。

## 4. 模板同步契约

### 4.1 接口

新增独立接口，不调用 `updateWhitelist()`：

```text
POST /api/whitelist/template-sync/preview
POST /api/whitelist/template-sync
```

请求包含：

```json
{
  "template_id": "模板 ID",
  "whitelist_ids": ["固定 CA ID"],
  "expected_template_version": 5
}
```

限制：

- `whitelist_ids` 必须去重，单次最多 50 个；
- 模板必须存在且版本匹配；版本变化时拒绝写入并要求重新预览；
- 目标只能是已知 CA 的固定策略，拒绝 `dynamic_keyword` 和 `follow_discovery`；
- 不允许跨链应用模板；
- 预览不产生数据库写入，不创建 Watch，不调用 6551、GMGN、RPC 或钱包。

### 4.2 允许同步的字段

- `budget_per_trade`；
- `total_budget`；
- `slippage`；
- `allow_repeat_buy`；
- `max_repeat_buys`；
- `exit_strategy`；
- 根据离场策略同步派生的兼容字段 `auto_tp_pct` 和 `auto_sl_pct`。

### 4.3 明确禁止修改的字段

- CA、链、Symbol、项目名称和 Token metadata；
- X 触发账号、关系、项目账号和事件类型；
- 6551 Watch、Watch Outbox 和 Watch 状态；
- `current_buy_count`、`spent_budget`、Paper 统计；
- `live_activation_state`、`activation_version`、Activation Outbox；
- Engine 状态、交易模式和全局配置；
- Signal、Intent、Attempt、Position、Lot、Order 和历史记录。

### 4.4 单 CA 预检查

预览和执行使用同一套检查。任一检查不通过，该 CA 返回明确原因并保持原样，其他 CA 继续：

1. 目标不存在、已归档、不是固定 CA 或链与模板不一致；
2. 目标属于当前活动的 live acceptance scope；
3. 存在旧的 `recorded/pending/approved/pending_risk/execution_reserved` Signal，且没有 P42 交易配置快照；
4. 模板累计预算低于该 CA 已花预算加当前已预留金额；
5. 模板有效买入上限低于当前已完成买入次数加当前未完成买入次数；
6. 模板交易配置本身校验失败。

这些是同步写入的保护性拒绝，不是交易运行时新增门禁，也不会改变该 CA 当前状态。

## 5. Signal 配置边界

新增 `trade_signals.trade_config_snapshot`，保存 Signal 创建时的：

- 单笔金额；
- 累计预算；
- 滑点；
- 重复买入开关和上限；
- 离场策略及版本；
- 兼容止盈止损百分比；
- `snapshot_version` 和哈希。

固定 CA、首发监控和动态策略创建 Signal 时都写入快照。只有资金、滑点、重复买入和有效离场策略均完整通过校验时，才写入版本为 `p42.trade_config.v1` 的完整快照；完整快照还必须包含与快照正文一致的 SHA-256 哈希。旧调用方、数据不完整或哈希不一致时写入 `{}`，继续走历史兼容路径，不能生成一个“看似存在但不可执行”的半成品快照。

执行读取优先使用完整的 `p42.trade_config.v1` 快照；快照缺失或校验不通过时继续读取原有白名单配置。模板同步对 `recorded/pending/approved/pending_risk/execution_reserved` 中缺失或不完整快照的 Signal 均按旧待执行信号处理并跳过该 CA，避免修改后让旧信号意外使用新配置。

生效规则：

- 同步前已经创建且有快照的 Signal 继续使用旧配置；
- 同步后新建的 Signal 使用同步后的白名单配置；
- Intent/Attempt 使用各自已保存的配置快照；
- 已有 Position 的保护策略不因模板同步被改写。

P42 不修改 `Engine`、Readiness、Execution Queue、Activation、Watch、RPC、钱包或 GMGN 的判断条件；`applyTradeConfigSnapshot()` 只在交易加载目标 Signal 后覆盖该 Signal 的交易配置字段，不改变交易状态、授权状态或任何全局状态。因此模板同步保护检查只约束“本次同步是否写入”，不是交易运行时新增门禁。

## 6. 审计与失败处理

新增模板同步运行记录和逐 CA 结果记录，至少保存：

- 模板 ID、模板版本、请求的 CA ID；
- 每个 CA 的 `updated/skipped/unchanged` 结果；
- 跳过代码和中文说明；
- 修改前后的交易配置快照；
- 操作时间和操作人。

执行采用一个事务锁定模板和目标 CA，逐条计算结果后只更新可更新项。单条业务校验失败不能回滚其他已成功 CA；数据库故障则整个事务回滚，不产生部分写入。接口不触发重试、不补发信号、不创建交易。

推荐的返回示例：

```text
BASEJUICE：已同步
WTDD：配置没有变化
GME：未同步，累计预算低于已花预算和当前预留金额
OLD：未同步，存在没有配置快照的待执行旧信号
```

## 7. 前端交互

固定 CA 列表增加：

1. 行选择框和“选择本页”功能；
2. “模板同步”按钮，未选择 CA 时禁用；
3. 模板选择、版本显示和同步字段摘要；
4. 预览结果表，明确显示将更新、无需更新和跳过原因；
5. 只有预览成功后才显示确认执行按钮；
6. 执行完成后保留逐条结果，不以“保存成功”掩盖被跳过的 CA。

前端不得在同步后主动刷新或重试 Activation 来“帮助完成同步”。列表刷新只读取最新状态，不改变交易状态。

## 8. 实施文件边界

第一阶段：

- `frontend/src/pages/whitelist/WhitelistWorkspace.tsx`：模板名称和正确模板 ID 编辑；

第二阶段：

- `backend/db/migrations/055_p42_template_sync_trade_config_snapshots.sql`；
- `backend/domains/whitelist/template-sync.js`；
- `backend/domains/whitelist/routes.js`、`service.js`；
- `backend/domains/whitelist/queries.js`（如需复用查询）；
- `backend/domains/signal/contract-snapshot.js`、`queries.js`、`matcher.js`、`launch-matcher.js`；
- `backend/domains/dynamic-signal/dynamic-target-service.js`；
- `backend/domains/trade/trade-repository.js`；
- `frontend/src/lib/api.ts`、`types.ts`、`pages/WhitelistPage.tsx`、`index.css`；
- 对应单元测试和集成测试。

不得修改与本功能无关的 `Layout.tsx`、`display-labels.ts` 和部署文档现有未提交内容。

## 9. 验收与回滚

代码上线前必须通过：

- 模板名称创建、重命名、非默认模板编辑测试；
- 预览不写库、不调用外部 Provider 测试；
- 同步不改变 Watch、Activation、Engine、Signal 数量和历史计数测试；
- 不完整、篡改或哈希不一致快照保持旧兼容路径、完整快照隔离模板更新测试；
- P42 同步不改变交易运行时门禁和 Engine 状态测试；
- 同步前后 Signal 快照隔离测试；
- 预算、次数、活动验收作用域和旧 Signal 跳过测试；
- 单条失败不影响其他 CA 测试；
- 后端全量单元测试、前端 lint/build；
- 专用测试库迁移回放和数据库字段审计。

发现交易行为、Signal 状态、Engine 状态或 Activation 状态发生非预期变化时，立即停止使用同步按钮；保留同步审计记录，回滚 P42 应用代码。不得通过手工修改生产数据库回滚买入次数、预算或交易历史。

## 10. 明确结论

P42 不把模板同步做成一次“批量白名单编辑”。它是一个只修改交易配置、带预览和逐条审计的维护工具。模板名称可以先独立上线；已有 CA 同步只有在配置快照和不影响旧 Signal 的边界完成后才允许写入。
