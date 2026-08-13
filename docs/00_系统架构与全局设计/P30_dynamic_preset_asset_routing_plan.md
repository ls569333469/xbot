# P30 动态喊单预设资产路由更新方案

> 文档状态：`RESEARCH / HOLD`
>
> 投研日期：2026-08-13
>
> 实施授权：未授权。本方案只记录问题、目标架构、实施步骤和验收标准；当前不修改业务代码、不修改 xiexiu 服务器策略、不启动或停止 Engine、不触发 GMGN 交易。

## 1. 需求定义

P30 不新建第四种策略。它是对现有「动态喊单策略」的一个可选扩展：

1. 监听指定人物账号，例如 `@cz_binance`。
2. 可以继续从该账号自己的帖子中提取完整 CA。
3. 也可以当该账号回复、引用或直接转发指定项目账号时，读取「被互动原帖」的主正文。
4. 将原帖中唯一命中的项目词路由到用户预先填写的链和 CA。
5. 只有唯一路由成功时，才创建一个动态信号并进入原有 GMGN 交易链路。

目标链路：

```text
6551 收到事件
  -> 确认触发人物、事件类型和互动目标
  -> 分离人物自己的文本 / 被互动原帖 / 原帖内嵌引用
  -> 从指定解析范围匹配预设资产路由
  -> 唯一命中一个链 + 一个 CA
  -> 本地生成确定候选资产
  -> 动态 Signal
  -> 原有 P25/P26 单 Signal GMGN Quote/Swap/Order 链路
```

## 2. 已确认的本次资产映射

以下四组均已通过 BSC RPC 证明存在合约代码。这些是 P30 的验收样本，不代表当前已被写入本地或服务器路由表。

| 路由名称 | 建议别名 | 链 | CA |
|---|---|---|---|
| 何必东奔西走 币安全部都有 | `何必东奔西走，币安全部都有。` | BSC | `0xe9337dde3dd9e97f1f45a56412767ce5098e7777` |
| utility token | `utility token`、`utility` | BSC | `0xede00776439f9c49c592e43eee34777a51847777` |
| bStocks Never Sleep | `bStocks Never Sleep` | BSC | `0x244b112cf746e62a5df723cbde9906a6defd7777` |
| GameStop | `GMEB`、`GameStop`、`GME` | BSC | `0x2cee25fe4f13ec3d94558d41b3c7e0f4ee087777` |

### 2.1 `bStocks` 不应当作唯一路由词

`bStocks` 是账号品牌和业务名称，会出现在该账号的大量普通帖子中。例如：

```text
GMEB is now trading on bStocks.
```

如果 `bStocks -> 0x244...7777` 直接作为普通子串规则，这条帖子将同时命中 `GMEB` 和 `bStocks`，造成错买或多买。

P30 的建议是：

- `bStocks Never Sleep` 使用完整项目短语。
- 已发布的目标帖子可以增加精确 Tweet ID，优先级高于文本。
- 如果仍要使用宽泛的 `bStocks`，必须在前端显示冲突警告，并且运行时多路由命中必须失败关闭。

## 3. 当前实现的客观结论

### 3.1 当前已支持

- 动态策略已支持原创 `tweet`、回复 `reply`和引用 `quote`。
- 6551 Normalizer 已能识别 `replyStatus`、`quotedStatus`和 `retweetedStatus`的目标账号。
- 6551 `Tweet by ID` 详情可以返回原帖正文和嵌套引用帖。
- `approved_aliases` 是 JSONB，后端已能保留对象中的额外字段。
- 动态策略已有 Revision、`context_hash`、任务取消和信号快照机制。
- 6551 Watch Reconciler 已能生成 `newRetweetBol`，不需要新的 Provider 协议。

### 3.2 当前不支持

- 前端「批准项目名 / 别名」只能保存字符串，不能绑定链和 CA。
- 普通别名仍依赖 Candidate Index 查找资产，不会使用用户指定的 CA。
- 动态 Worker 只直接读取 `raw_json.quotedText/replyText`，没有标准化读取 6551 嵌套的 `replyStatus.text/quotedStatus.text`。
- 当前没有结构化的「互动目标账号」和「目标 Tweet ID」策略字段。
- 当前动态策略不支持不带自己文字的直接转发 `retweet/repost`。引用帖 `quote` 已支持，两者不是同一事件。
- 现有 Intent Gate 会把只出现在引用或回复上下文的资产当作 `quoted_only`，不能表达「策略明确授权的互动路由」。

