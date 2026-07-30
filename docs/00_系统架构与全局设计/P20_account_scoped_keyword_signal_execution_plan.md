# P20 账号限定关键词触发与安全映射方案

> 状态：待审核，尚未实施。日期：2026-07-30。
>
> 本文只定义技术方案、实施顺序和验收标准。本阶段不修改业务代码、不执行数据库 Migration、不部署服务器、不改变 Engine 状态，也不会自动开启任何真实交易。
>
> 代码基线：`d1db9e5 feat: deliver P19 low-latency live execution`。正式实施前必须重新核对 GitHub、生产服务器 `/opt/xbot` 和本地备份的提交号；生产服务器版本是唯一部署与实盘验收对象，本地仅承担开发、测试和备份。

## 1. 结论

可以新增关键词触发，但必须作为独立的第三条触发线路，不能恢复为“白名单 Symbol 自动匹配所有 Tweet”。

目标语义固定为：

```text
指定 X 来源账号
  -> 指定事件类型
  -> 显式配置的精确关键词/短语
  -> 当前白名单的固定链 + 固定 CA
  -> 现有 Signal、Live Policy、风控与 P19 实盘快路径
```

三条线路互相独立：

| 线路 | 当前/新增 | 判断条件 | 目标 CA 从哪里来 |
|---|---|---|---|
| 生态账号自己发布完整 CA | 已有 | 指定账号的正文含当前白名单完整 CA | 当前白名单 |
| 生态账号与项目账号互动 | 已有 | 指定生态账号对指定项目账号发生 Reply/Quote/Retweet/Follow | 当前白名单 |
| 指定账号发布关键词 | P20 新增 | 指定账号正文命中人工确认的精确词条 | 当前白名单 |

关键词线路不是搜索系统，也不根据 Tweet 临时猜测代币。每条规则在保存时就已经绑定一个确定的 `chain_id + contract_address`。运行时 GMGN、Grok 和 6551 REST 均不进入交易热路径。

P20 的默认安全策略为：

1. 新规则默认“仅记录”，不自动交易。
2. 默认只匹配原创 Tweet；Quote、Reply、Retweet 必须分别开启。
3. 不允许用户输入正则表达式，不做模糊匹配、拼音匹配、翻译或 AI 语义猜测。
4. 同一 Actor、同一事件、同一标准化关键词只能指向一个链和一个 CA。
5. 同一 Tweet 命中多个 CA 时全部阻止，记录 `KEYWORD_AMBIGUOUS`。
6. Tweet 同时出现其他完整 CA 时阻止关键词交易，记录 `KEYWORD_CA_CONFLICT`。
7. 多个别名命中同一 CA，或与现有 CA/互动线路同时命中同一 CA，只生成一条 Signal。
8. 规则只有在历史回测通过、6551 Watch 满足、Matcher 缓存已激活且用户显式切换为“实盘”后，才有资格进入 Live Policy。

## 2. 本轮数据证据

### 2.1 GMGN 多链样本

2026-07-30 通过项目现有 GMGN OpenAPI 能力只读拉取以下样本：

- BSC、ETH、Robinhood、SOL 各链 `24h` 热门前 100；
- 各链 `history_highest_market_cap >= $100M` 的前 100 个可用结果；
- 相同链和 CA 合并去重后共 425 个项目。

| 链 | 24h 热门 | ATH > $100M | 合并去重 | Symbol 长度 <= 3 | 链内 Symbol 重名组 |
|---|---:|---:|---:|---:|---:|
| BSC | 100 | 4 | 104 | 28 | 11 |
| ETH | 100 | 62 | 119 | 37 | 3 |
| Robinhood | 100 | 1 | 100 | 11 | 7 |
| SOL | 100 | 3 | 102 | 12 | 3 |
| 合计 | 400 | 70 | 425 | 88 | 24 |

样本结论：

- 只有 `160/425` 个项目的 Name 与 Symbol 相同，不能只保存 Symbol。
- 样本中有 24 组链内 Symbol 重名，另有 25 组跨链 Symbol 重名。
- 典型冲突包括 `ASTEROID`、`CATE`、`GME`、`LUNA`、`MarsCoin`、`LINK`、`AI`。
- BSC 存在中文名称和默认不可见字符，例如 `中͏国͏人͏能͏飞`。
- SOL 样本包含日文、韩文和其他多语言名称，ASCII 单词边界不足以覆盖。
- SOL `Buttcoin` 的 GMGN ATH 约为 `$37.9T`，明显异常。ATH 只适合候选采样，不能作为关键词可信度或自动实盘依据。
- GMGN 的 X 字段可能是账号、Tweet URL、Community URL 或其他内容，不能直接转换为 6551 Watch。

用户指定的 BSC 样本：

```text
CA:     0xd0bc8ab397851ecfa58009d03bbc1a41fc764444
Symbol: 币有
Name:   何必东奔西走 币安全部都有
```

真实来源文本会出现类似：

```text
何必东奔西走，币安全部都有
```

因此该项目适合使用“标点与空格归一后的完整短语匹配”，不适合使用裸 Symbol `币有`。如果仅匹配 `币有`，普通中文语境中的误触发风险不可接受。

### 2.2 生产历史 Tweet 回测

只读检查现有生产历史数据：

| 指标 | 数量/范围 |
|---|---|
| `x_activities` 总记录 | 202 |
| 有 Tweet 文本 | 145 |
| Actor 数量 | 13 |
| 时间范围 | 2026-07-21 至 2026-07-27 |

将 425 个项目的 Symbol 对 145 条文本做初步边界匹配，出现以下结果：

- `ROBINHOOD` 命中 8 次，多数是普通平台语义，不是代币指代。
- `LINK` 命中 4 次，部分只是普通“链接”。
- `AI` 命中 3 次，均为普通 AI 语义。
- `TIME`、`IF`、`WEN`、`DEX`、`LOOKS`、`WALLET`、`CHIPS` 等都出现普通词误命中。
- `PONS` 命中 7 次，其中 5 次是 `$PONS`，Token Tag 明显更可靠。
- `CASHCAT` 同时出现 `$CASHCAT` 和 `#CASHCAT`，适合显式 Tag 词条。