## 4. 不采用的快速修补

### 4.1 不把 CA 直接塞入普通别名对象

原因：会继续混合「文本识别」和「交易授权」，也没有目标账号、解析范围和冲突规则。

### 4.2 不手工向 Candidate Index 注入三到四个资产

原因：Candidate Index 是资产证据索引，不是账号级交易策略。手工注入无法限定 `@cz_binance -> @bstocksfinance`，也会影响其他动态策略。

### 4.3 不创建四条相同互动条件的固定 CA 策略

原因：CZ 的一次回复可能同时匹配四个固定 CA，造成多笔买入。

### 4.4 不将 GMGN 用作每个词的实时猜测器

原因：路由映射由用户预先明确，运行时不应为未命中事件调用 GMGN Token Info/Security/Pool，也不应恢复 P22-P24 清理过的预热和轮询。

## 5. P30 目标数据契约

### 5.1 策略字段

建议 Migration `050` 在 `x_actor_dynamic_policies` 增加独立 JSONB 字段：

```json
{
  "preset_asset_routes": [
    {
      "route_id": "stable-local-id",
      "label": "GameStop",
      "aliases": ["GMEB", "GameStop", "GME"],
      "chain_id": "bsc",
      "contract_address": "0x2cee25fe4f13ec3d94558d41b3c7e0f4ee087777",
      "match_sources": ["actor_text", "interaction_target_text"],
      "interaction_target_handles": ["bstocksfinance"],
      "target_tweet_ids": [],
      "event_types": ["tweet", "reply", "quote", "retweet"],
      "enabled": true
    }
  ]
}
```

不建议把它隐藏到 `resolver_options`；路由是核心交易授权数据，应有显式字段、独立校验和 Schema Audit。

### 5.2 标准化互动上下文

建议 Migration `050` 同时在 `x_activities` 增加：

- `target_tweet_id text`
- `target_tweet_text text`
- `interaction_context jsonb`

`interaction_context` 只保存解析必需的标准字段：事件类型、目标作者、目标 Tweet ID、目标主正文、嵌套引用摘要和来源。不将完整 Provider 敏感响应写入策略快照。

### 5.3 一次性路由验证

创建或修改路由时执行：

1. 链和地址格式校验。
2. EVM 链使用选定链 RPC 读取一次合约代码。
3. 可选读取 `name()/symbol()` 用于前端核对。
4. 结果持久化；每次事件触发不重复验证。
5. 全过程不调用 GMGN。

## 6. 事件解析与路由标准

### 6.1 文本所有权分层

P30 必须把下列三层作为不同证据，不能合并全文搜索：

1. `actor_text`：CZ 自己发的文字。
2. `interaction_target_text`：CZ 直接回复、引用或转发的 bStocks 原帖主正文。
3. `nested_quoted_text`：bStocks 原帖内又引用的更早帖子，只作审计上下文，P30 默认不参与路由。

这一规则可以保证 `GMEB is now trading on bStocks` 不会因内嵌 CZ 旧帖中出现 `utility token` 而错买 utility。

### 6.2 匹配优先级

1. 目标 Tweet ID 精确匹配。
2. 指定解析范围内的完整项目短语。
3. Cashtag/Hashtag 边界匹配。
4. 符号或简称的独立单词匹配。

同一优先级命中两个不同 CA，或低优先级宽泛词与高优先级项目词冲突且无法唯一决定时，返回 `DYNAMIC_ROUTE_AMBIGUOUS`，只记录、不交易。

### 6.3 新的明确 Intent

新增 `mapped_interaction_direct`，只在以下全部成立时出现：

- 事件来自策略绑定的人物账号。
- 事件类型在路由授权范围内。
- 互动目标作者在路由允许列表内。
- 指定文本范围唯一命中一个预设路由。
- 路由所属策略 Revision 和 `context_hash` 仍然有效。

该 Intent 不放宽普通引用内容的交易权限，也不影响原有 `quoted_only` 安全边界。

## 7. 6551 补读和性能边界

### 7.1 补读条件

如果 6551 WSS 事件已带完整 `replyStatus/quotedStatus/retweetedStatus`，直接使用，不调 REST。

只有同时满足以下条件，才允许使用 `Tweet by ID` 补读一次：