这批历史数据很小，只能证明“裸 Symbol 自动触发不安全”，不能证明任何关键词已经足够安全。正式保存规则前必须按具体 Actor、事件类型和词条重新回测，不能只依赖本次全局样本。

### 2.3 6551 成本

关键词匹配发生在 XBOT 本地，不会给 6551 上传关键词，也不会为每个关键词创建 Watch。

当前成本模型：

| 操作 | 6551 增量成本 |
|---|---:|
| 给已经 Watch 且已启用对应事件的账号增加 1 个关键词 | 0 points |
| 给同一账号增加 100 个关键词 | 0 points |
| 新增一个唯一 Watch | 约 10 points，一次性 |
| 已托管 Watch 需要变更事件权限 | 当前删除重建约 10 points |
| WSS 消息 | 当前口径约每 20 条推送 1 point |

当前检查到的 20 个 Watch 均已有 `newTweetBol=true`。因此为这些账号增加原创 Tweet 关键词规则，预计不会产生 Watch 增量点数，也不会增加推送消息量。

## 3. 当前代码审计

### 3.1 旧 Symbol 匹配仍有残留

`backend/domains/signal/matcher.js` 当前仍包含：

```text
hasSymbolKeyword()
  -> whitelist.symbol
  -> ticker_mention
```

该实现的问题是：

- Symbol 来自代币元数据，不是用户确认的交易关键词。
- 使用 ASCII 边界，无法正确覆盖全部 Unicode 文本。
- 没有 Actor + 关键词 + 固定 CA 的独立授权记录。
- 没有保存前历史回测。
- 没有跨链重名、同 Tweet 多目标和其他 CA 冲突安全门。

P20 不在这个函数上继续增加条件。新实现完成后，应停止创建新的隐式 `ticker_mention`，但历史 Signal 继续保留可读，不做破坏性回填或删除。

### 3.2 P16 已明确直接来源只能匹配 CA

Migration `018_p16_final_product_convergence.sql` 已把 `x_signal_source_rules.match_mode` 强制为 `ca_only`。这条边界是正确的，P20 不修改：

- “生态账号自己发布完整 CA”继续只认完整 CA；
- 关键词规则使用新表和新授权数组；
- 项目账号身份、生态互动关系和关键词映射不混存。

### 3.3 当前最终实盘授权只有两类证据

现有资金写入前会复核：

- `matched_relation_ids`；
- `matched_source_rule_ids`。

P20 必须增加第三类 `matched_keyword_rule_ids`，并同步改造：

- `backend/domains/signal/live-policy.js`；
- `backend/domains/trade/trade-repository.js` 的 `beginSubmission()`；
- `backend/domains/system/routes.js` 的 Signal 实盘授权展示；
- `backend/domains/signal/queries.js` 的 Signal 持久化。

只在 Matcher 中匹配成功、但没有进入最终资金授权检查的实现，不得发布实盘。

### 3.4 当前 Symbol 展示值被强制大写

`backend/domains/research/sanitizers.js` 当前对 Symbol 执行 `.toUpperCase()`。P20 要区分：

- `symbol_display`：GMGN 原始展示值，不改变多语言和项目大小写；
- `keyword_normalized`：按匹配模式生成的内部标准化值；
- 两者不可互相覆盖，不能把标准化结果写回用户可见名称。

## 4. 范围与非目标

### 4.1 P20 必须实现

1. 为一个白名单配置多个来源账号和多个显式关键词别名。
2. 每个账号独立配置事件类型，默认仅原创 Tweet。
3. 支持 Token Tag、完整词、归一化短语三种模式。
4. 保存前按 Actor 历史 Tweet 回测，并显示命中原文与风险原因。
5. 支持“仅记录 / 影子验证 / 实盘”三级发布状态。
6. 新增规则不暂停同一白名单的其他正常触发线路。
7. 规则热更新、Watch 复用、Matcher 缓存刷新和失败重试。
8. Signal、Live Policy、最终提交前授权和页面解释完整贯通。
9. 保持 P19 延迟目标，不在实时路径调用 GMGN、Grok 或 6551 REST。
10. 提供完整自动化测试、灰度、回滚与生产验收流程。

### 4.2 P20 不做

- 不根据任意热门词自动买入未知 CA。
- 不让同一个关键词同时对应多个链或多个 CA。
- 不做模糊相似度、拼写纠错、拼音、翻译、Embedding 或 Grok 实时判断。
- 不把 GMGN 推荐词直接自动启用为实盘。
- 不使用用户输入的正则表达式。
- 不因为关键词数量增加 6551 Watch。
- 不改未发币项目监控的首次 CA 发现逻辑。
- 不改变现有交易金额、累计上限、重复买入和离场策略语义。
- 不在 Migration 或部署脚本中自动 Arm。

## 5. 产品语义

### 5.1 规则的最小完整信息

一组关键词规则必须同时包含：

```text
Actor:          谁发文，例如 @theunipcs
Event Types:    Tweet / Quote / Reply / Retweet
Terms:          $PONS、#PONS、完整中文项目短语等
Target Chain:   固定链，来自当前白名单
Target CA:      固定 CA，来自当前白名单
Rollout Mode:   signal / paper / live
Backtest:       样本范围、命中数、人工审核状态
Activation:     draft / syncing / ready / failed / paused
```

缺少 Actor、词条、固定链或固定 CA 的规则不能保存。`follow` 和 `unfollow` 没有正文，不属于关键词事件。

### 5.2 三种匹配模式

#### A. `token_tag_exact`

用途：明确的 Cashtag 或 Hashtag。

```text
配置 PONS
匹配 $PONS、$pons、#PONS
不匹配 PONS
不匹配 $PONSA
```

实现要求：

- `$` 和 `#` 均为显式 Tag 前缀；
- 英文忽略大小写；
- Tag Body 使用 Unicode 字母、数字和下划线边界；
- 保存原始显示值，内部只保存去前缀后的标准化 Body；
- 可将 `$PONS` 与 `#PONS` 配置为两个可见别名，也可由一个“Tag 两种前缀”选项生成，数据库仍保存明确词条证据。

这是英文/拉丁 Symbol 的默认推荐模式。

#### B. `word_exact`

用途：确实作为独立专有词使用、且历史回测证明安全的名称。

```text
配置 ANSEM
匹配 "ANSEM looks interesting"
不匹配 "ANSEMX"
不匹配 "$ANSEM" 或 "#ANSEM"，Tag 由 token_tag_exact 负责
```

实现要求：

- 使用 Unicode 字母、数字、组合标记和下划线定义词边界；
- 英文忽略大小写；
- 裸词少于 4 个 Unicode Code Point 默认禁止切换实盘；
- `AI`、`IF`、`TIME`、`LINK`、`DEX`、`WALLET` 等通用词即使满足长度，也必须根据 Actor 历史回测判定，不能只看长度；
- 高风险通用词允许保存为“仅记录”，不允许直接实盘。

#### C. `phrase_normalized`

用途：中文、多词项目名和标点变化明显的完整短语。

```text
配置：何必东奔西走 币安全部都有
匹配：何必东奔西走，币安全部都有
匹配：何必东奔西走\n币安全部都有
不匹配：币有
不匹配：东奔西走
```

实现要求：

- 只做确定性的 Unicode 与分隔符归一化；
- 不翻译、不转拼音、不做词序调整；
- 默认要求至少 4 个 CJK 字符或至少 8 个 Unicode Code Point；
- 短于门槛的词条只能“仅记录”，不能实盘；
- 完整短语在标准化文本中连续出现才算命中。

### 5.3 Unicode 标准化顺序

每条 Tweet 只标准化一次，并把结果在该 Activity 的匹配过程中复用：

1. 输入必须是合法字符串；空值直接不匹配。
2. 执行 Unicode `NFKC`，统一全角/半角和兼容字符。
3. 删除 `Default_Ignorable_Code_Point`，包括零宽字符和方向控制字符。
4. 将 `CRLF`、换行、Tab 和 Unicode Space Separator 归一为普通空格。
5. `phrase_normalized` 额外将 Unicode 标点序列归一为单个空格。
6. 连续空格折叠为一个，首尾去空格。
7. 对不区分大小写的模式执行稳定 Case Fold；显示文本保持原值。
8. 不做易混淆字符替换，例如西里尔字母 `А` 不自动当作拉丁字母 `A`。

标准化函数必须是独立纯函数，有固定测试向量和 `normalizer_version`。修改算法时必须提升版本并重新回测受影响规则，不能静默改变已实盘规则的语义。

### 5.4 可匹配正文的边界

关键词只能检查当前事件语义下由 Actor 发布的正文，不能把 Provider Payload 中所有字符串拼接后匹配：

- 原创 Tweet：匹配 Actor 自己发布的正文；
- Reply：只匹配 Actor 的回复正文，不匹配被回复 Tweet；
- Quote：只匹配 Actor 添加的评论正文，不匹配被引用 Tweet；
- Retweet：只有显式开启 Retweet 时，才匹配被转发原文，并在证据中标记 `content_source=retweeted`；
- URL、链接预览标题、图片 Alt、Community 名称、显示名、Profile Bio 和目标账号 Handle 不参与关键词匹配；
- URL 优先依据 Provider Entity Offset 移除；Entity 不完整时使用经过测试的 URL Parser，不能使用可能误删 Unicode 文本的临时正则；
- 如果 Quote/Reply Payload 无法可靠分离 Actor 正文与嵌入内容，该事件 fail closed 并记录 `KEYWORD_TEXT_SCOPE_UNVERIFIED`。

该边界必须在 Ingestion Sanitizer 中形成明确的 `authored_text` 或等价结构。Matcher 不直接猜测 `raw_json` 内哪个字段属于 Actor。

## 6. 冲突与安全模型

### 6.1 配置时冲突

保存规则的事务按 Actor 获取 PostgreSQL Advisory Lock，再检查所有启用或正在激活的规则：

```text
同一 actor_id
+ event_types 有交集
+ 标准化词条相同或匹配集合重叠
+ target chain/CA 不同
= 拒绝保存 KEYWORD_RULE_TARGET_CONFLICT
```

例如：

- `@actor + tweet + PONS -> Robinhood/CA-A` 已存在；
- 再保存 `@actor + tweet + PONS -> BSC/CA-B`；
- 系统必须拒绝，而不是靠运行时猜测。

不同 Actor 可以使用相同词条，因为来源账号已经提供独立作用域。

跨模式冲突也必须检测，不能只比较数据库中的 `normalized_value` 是否相等：

- `word_exact=PONS` 与 `phrase_normalized=PONS FAMILY` 指向不同 CA 时存在包含重叠；
- 两个归一化短语互为完整包含且可在同一正文同时命中时存在重叠；
- `word_exact` 明确不匹配 `$`/`#` 前缀，因而与同 Body 的 `token_tag_exact` 保持集合分离；
- 无法静态证明互斥的跨模式规则，保存时标记 `review_required`，不得直接进入实盘；
- 配置冲突检测与运行时冲突检测共用同一 Matcher 测试向量，避免两套语义漂移。

### 6.2 运行时多目标冲突

同一 Activity 匹配完成后，先按 `chain_id + normalized_ca` 分组：

- 多个词条命中同一目标：合并为一个候选；
- 关键词与完整 CA 线路命中同一目标：合并为一个 Signal，并保留全部证据；
- 关键词与生态互动线路命中同一目标：合并为一个 Signal；
- 最终候选包含两个或更多不同目标：全部拒绝自动交易，记录 `KEYWORD_AMBIGUOUS`。

被拒绝的每个候选仍生成可审计的 rejected Signal，Signal 页面按同一 Tweet 聚合显示，不进入 Live Queue。

### 6.3 Tweet 中存在完整 CA

关键词规则命中后检查 `activity.extracted_cas`：

- 没有 CA：继续关键词流程；
- 只有当前目标 CA：与 CA 证据合并并去重；
- 出现任意其他完整 CA：拒绝关键词交易，记录 `KEYWORD_CA_CONFLICT`；
- 无法识别链归属的 CA：按冲突处理，不做乐观放行。

这条安全门防止一条 Tweet 同时讨论其他合约时，关键词错误映射到预设 CA。

### 6.4 规则状态变化

Signal 必须保存匹配时的 Rule ID、Rule Revision、Term ID 和标准化版本。进入资金写入前再次验证：

- Rule 仍为 `enabled=true`；
- `activation_state=ready`；
- `rollout_mode=live`；
- Actor 仍启用；
- Rule 仍属于该白名单；
- Event Type 仍被允许；
- Signal 中的 Revision 与当前激活 Revision 一致。