- 人物账号存在已启用的预设资产路由。
- 事件类型为 `reply/quote/retweet`。
- 原始事件缺失主目标正文或目标 Tweet ID。
- 事件尚未存在可复用的标准化上下文快照。

### 7.2 事务边界

当前 6551 Inbox 的 enrichment 位于数据库事务内。P30 需要拆分为：

```text
原始事件去重
  -> 事务外必要的 6551 一次补读
  -> 生成标准化快照
  -> 短事务内写 Inbox / Activity / Job
```

不允许在长数据库事务内等待外部网络。补读失败时保留可重试事件证据，不降级猜测 CA。

## 8. GMGN 调用边界

P30 必须继续遵守 P24-P26：

- 非目标人物：GMGN `0` 次。
- 非目标项目账号：GMGN `0` 次。
- 无路由命中：GMGN `0` 次。
- 多路由歧义：GMGN `0` 次。
- Record/Paper 路由验证：GMGN Swap `0` 次。
- Live 唯一命中：只创建一个 Signal，由原有单 Signal GMGN 执行会话处理。
- 不增加 GMGN 预热、Token Info、Security、Pool、Gas 轮询或候选验证。

预设路由是本地确定候选，它不依赖 GMGN 来判断应该买哪个 CA。

## 9. 前端方案

在现有「词条与 CA 解析规则」步骤内增加两种模式，可同时启用：

1. **内容自解析**：保留完整 CA、Cashtag、Hashtag 和普通批准名称。
2. **预设资产路由**：以可编辑表格管理路由名、多个别名、链、CA、解析范围、互动目标账号和可选 Tweet ID。

前端必须提供：

- 一行对应一个唯一 CA，一行内可有多个别名。
- 链使用菜单，CA 使用等宽输入。
- 账号使用标准 X Handle 选择器。
- 解析范围使用复选或分段控件，不允许隐式默认到全文。
- 保存前显示重复别名、跨 CA 冲突、宽泛品牌词和无效地址。
- 策略摘要明确显示「4 条预设路由」，不再把它们称为普通关键词。
- 现有模板可选择是否包含路由；默认不把特定人物账号写入通用模板。

## 10. 兼容性和 Revision 标准

- 旧策略 `preset_asset_routes = []`，行为完全不变。
- 完整 CA 直接解析保持最高优先级。
- 新路由字段必须进入 `context_hash`。
- 修改路由时产生新 Revision，并取消旧 Revision 尚未执行的任务和信号。
- Signal 和 Authorization Snapshot 必须记录 `route_id`、命中词、解析范围、目标账号、目标 Tweet ID、链和 CA。
- 不允许运行时重读当前表单值替换信号快照。

## 11. 预计代码范围

实施时预计涉及 `12-18` 个文件，主要包括：

- `frontend/src/pages/kol/P20Operations.tsx`
- `frontend/src/lib/types.ts`
- `frontend/src/lib/api.ts`
- 动态工作区样式文件
- `backend/domains/dynamic-signal/policy-service.js`
- `backend/domains/dynamic-signal/templates.js`
- `backend/domains/dynamic-signal/content-extractor.js`
- 新的预设资产路由解析器
- `backend/domains/dynamic-signal/ca-resolver.js`
- `backend/domains/dynamic-signal/event-worker.js`
- `backend/domains/dynamic-signal/event-queue.js`
- `backend/domains/dynamic-signal/dynamic-target-service.js`
- `backend/domains/x-monitor/6551/normalizer.js`
- `backend/domains/x-monitor/6551/event-inbox.js`
- `backend/domains/x-monitor/queries.js`
- Migration `050`、`backend/db/init.sql`、Schema Audit 和 Migration rehearsal
- 单元、集成、DOM 和 Provider 边界测试

整体实施难度评估为 **7/10，中等偏大**。难点不在于输入 CA，而在于互动上下文所有权、互斥路由、Revision 快照和可证明的 GMGN 零额外调用。

## 12. 自动化验收矩阵

### 12.1 必须通过的路由用例