任一项变化都以 `KEYWORD_RULE_CHANGED` 失败关闭，不继续 Swap。

## 7. 数据库设计

### 7.1 Migration 028

建议新增：

```text
backend/db/migrations/028_p20_account_scoped_keyword_signals.sql
```

新增逻辑规则表：

```sql
CREATE TABLE x_signal_keyword_rules (
  id bigserial PRIMARY KEY,
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE CASCADE,
  actor_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  event_types text[] NOT NULL DEFAULT ARRAY['tweet']::text[],
  rollout_mode text NOT NULL DEFAULT 'signal',
  enabled boolean NOT NULL DEFAULT true,
  activation_state text NOT NULL DEFAULT 'draft',
  revision bigint NOT NULL DEFAULT 1,
  normalizer_version text NOT NULL DEFAULT 'p20-v1',
  backtest_status text NOT NULL DEFAULT 'pending',
  backtest_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  backtest_fingerprint text,
  last_backtested_at timestamptz,
  approved_at timestamptz,
  approved_by text,
  last_error_code text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(whitelist_id, actor_id)
);
```

约束值：

- `event_types` 只能包含 `tweet/retweet/quote/reply`，且至少一个；
- `rollout_mode` 只能是 `signal/paper/live`；
- `activation_state` 只能是 `draft/syncing/ready/failed/paused`；
- `backtest_status` 只能是 `pending/review_required/approved/blocked`。

`backtest_fingerprint` 必须覆盖 Actor、Event Types、全部词条、匹配模式、目标链/CA、Rule Revision、Normalizer Version 和历史样本边界。任一字段变化时，在同一事务中清空批准信息并重置为 `pending`；不能沿用旧版本的批准状态。

新增词条表：

```sql
CREATE TABLE x_signal_keyword_terms (
  id bigserial PRIMARY KEY,
  rule_id bigint NOT NULL REFERENCES x_signal_keyword_rules(id) ON DELETE CASCADE,
  display_value text NOT NULL,
  normalized_value text NOT NULL,
  match_mode text NOT NULL,
  risk_flags text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(rule_id, match_mode, normalized_value)
);
```

`match_mode` 只能是：

- `token_tag_exact`；
- `word_exact`；
- `phrase_normalized`。

索引：

```text
(actor_id, enabled, activation_state)
(whitelist_id, enabled)
(rule_id, enabled)
GIN(event_types)
```

### 7.2 Activity 正文作用域字段

`x_activities` 增加：

```text
authored_text text
text_scope_status text NOT NULL DEFAULT 'unknown'
content_source text
```

约束值：

- `text_scope_status`：`verified/unknown/unavailable`；
- `content_source`：`original/reply/quote_commentary/retweeted` 或空值。

新 Ingestion 事件必须在入库前确定正文作用域；关键词 Matcher 只接受 `text_scope_status=verified`。既有历史记录不做乐观回填，保持 `unknown`：可以用于人工辅助回测，但必须标记“旧数据正文范围未核验”，不能单独据此批准实盘规则。规则进入 Paper/Live 前必须至少经过新版 Ingestion 的 verified 事件观察。

### 7.3 Signal 证据字段

`trade_signals` 增加：

```text
matched_keyword_rule_ids bigint[] NOT NULL DEFAULT '{}'
matched_keyword_term_ids bigint[] NOT NULL DEFAULT '{}'
keyword_match_evidence jsonb NOT NULL DEFAULT '{}'
```

`keyword_match_evidence` 只保存审计所需内容：

```json
{
  "normalizer_version": "p20-v1",
  "rule_revision": 3,
  "text_scope_status": "verified",
  "content_source": "original",
  "terms": [
    { "term_id": 12, "mode": "token_tag_exact", "display": "$PONS" }
  ],
  "conflicts": []
}
```

`signal_type` 增加 `keyword_match`。历史 `ticker_mention` 保留可读，但新 Matcher 不再隐式创建。

### 7.4 Migration 安全要求

- Migration 只新增表、字段、索引和兼容约束，不创建任何默认关键词规则。
- 不从 `ca_whitelist.symbol` 自动回填关键词。
- 不改变现有白名单状态、Watch、Signal、Position、Order 或 Engine 状态。
- 修改 `trade_signals.signal_type` CHECK 时使用 `NOT VALID -> VALIDATE`，先验证已有数据。
- 新列均使用安全默认值，现有查询在旧字段为空时仍能读取。
- 初次回滚只关闭 Feature Flag 和新规则，不立即 Drop 表或字段，避免历史 Signal 失去证据。

## 8. 后端实施

### 8.1 新模块

建议增加：

```text
backend/domains/signal/keyword-normalizer.js
backend/domains/signal/keyword-matcher.js
backend/domains/whitelist/keyword-rules.js
backend/domains/whitelist/keyword-backtest.js
backend/domains/whitelist/keyword-rule-cache.js
backend/jobs/keyword-shadow-evaluator.js
```

职责边界：

- `keyword-normalizer.js`：纯函数、Unicode 标准化、长度和风险标记。
- `keyword-matcher.js`：只接受已编译规则和已验证作用域的 `authored_text`，不访问网络或数据库。
- `keyword-rules.js`：校验、冲突检查、保存、状态切换、Activation Outbox。
- `keyword-backtest.js`：扫描指定 Actor 的历史 `x_activities`，输出样本和风险。
- `keyword-rule-cache.js`：按 `actor_id + event_type` 提供不可变规则快照。
- `keyword-shadow-evaluator.js`：在全局实盘模式下独立处理 `paper` 关键词 Signal，只执行授权与风险影子判断，代码层禁止调用真实 Swap。

### 8.2 Matcher 接入

`backend/domains/signal/matcher.js` 调整为：

1. 保留完整 CA 和生态互动匹配。
2. 删除 `whitelist.symbol -> ticker_mention` 的新信号生成路径。
3. 对有正文的 Activity 获取 Actor/Event 对应关键词快照。
4. 标准化 Tweet 一次。
5. 执行三种精确匹配。
6. 与已有候选按链和 CA 合并。
7. 执行多目标和其他 CA 冲突检查。
8. 生成一条可追踪 Signal 或拒绝诊断 Signal。

同一 Activity 不得为每个关键词单独访问数据库，也不得为每个别名单独创建 Signal。

### 8.3 规则缓存和热激活

缓存结构：

```text
Map<actor_id:event_type, CompiledKeywordRule[]>
```

要求：

- 进程启动时加载所有 `ready + enabled` 规则；
- 保存规则后通过现有激活 Outbox 唤醒刷新；
- 只重建受影响 Actor/Event 的不可变快照；
- 缓存发布采用原子引用替换，不在匹配中原地修改数组；
- 缓存未就绪时新规则 fail closed，已有其他规则继续工作；
- 新增/编辑关键词规则不得把整个白名单改为不可交易；
- 规则自身显示 `syncing/failed`，不影响该白名单已有 CA 或互动触发线路；
- 服务重启后从数据库完整重建，不依赖浏览器状态。

编辑实盘规则会提升 `revision`。新版本激活期间，仅该关键词规则短暂 fail closed；其他白名单和其他触发线路不停止。

### 8.4 规则与全局运行模式

Signal 的有效执行模式取“规则模式”和“系统运行模式”中更保守的一档：

```text
signal < paper < live
effective_mode = min(rule.rollout_mode, runtime_mode)
```

因此：

- Engine 已实盘，但关键词规则是 `signal`：只记录，不交易；
- 关键词规则是 `live`，但系统处于 `signal`：仍只记录；
- 只有两者都为 `live`，且所有安全门通过，才进入实盘队列。

该规则必须在 `backend/domains/signal/queries.js` 创建 Signal 时显式生效，不能继续无条件使用全局 `getTradingMode()` 覆盖规则配置。

当前 `backend/jobs/signal-matcher.js` 只领取全局运行模式对应的 Signal。P20 必须增加独立 Shadow Worker，使 Engine 处于 `live` 时仍能领取关键词 `paper` Signal。Shadow Worker 与 Live Queue 使用不同查询条件和执行入口：

- 只领取带 `matched_keyword_rule_ids` 且 `execution_mode=paper` 的 Signal；
- 可以执行 Live Policy 镜像判断、风险检查和 `would_execute` 记录；
- 不获取钱包写通道、不创建真实 Trade Intent、不预留真实预算、不调用 GMGN Swap；
- 代码中不注入真实执行器，并以自动化测试证明无法进入 `beginSubmission()`；
- Shadow Worker 故障不阻塞 Live Queue，也不能改变 Engine Armed 状态。

## 9. Live Policy 与 P19 快路径

### 9.1 Live Policy

`backend/domains/signal/live-policy.js` 增加：

- `keywordRuleAllowsSignal()`；
- `resolveActivePolicy()` 对 `ready + enabled + live` 关键词规则的 UNION；
- `triggerAllowsSignal()` 接受 Relation、Source Rule、Keyword Rule 三种任一有效证据；
- `LIVE_EXPLICIT_TRIGGER_REQUIRED` 判断覆盖第三类规则数组。

### 9.2 最终资金写入前授权

`backend/domains/trade/trade-repository.js` 的 `beginSubmission()` 必须在现有同一事务中增加 Keyword Rule EXISTS 校验：

```text
rule id 属于 signal.whitelist_id
actor enabled
rule enabled
activation_state = ready
rollout_mode = live
event_type 被允许
revision 与 Signal 证据一致
```

该检查合并进当前授权 SQL，不新增一次数据库往返。内存缓存只负责快速预检，不能代替最终持久化授权。

### 9.3 Signal 页面授权展示

`backend/domains/system/routes.js` 当前只把 `matched_relation_ids` 当成自动授权证据，已与 Source Rule 存在展示偏差。P20 一并修复为统一判断：

```text
has relation evidence
OR has source-rule evidence
OR has keyword-rule evidence
```

页面显示实际授权类型和拒绝原因，不能出现后端可交易但页面显示不可交易，或相反的情况。

### 9.4 延迟预算

P20 不改变 P19 指标口径：

- 关键词归一化与匹配本地处理 P95 <= 5 ms；
- 1000 个已编译词条/Actor 的基准测试 P95 <= 10 ms；
- `receive_to_signal` 继续满足 P19 P95 <= 50 ms；
- 不增加 GMGN Quote、Swap、RPC 或 6551 REST 调用；
- 最终授权并入现有 SQL，目标是 0 个新增数据库 Round Trip。

Trace 增加：

```text
keyword_normalize_ms
keyword_match_ms
keyword_candidates
keyword_conflict_code
keyword_cache_revision
```

## 10. 6551 Watch Reconciler

`backend/domains/x-monitor/6551/watch-reconciler.js` 的 Desired Watch UNION 增加关键词规则：

```text
x_signal_keyword_rules
  JOIN x_kol_accounts
  JOIN ca_whitelist
  UNNEST event_types
```

只包含：

- Rule `enabled=true`；
- Activation 非 `paused/failed`；
- Actor 启用；
- 白名单未归档且未过期。

仍然遵循“一账号一个全局 Watch，权限取并集”：

- 同一账号关联 1 个或 100 个 CA，仍只有一个 Watch；
- 多个关键词不增加 Watch；
- 已有 `newTweetBol=true` 时增加 Tweet 规则成本为 0；
- 新 Actor 或新增 Quote/Reply/Retweet 权限时，先在前端展示 Watch Impact；
- Watch 同步失败时新规则保持 `syncing/failed`，已有交易规则不受影响。

## 11. 保存前历史回测

### 11.1 回测输入

```json
{
  "whitelist_id": 12,
  "actor_ids": [3, 8],
  "event_types": ["tweet"],
  "terms": [
    { "value": "PONS", "match_mode": "token_tag_exact" },
    { "value": "Pons Family", "match_mode": "phrase_normalized" }
  ]
}
```

### 11.2 回测输出

每个 Actor 和词条返回：

- 扫描的文本数量和时间范围；
- 命中次数；
- 每次命中的 Tweet ID、时间、截断原文和匹配位置；
- 是否出现其他完整 CA；
- 是否同时命中其他已配置目标；
- `text_scope_status` 和 `content_source`，旧数据范围不明时明确提示；
- 通用词、短词、跨链 Symbol 重名、不可见字符等风险标记；
- 推荐状态：`safe_candidate / review_required / blocked`。