1. CZ 原创帖只包含完整 CA：沿用旧链路。
2. CZ 回复 bStocks，原帖唯一包含 `utility token`：选择 `0xede...7777`。
3. CZ 引用 bStocks，原帖唯一包含「何必东奔西走」：选择 `0xe933...7777`。
4. bStocks 原帖为 `GMEB is now trading on bStocks`，且内嵌 CZ 旧帖含 `utility token`：只选择 `0x2cee...7777`。
5. CZ 直接转发一条唯一命中 `bStocks Never Sleep` 的 bStocks 原帖：选择 `0x244...7777`。
6. CZ 回复非 `@bstocksfinance` 账号，即使对方文本含 `GME`：不交易。
7. CZ 普通讨论 bStocks，但没有命中已授权路由：不交易。
8. 同一解析范围命中两个不同 CA：`DYNAMIC_ROUTE_AMBIGUOUS`，不交易。
9. 策略保存产生新 Revision：旧任务不能使用新映射，新任务不能使用旧映射。

### 12.2 Provider 和性能验收

- WSS 带完整上下文时，6551 REST 增量为 `0`。
- 上下文缺失时，每个唯一事件最多补读 `1` 次。
- 补读不在数据库长事务内执行。
- 无命中、歧义和 Record 检查期间 GMGN Swap 为 `0`。
- Live 唯一命中只生成一个 Signal、一个 Attempt 和一个 Swap 幂等会话。
- P24 GMGN 全局审计证明无预热、无候选轮询、无非触发调用、无 429 异常增量。

### 12.3 前端 DOM 验收

- 桌面和移动端可完整查看每条路由的名称、链、CA 和目标账号。
- 长 CA 不溢出，多别名可换行，表单提示不与按钮重叠。
- 不同 CA 复用同一别名时阻止保存。
- 直接转发和引用帖在界面上明确分开。
- 旧策略打开和再保存后语义不变。

## 13. 服务器观察期

用户将先让当前 xiexiu 动态策略运行一段时间。观察期间不实施 P30，不手工向 Candidate Index 填充上述四个 CA。

建议收集以下只读证据：

| 观察项 | 目的 |
|---|---|
| CZ 原创/回复/引用事件数 | 确定主要触发类型 |
| 6551 原始事件是否带目标原帖 | 估算补读比例和延迟 |
| 三个当前普通别名的命中数 | 评估文本命中率 |
| `DYNAMIC_CA_NOT_FOUND` | 证明普通别名缺少 CA 映射 |
| `MULTIPLE_AUTHOR_ASSETS` / 歧义 | 评估词条冲突 |
| 原帖与嵌套引用中的词条差异 | 校验文本所有权设计 |
| 信号生成延迟 | 设定 P30 性能基线 |
| GMGN 请求和 429 增量 | 确认现行策略的 Provider 边界 |

观察期结束后，先根据真实样本修订词条和解析范围，再决定是否授权实施。

## 14. 实施顺序（待用户授权）

1. 锁定观察样本和最终路由词。
2. 完成 Migration `050`、数据契约、Schema Audit 和迁移演练。
3. 完成 6551 互动上下文标准化和事务外补读。
4. 完成预设资产路由校验器和互斥解析器。
5. 接入现有动态 Target/Signal 链路，保持 GMGN 执行模块不分叉。
6. 完成前端路由表单、冲突预览和模板契约。
7. 执行全量单元测试、独立测试库集成测试、迁移演练、前端构建和 DOM 回归。
8. 在本地 Record 与 Paper 完成四路由样本验收，证明 GMGN Swap 为零。
9. 按 P29 单独提交、推送和部署；部署时保持 Engine 当时状态，不因策略保存全局停止或启动。
10. 生产先进行 Record 验收，再由用户单独授权单账号小额 Live 验收。

## 15. 完成定义

P30 只有在以下条件全部满足时才能标记 `DONE`：

- 四组样本路由均能从指定文本范围唯一选出正确 BSC CA。
- 非目标账号、无命中、多命中和嵌套引用污染全部失败关闭。
- 原有完整 CA 动态喊单行为无回归。
- 策略 Revision、快照、信号幂等和旧任务取消验收通过。
- 6551 补读有上限、可审计，且不位于长事务内。
- P24 审计证明非交易阶段无 GMGN 调用，无 429 回归。
- 自动化测试、前端构建、DOM 回归、服务器发布验收均有可追溯证据。
- 小额 Live 验收必须等待用户单独授权，不得由部署或自动回归隐式启动。

## 16. 当前结论

P30 的正确方向是「动态喊单的预设资产路由」，而不是固定 CA 策略的复制，也不是让 GMGN 代替本地决定应买哪个币。

当前先保持 xiexiu 现有策略运行并收集真实事件样本。样本足够后再复核映射词、目标账号和解析范围，最后由用户决定是否授权实施。