回测结果不能只显示“通过/失败”，用户必须能看到原文样本和明确原因。

### 11.3 实盘晋级要求

规则从 `signal` 切换到 `live` 前必须满足：

1. `backtest_status=approved`；
2. 当前 `normalizer_version` 下已回测；
3. 所有历史命中样本已审核，未发现错误目标；
4. 无跨目标冲突；
5. 无其他 CA 冲突未处理记录；
6. Watch 已满足所需事件权限；
7. Rule Cache 已激活；
8. 白名单本身为 `live_ready`；
9. 用户在紧凑确认框中显式确认该规则进入实盘。

此外，规则必须观察到新版 Ingestion 产生的 `text_scope_status=verified` 事件；旧 `tweet_text` 样本只能辅助审核，不能独立解除实盘安全门。

历史样本为 0 不代表安全。此类规则先运行“仅记录”或“影子验证”，不能直接因“零误报”进入实盘。

## 12. API 设计

新增接口建议：

```text
POST   /api/whitelist/:id/keyword-rules/preview
GET    /api/whitelist/:id/keyword-rules
POST   /api/whitelist/:id/keyword-rules
PUT    /api/whitelist/:id/keyword-rules/:ruleId
PATCH  /api/whitelist/:id/keyword-rules/:ruleId/mode
DELETE /api/whitelist/:id/keyword-rules/:ruleId
POST   /api/whitelist/:id/keyword-rules/:ruleId/retry-activation
```

`preview` 同时返回：

- 标准化预览；
- GMGN 元数据建议词，但不自动勾选；
- 历史回测；
- 冲突检查；
- 6551 Watch Impact；
- 是否具备保存为 signal/paper/live 的资格。

服务端必须重新计算所有结果，不能信任前端提交的 `normalized_value`、回测状态、Watch 状态或 Live 资格。

## 13. 前端交互方案

### 13.1 页面分区

在白名单工作区的“X 触发”步骤中保持三个明确分区，不混成一张长表单：

```text
1. 完整 CA 来源
2. 生态账号互动
3. 关键词触发
```

每个分区默认只显示摘要和启用数量，展开后编辑。关键词区摘要示例：

```text
关键词触发  3 个账号 / 7 个词条
仅记录 2  |  影子 1  |  实盘 0
```

### 13.2 新增规则的最短流程

1. 当前白名单的链、Logo、Symbol 和 CA 固定显示，不重复填写。
2. 从 KOL/生态账号库多选来源账号，可按当前链、跨链、全部和分类标签筛选。
3. 系统展示 GMGN Name/Symbol 建议：`$SYMBOL`、`#SYMBOL`、完整 Name；默认不勾选。
4. 用户选择词条及模式，可新增手工完整短语。
5. 点击“预览命中”，展示历史原文、冲突和 Watch 成本。
6. 点击“保存为仅记录”。
7. 规则在列表中显示 `同步中 -> 已就绪` 或具体失败原因。
8. 后续单独执行“影子验证”或“开启实盘”，不要求重新填写整张白名单。

### 13.3 规则列表

使用紧凑行而不是大卡片：

| 来源账号 | 关键词 | 事件 | 回测 | 状态 | 操作 |
|---|---|---|---|---|---|
| `@theunipcs` | `$PONS`、`#PONS` | 原创 | 5 命中/0 冲突 | 仅记录·已就绪 | 编辑/停用 |

交互要求：

- 词条超过 3 个显示“+N”，点击后在 Popover 中完整查看；
- 支持多选账号批量创建相同词条，但后端仍生成独立 Actor 规则和独立回测；
- Event Types 放在“高级设置”，默认原创 Tweet；
- 危险裸词不能只显示黄色图标，必须写明“普通语义误命中”或“跨链重名”等原因；
- `syncing/failed` 提供重试，允许直接停用或删除；
- `approved/live` 的正确规则仍可停用，但 UI 不把“已核验”误当成不可移除；
- 不显示内部 6551 参数，只显示“无需新增 Watch / 新增 1 个 Watch，约 10 points / 权限更新约 10 points”。

### 13.4 Signal 页面

关键词 Signal 展示：

```text
触发：@actor 原创 Tweet
命中：$PONS（Token Tag 精确匹配）
目标：ROBINHOOD / CA...
授权：关键词规则 #12 rev.3
结果：仅记录 / 影子 / 实盘 / 已阻止
原因：KEYWORD_AMBIGUOUS 等中文解释
```

不得只显示 `ticker_mention` 或内部 ID，让用户无法知道究竟是哪一个词触发。

## 14. GMGN 与建议词的使用边界

GMGN 只参与配置期：

1. 从当前白名单 CA 获取原始 Name、Symbol 和 Logo。
2. 生成候选 Tag 和完整短语。
3. 提示链内/跨链同名风险。
4. 将本次样本统计作为风险参考。

以下行为禁止：

- GMGN Symbol 自动保存为实盘词条；
- GMGN ATH 高就降低关键词安全门；
- GMGN 请求失败就回退到模糊匹配；
- 在收到 Tweet 后等待 GMGN 确认目标再交易。

Grok 可在投研阶段解释项目账号和名称，但不得决定实时关键词是否命中，也不得进入 P19 快路径。

## 15. 可观测性与错误码

新增指标：

```text
keyword_activities_scanned_total
keyword_rules_considered_total
keyword_matches_total
keyword_signals_signal_only_total
keyword_signals_paper_total
keyword_signals_live_total
keyword_ambiguous_total
keyword_ca_conflict_total
keyword_cache_reload_total
keyword_cache_reload_failure_total
keyword_match_duration_ms
```

核心错误码：

| 错误码 | 含义 | 是否交易 |
|---|---|---|
| `KEYWORD_RULE_TARGET_CONFLICT` | 保存时与同 Actor 的其他目标冲突 | 否 |
| `KEYWORD_BACKTEST_REQUIRED` | 尚未完成当前版本回测 | 否 |
| `KEYWORD_MATCH_UNSAFE` | 短词、通用词或历史误命中风险 | 否 |
| `KEYWORD_AMBIGUOUS` | 同一 Tweet 命中多个目标 | 否 |
| `KEYWORD_CA_CONFLICT` | Tweet 出现其他完整 CA | 否 |
| `KEYWORD_RULE_NOT_READY` | Watch 或缓存尚未激活 | 否 |
| `KEYWORD_RULE_CHANGED` | 匹配后规则 Revision 已变化 | 否 |
| `KEYWORD_RULE_NOT_LIVE` | 规则只允许记录或影子验证 | 否 |
| `KEYWORD_TEXT_SCOPE_UNVERIFIED` | 无法确认正文是否由 Actor 自己发布 | 否 |

日志不得记录 API Key、完整签名、私钥、钱包敏感响应或包含鉴权参数的 URL。Tweet 原文在普通日志中只输出截断摘要，完整文本继续使用现有受控数据库记录。

## 16. 自动化测试矩阵

### 16.1 Normalizer

- NFKC 全角/半角一致。
- 零宽和方向控制字符删除。
- 中文逗号、英文逗号、空格和换行的短语归一一致。
- 日文、韩文、组合字符稳定。
- 拉丁/西里尔易混淆字符不自动合并。
- 不同 `normalizer_version` 不静默复用旧回测。
- URL、Profile、引用正文和链接预览不进入 `authored_text`。
- Quote/Reply 无法分离作者正文时 fail closed。
- 旧 Activity 保持 `text_scope_status=unknown`，不被自动提升为可信正文。

### 16.2 Matcher

- `$PONS/#PONS` 命中，裸 `PONS` 不命中 Tag 模式。
- `ANSEM` 不命中 `ANSEMX`。
- Word 模式不吞掉 `$`/`#` Tag。
- 完整中文短语允许标点变化，不允许子串 `币有`。
- Actor 不同不命中。
- Event Type 未授权不命中。
- 多别名同 CA 只生成一条 Signal。
- CA、互动和关键词同时命中同 CA 只生成一条 Signal。
- 同 Tweet 多 CA 目标全部拒绝。
- 其他完整 CA 冲突全部拒绝。
- 重放同一 Provider Event 不重复创建 Signal。

### 16.3 数据库与服务

- Migration 从空库 `000 -> 028` 全量通过。
- 从当前生产 Schema `027 -> 028` 通过。
- 不回填隐式 Symbol 规则。
- Actor 事务锁阻止并发创建冲突规则。
- 白名单归档后规则立即失效，已有 Signal 仍通过 Evidence Snapshot 可解释；不对有历史 Signal 的白名单执行物理删除。
- 保存、编辑、暂停、删除、重试激活幂等。
- 前端提交伪造回测通过状态时服务端拒绝。

### 16.4 Watch

- 已有 Tweet Watch 增加关键词预计 0 points。
- 多规则同 Actor 仍只有一个 Watch。
- Event 权限取并集。
- Watch 同步失败只阻止新规则，不暂停其他交易。
- 删除最后一个需求后才删除 XBOT 托管 Watch。
- Unmanaged Watch 冲突仍要求 Adopt，不擅自删除重建。

### 16.5 Live Policy 与资金门

- Signal/Paper 规则永不进入真实交易。
- Live 规则必须带 `matched_keyword_rule_ids`。
- Rule Disabled、Revision 变化、Event 变化均在 Swap 前拒绝。
- `beginSubmission()` 在同一事务校验，无新增 DB Round Trip。
- 现有 Relation 和 Source Rule 行为不回归。
- Engine Disarmed、Emergency Stop、Chain Circuit、预算、重复买入与离场策略继续生效。

### 16.6 前端

- 桌面和移动视口无横向溢出、遮挡和巨型长弹窗。
- 账号多选、搜索、分类、全选当前筛选结果可用。
- 三个触发分区视觉和语义清楚。
- 词条超过 3 个不撑高主页面。
- 回测失败显示明确阶段、错误码和原因。
- Logo、Name、Symbol 和 CA 在保存后仍正确显示。

### 16.7 性能

- 100、500、1000 词条/Actor 基准测试。
- 100 条连续 WSS Activity 下无事件循环长阻塞。
- Keyword Cache 刷新与 Matcher 并发时无部分状态。
- P19 Trace 对比开启前后 `receive_to_signal` P50/P95。

## 17. 分阶段实施

### P20.0：基线冻结与只读审计

1. 核对 GitHub、生产 `/opt/xbot`、本地备份提交号。
2. 读取实时 Engine、Position、Attempt、Watch 和数据库 Migration 状态。
3. 统计历史 `ticker_mention`，确认是否有任何实盘行为依赖旧隐式 Symbol。
4. 导出 Schema 与配置备份，不导出 API Key 到 Git。
5. 此阶段不改代码、不 Disarm、不部署。

退出条件：明确旧 Symbol 路径的实际依赖和生产基线。

### P20.1：Schema 与领域模块，Feature Flag 关闭

1. 增加 Migration 028。
2. 实现 Normalizer、Matcher、规则服务和回测服务。
3. 增加 API 和自动化测试。
4. 增加全局开关：

```text
KEYWORD_SIGNAL_ENABLED=false
KEYWORD_LIVE_ENABLED=false
```

5. 部署后保持功能关闭，验证现有实盘行为不变。

退出条件：完整测试通过，零规则、零新 Signal、现有交易链路无回归。

### P20.2：前端与仅记录模式

1. 上线关键词配置区和回测预览。
2. 只允许保存 `rollout_mode=signal`。
3. 启用 Watch Impact 和 Rule Cache。
4. 禁用旧隐式 Symbol 新匹配，但保留历史展示。
5. 观察至少一个完整业务周期的误命中、冲突和延迟。

退出条件：所有命中均可解释，零自动交易，P19 延迟不退化。

### P20.3：影子验证

1. 允许规则切换 `paper`。
2. 运行 Live Policy 和风险判断，但不调用真实 Swap。
3. 对每条 `would_execute` 人工核对 Tweet、目标 CA 和阻止原因。
4. 通用裸词和零历史样本规则继续禁止实盘。

退出条件：选定规则连续观察无误报，无 Watch/缓存异常，无多目标漏拦截。

### P20.4：单规则限时实盘灰度

1. 进入维护窗口前确认无 uncertain Attempt、无钱包隔离、持仓均受保护。
2. 只选一个 Actor、一个关键词规则、一个白名单。
3. 使用现有最小单笔金额和累计上限，不提高预算。
4. 显式开启 `KEYWORD_LIVE_ENABLED`，用户批准限时验收后 Arm。
5. 实时观察 Source -> Signal -> Submit -> Chain Trace。
6. 任一歧义、其他 CA、Revision、Watch 或缓存异常立即 fail closed。

退出条件：真实 Signal 目标正确、只交易一次、最终授权证据完整、持仓保护策略正常。

### P20.5：逐 Actor 放量

1. 每次只增加已审核 Actor/规则。
2. 不按“全链所有热门 Symbol”批量开启。
3. 24 小时复核误报率、冲突率、延迟和 6551 用量。
4. 达到验收标准后才标记 P20 完成。

## 18. 部署与回滚

### 18.1 部署原则

- 后端更新需要重启相关服务，必须遵守 P19 的维护窗口要求。
- 部署前 Disarm；部署后默认保持 Disarmed。
- Migration 不自动创建规则、不自动切 Live、不自动 Arm。
- 先部署兼容 Schema，再部署代码，再部署前端。
- GitHub 发布提交、服务器代码和生产前端资产必须一致。
- `.env`、API Key、Root 密码、私钥、钱包凭证和数据库备份不得进入 Git。

### 18.2 快速回滚

按风险从低到高：

1. 将具体 Rule 切到 `paused`。
2. 设置 `KEYWORD_LIVE_ENABLED=false`，保留仅记录能力。
3. 设置 `KEYWORD_SIGNAL_ENABLED=false`，完全跳过关键词 Matcher。
4. 回滚应用代码到上一发布提交，新表和字段保留兼容。
5. 只有确认没有历史 Signal 依赖后，才在后续维护版本中考虑 Drop 新 Schema。

任何回滚都不得自动恢复 Engine Armed 状态。

## 19. 验收标准

### 19.1 功能正确性

- 指定 Actor 的明确 Tag、完整词和完整短语按规则命中。
- 其他 Actor、其他事件、子串、通用语义不误触发。
- 多目标和其他 CA 冲突 100% 阻止。
- 多别名、多线路同目标 100% 去重。
- Signal 页面能解释 Actor、词条、模式、目标、规则版本和结果。

### 19.2 资金安全

- 没有显式 Keyword Rule ID 的 Signal 不可实盘。
- Signal/Paper Rule 不可实盘。
- Backtest 未批准、Watch 未就绪、缓存未激活、Revision 变化均不可实盘。
- 最终资金门继续校验 Engine、Live Policy、Chain Approval、Circuit、预算和钱包状态。
- 部署、Migration、规则保存和 Watch 同步均不会自动 Arm。

### 19.3 性能与可靠性

- Keyword 本地匹配 P95 <= 5 ms，1000 词条压力 P95 <= 10 ms。
- P19 `receive_to_signal` P95 继续 <= 50 ms。
- 匹配热路径外部 API 调用数为 0。
- 已有账号新增关键词的 6551 Watch 点数增量为 0。
- 新规则激活失败不暂停其他白名单或其他触发线路。
- 服务重启后缓存可从数据库恢复，状态可观测并可重试。

### 19.4 发布退出标准

以下全部满足后，P20 才能标记完成：

1. 后端完整测试、前端构建和 DOM 冒烟通过。
2. Migration `000 -> 028` 与 `027 -> 028` 均通过。
3. Signal-only 与 Paper 阶段无错误目标。
4. 单规则真实验收成功，链上 Receipt 和保护策略完整。
5. 24 小时观测无新增安全告警。
6. GitHub、生产服务器和本地备份提交一致。
7. 用户明确批准从灰度进入正式运行。

## 20. 预计改动清单

数据库：

```text
backend/db/migrations/028_p20_account_scoped_keyword_signals.sql
```

后端重点文件：

```text
backend/domains/signal/matcher.js
backend/domains/signal/queries.js
backend/domains/signal/live-policy.js
backend/domains/trade/trade-repository.js
backend/domains/system/routes.js
backend/domains/x-monitor/6551/watch-reconciler.js
backend/domains/whitelist/routes.js
backend/domains/whitelist/service.js
backend/domains/whitelist/activation-outbox.js
backend/domains/research/sanitizers.js
```

后端新增模块与测试：

```text
backend/domains/signal/keyword-normalizer.js
backend/domains/signal/keyword-matcher.js
backend/domains/whitelist/keyword-rules.js
backend/domains/whitelist/keyword-backtest.js
backend/domains/whitelist/keyword-rule-cache.js
backend/jobs/keyword-shadow-evaluator.js
backend/tests/keyword-normalizer.test.js
backend/tests/keyword-matcher.test.js
backend/tests/keyword-rules.test.js
backend/tests/keyword-live-policy.test.js
backend/tests/keyword-watch-reconciler.test.js
backend/tests/keyword-performance.test.js
```

前端重点文件：

```text
frontend/src/lib/api.ts
frontend/src/lib/types.ts
frontend/src/lib/display-labels.ts
frontend/src/pages/whitelist/AccountRulesStep.tsx
frontend/src/pages/whitelist/WhitelistWorkspace.tsx
frontend/src/pages/SignalsPage.tsx
frontend/src/index.css
```

建议把关键词编辑区拆为独立 `KeywordRulesSection.tsx`，避免继续增大当前 `AccountRulesStep.tsx`。

## 21. 审核决策

建议按以下口径批准 P20：

1. 关键词是独立第三条线路，不修改 P16 的 `ca_only` 语义。
2. 关键词必须绑定 Actor、事件类型、固定链和固定 CA。
3. 默认原创 Tweet、默认仅记录、默认不自动实盘。
4. 英文优先 `$SYMBOL/#SYMBOL`，中文优先完整项目短语；裸 Symbol 不是默认方案。
5. 历史回测、运行时歧义拦截和最终提交前 Rule 复核缺一不可。
6. GMGN/Grok 只提供配置期建议，不进入实时交易路径。
7. 新规则按自身状态热激活，不暂停其他已经正常运行的交易。
8. P20 分 Signal-only、Paper、单规则实盘和逐步放量实施，任何阶段都不自动 Arm。

本文审核通过后，先执行 P20.0 生产只读审计，再决定是否进入 P20.1；不得把整份方案一次性直接部署到正在 Armed 的生产服务。
