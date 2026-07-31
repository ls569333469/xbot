# 高权重账号发帖与喊单回测报告

> 状态：技术投研记录，尚未实施。测试日期：2026-07-31。
>
> 研究账号：`@cz_binance`、`@cryptogle`、`@vladtenev`、`@theunipcs`。
>
> 本文只记录历史内容分类、CA 核验和 GMGN 回测结果，不修改业务代码、不部署服务器、不改变 Engine 状态，也不授权任何真实交易。

## 1. 结论

“高权重账号发帖 -> 精确词条或 CA -> 固定 Token”可以成为独立信号线路，但不能实现为“帖子出现 Symbol 就自动买入”。

本轮数据支持以下结论：

1. 信号质量是 `Actor + Token` 级别的，不是账号级别或 Symbol 级别的。
2. 同一账号会在同一帖子中同时写看多对象、比较对象、市场背景和负面对象。
3. 首次出现的新 Token 或新 CA 必须进入投研，不能直接实盘；`@vladtenev` 被盗号发布 `$VLAD` 是确定性反例。
4. CA 必须在配置时固定。运行时用 Grok 搜索 CA 太慢、太贵，也无法进入交易热路径。
5. 重复喊单必须受持仓状态、冷却时间和累计金额上限约束。`@theunipcs` 在样本内提到 `$USELESS` 25 次，不能产生 25 次无条件买入。
6. 本轮首次有效信号的即时收益并不突出：`5m` 中位数 `-0.38%`，`1h` 中位数 `-0.78%`；`6h/24h` 才转为小幅正中位数。
7. 截至核对时只有 `2/13` 条首次有效信号仍为正收益，说明离场策略比“是否曾出现过高点”更重要。

## 2. 测试流程

```text
6551 拉取四个账号近期最多 100 条内容
  -> 只保留来源账号顶层内容
  -> 本地剔除 Retweet
  -> 提取 Cashtag、Hashtag、完整 CA 和自然语言项目名
  -> Grok 按每个资产独立分类意图
  -> 排除比较、新闻、负面、股票、原生资产和歧义映射
  -> 通过官方来源确定 chain + CA
  -> GMGN 再次核验名称、Symbol 和 CA
  -> 回测每个 Actor-Token 的首次有效信号
```

意图分类：

| 意图 | 是否进入首次有效信号候选 |
|---|---|
| `explicit_buy` | 是 |
| `holding_conviction` | 是 |
| `bullish_thesis` | 是，仍需该 Actor-Token 规则单独审核 |
| `price_target` | 是 |
| `comparison_reference` | 否 |
| `neutral_news` | 否 |
| `negative` | 否 |
| `unclear` | 否 |

## 3. 6551 数据覆盖

6551 接口即使传入 `includeRetweets=false`，仍然返回了 Retweet。生产实现不能只信任请求参数，必须依据顶层 `retweetedStatus/isRetweet` 再过滤一次。

| 账号 | Provider 返回 | 清洗后 | Retweet | 原创正文 | 含显式 Tag/CA 的候选帖 | 覆盖时间 |
|---|---:|---:|---:|---:|---:|---|
| `@cz_binance` | 100 | 100 | 72 | 28 | 0 | 2026-05-08 至 2026-07-30 |
| `@cryptogle` | 100 | 100 | 62 | 38 | 21 | 2026-07-06 至 2026-07-31 |
| `@vladtenev` | 100 | 99 | 8 | 91 | 2 | 2026-01-28 至 2026-07-30 |
| `@theunipcs` | 100 | 99 | 38 | 61 | 33 | 2026-06-17 至 2026-07-30 |
| 合计 | 400 | 398 | 180 | 218 | 56 | 各账号窗口不同 |

由于每个账号都只拉取“最新 100 条 Provider 结果”，Retweet 比例不同会导致原创覆盖时间不一致。本轮适合验证规则和误报，不能用于四个账号之间的严格收益排名。

## 4. 内容分类结果

| 账号 | 资产级提及 | Grok 初筛看多/持仓 | 初筛资产数 | 最终可映射 Actor-Token | 最终处理 |
|---|---:|---:|---:|---:|---|
| `@cz_binance` | 2 | 2 | 1 | 0 | Bitcoin 无 XBOT 支持链和固定 CA |
| `@cryptogle` | 48 | 25 | 9 | 7 | 进入 GMGN 回测 |
| `@vladtenev` | 2 | 1 | 1 | 0 | `$VLAD` 为盗号诈骗帖，硬拒绝 |
| `@theunipcs` | 135 | 38 | 8 | 6 | 进入 GMGN 回测 |
| 合计 | 187 | 66 | 19（账号内去重） | 13 | 11 个唯一 CA |

“初筛看多”只是离线语义分类，不是实盘授权。最终映射还必须通过链、CA、账号安全和系统支持范围检查。

## 5. Actor-Token 精度样本

### 5.1 `@theunipcs`

| Token | 样本提及 | 直接看多/买入/持仓 | 比例 | 结论 |
|---|---:|---:|---:|---|
| `$USELESS` | 25 | 25 | 100% | 高一致性规则候选 |
| `$PONS` | 3 | 3 | 100% | 高一致性规则候选，但样本小 |
| `$FARTCOIN` | 7 | 3 | 42.9% | 多数是比较对象，不能裸匹配实盘 |
| `$BONK` | 4 | 1 | 25% | 多数是历史或比较引用 |
| `$ANSEM` | 10 | 0 | 0% | 明确是流动性/板块催化剂；作者还声明未持有 |
| `$DOGE` | 12 | 0 | 0% | 全部是 `$USELESS` 的比较基准 |
| `$SHIB` | 10 | 0 | 0% | 全部是历史或比较基准 |

这组数据直接证明：即使全部使用 `$SYMBOL` Cashtag 精确匹配，也会出现大量语义误报。

### 5.2 `@cryptogle`

| Token | 样本提及 | 直接看多/买入/持仓 | 比例 | 结论 |
|---|---:|---:|---:|---|
| `$LIT` | 6 | 6 | 100% | 高一致性规则候选 |
| `$INDEX` | 2 | 2 | 100% | 高一致性但样本很小 |
| `$PONS` | 12 | 9 | 75% | 有新闻和模糊提及，先记录/模拟 |
| `AOL` | 3 | 2 | 66.7% | 有完整 CA，仍存在普通社区内容 |
| `$BONK` | 5 | 2 | 40% | 历史比较多于当前看多 |
| `$ARB` | 2 | 1 | 50% | 一条是中性协议收入新闻 |
| `$CASHCAT` | 1 | 0 | 0% | 明确讲清算风险且作者做空获利 |

### 5.3 `@cz_binance`

- 28 条原创样本中没有 Cashtag、Hashtag 或完整 CA。
- 两条自然语言 `Bitcoin` 内容均为看多语境。
- XBOT 当前白名单交易链路要求固定链和 CA，Bitcoin 不能映射为本系统的 Token 白名单，因此没有进入 GMGN Token 回测。

### 5.4 `@vladtenev`

- `$SPCX` 是股票 IPO 内容，不属于本系统 Token 信号。
- `2026-07-23` 的 `$VLAD` 帖子包含完整 Robinhood CA，单看帖子会被识别为强推广。
- `2026-07-28`，Vlad 本人明确说明账号此前被攻破，攻击者发布了虚假 Meme 内容。
- 因此 `$VLAD` 必须标记为 `ACCOUNT_COMPROMISE_REJECTED`，不能因为存在完整 CA 而绕过安全门。

## 6. 最终核验的 CA

| Symbol | 链 | CA | 核验来源 |
|---|---|---|---|
| `LIT` | Ethereum | `0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2` | 原帖完整 CA + GMGN |
| `AOL` | Solana | `2oQNkePakuPbHzrVVkQ875WHeewLHCd2cAwfwiLQbonk` | 原帖完整 CA + GMGN |
| `PONS` | Robinhood | `0x39dbed3a2bd333467115de45665cc57f813c4571` | `@ponsdotfamily` + GMGN |
| `INDEX` | Robinhood | `0x56910d4409f3a0c78c64dd8d0545ff0705389870` | `@TheIndexFi` + GMGN |
| `ARB` | Ethereum | `0xb50721bcf8d664c30412cfbc6cf7a15145234ad1` | 同一 Actor 早期完整 CA 帖 + GMGN |
| `ENA` | Ethereum | `0x57e114b691db790c35207b2e685d4a43181e6061` | GMGN 官方元数据 |
| `USELESS` | Solana | `Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk` | 官方项目 X + GMGN |
| `FARTCOIN` | Solana | `9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump` | 官方交易平台公告 + GMGN |
| `PIPPIN` | Solana | `Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump` | 官方项目 X + GMGN |
| `POPCAT` | Solana | `7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr` | 官方交易平台公告 + GMGN |
| `BONK` | Solana | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | 官方交易平台公告 + GMGN |

硬拒绝的映射：

| 内容 | 原因 |
|---|---|
| `$ZRO` | GMGN 同时存在 Ethereum/Base 映射，原帖未指定链 |
| `up-2:native` | 不属于 XBOT 支持链；不能误配为 Base 上同名 `$UP` |
| `$SOL` | 原生资产，没有本轮白名单所需 Token CA |
| `$FLOKI` | 官方同时存在 Ethereum/BSC 合约，原帖未指定链 |
| `$VLAD` | 完整 CA 来自账号被盗后的诈骗帖 |

## 7. GMGN 回测口径

核对时间：`2026-07-31 13:26:01 +08:00`。

```text
t0 = 首次被判定为 explicit_buy / holding_conviction / bullish_thesis / price_target 的帖子时间
entry = GMGN 中 time >= t0 的第一根可用 1m K 线 open
5m/15m/1h = 对应时点之后第一根 5m K 线 open
6h/24h = 对应时点之后第一根 1h K 线 open
peak = 触发小时内 1m high 与后续 1h high 的最高值
current = 核对时 GMGN Token 当前价
```

如果首根可用 1m K 线晚于观察时点，则该时点记为 `N/A`，不能伪造为 0% 收益。

## 8. 首次有效信号回测

收益单位均为百分比；`重复`是样本窗口内该 Actor 对该 Token 的直接信号次数。

| Actor | Token | 重复 | 首根 1m 延迟 | 5m | 15m | 1h | 6h | 24h | 后续最高 | 核对时 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `cryptogle` | LIT | 6 | 237s | -0.80 | -0.92 | +0.69 | -3.11 | -3.48 | +4.95 | -16.00 |
| `cryptogle` | AOL | 2 | 2180s | N/A | N/A | N/A | +3.20 | +1.35 | +49.18 | -5.08 |
| `cryptogle` | PONS | 9 | 19s | +5.52 | +0.71 | -1.18 | +51.59 | +910.75 | +10443.71 | +5629.40 |
| `cryptogle` | BONK | 2 | 23s | -0.60 | +0.44 | -0.86 | -1.40 | -7.88 | +3.25 | -18.35 |
| `cryptogle` | INDEX | 2 | 32s | -0.06 | -0.74 | -5.10 | -8.09 | -25.22 | +17.21 | -43.43 |
| `cryptogle` | ARB | 1 | 1160s | N/A | N/A | -0.03 | -1.28 | -3.94 | +15.16 | -17.88 |
| `cryptogle` | ENA | 1 | 260s | -0.19 | -0.01 | +0.39 | -1.67 | -2.83 | +16.07 | +0.18 |
| `theunipcs` | USELESS | 25 | 7s | -0.38 | +0.77 | -0.10 | +3.84 | +13.52 | +49.29 | -22.71 |
| `theunipcs` | FARTCOIN | 3 | 11s | -0.41 | +0.30 | +0.66 | +6.28 | +9.22 | +13.81 | -21.81 |
| `theunipcs` | PIPPIN | 1 | 11s | -1.61 | +0.46 | -3.06 | +2.83 | +3.59 | +13.77 | -26.13 |
| `theunipcs` | POPCAT | 1 | 11s | -2.39 | -2.55 | -4.61 | +1.88 | +11.33 | +11.51 | -10.75 |
| `theunipcs` | BONK | 1 | 26s | -0.06 | -0.21 | -0.71 | +1.02 | +9.14 | +15.03 | -36.49 |
| `theunipcs` | PONS | 3 | 2s | +1.69 | -3.32 | -4.06 | +1.96 | -3.16 | +80.12 | -2.12 |

`PONS` 的早期 `cryptogle` 信号是极端离群值：24 小时约 `+910.75%`，后续最高约 `+10443.71%`。它证明早期内容信号可能有巨大价值，但不能用一个样本推导整体胜率，也不能用平均收益代表策略表现。

### 8.1 触发时估算 FDV

GMGN Token Info 当前没有直接返回这些历史时点的 `market_cap`。下表使用：

```text
触发时估算 FDV = 首根可用 1m K 线开盘价 × GMGN 当前 total_supply
```

对接近全流通、供应量稳定的 Meme Token，该值可近似观察触发时市值量级；对存在解锁、持续销毁或跨链供应的 Token，不能把它当作精确历史流通市值。

| Actor | Token | 触发时估算 FDV | 观察 |
|---|---|---:|---|
| `cryptogle` | PONS | $0.64M | 典型极早期低市值信号 |
| `cryptogle` | AOL | $1.07M | 低市值且 K 线稀疏 |
| `cryptogle` | INDEX | $18.93M | Robinhood 中小市值项目 |
| `cryptogle` | ARB | $19.89M | 仅代表 Ethereum 合约本地供应，不能代表 ARB 全局市值 |
| `theunipcs` | PIPPIN | $21.26M | 中小市值 Meme |
| `theunipcs` | PONS | $37.35M | 同一 PONS 已比 cryptogle 首次信号高约 58.5 倍 |
| `theunipcs` | POPCAT | $46.84M | 中小市值 Meme |
| `theunipcs` | USELESS | $68.17M | 已有一定规模，不属于极早期微盘 |
| `theunipcs` | FARTCOIN | $156.24M | 中等市值 Meme |
| `cryptogle` | BONK | $308.34M | 成熟 Meme，不是低市值新币 |
| `theunipcs` | BONK | $396.38M | 成熟 Meme，且比 cryptogle 信号更晚 |
| `cryptogle` | ENA | $1.21B | 估算 FDV；实际流通市值受解锁影响 |
| `cryptogle` | LIT | $2.66B | 估算 FDV；不属于低市值 Token |

市值维度解释了同一个 Token 的巨大结果差异：`cryptogle` 在 PONS 约 `$0.64M` 量级时出现首次有效信号，后续最高约 `+10443.71%`；`theunipcs` 首次明确发帖时估算已约 `$37.35M`，后续最高约 `+80.12%`。账号相同与否不是唯一变量，**信号发生时所处的项目阶段和市值区间更重要。**

因此保存前回测还应增加：触发时估算市值/FDV、流动性、24h 成交额、价格影响和 Token 创建时长。低市值可以提高赔率，也会同步放大滑点、池子深度不足和 Rug 风险，不能只设置市值上限而不设置最低流动性与最大 Price Impact。

## 9. 聚合结果

| 时点 | 有数据样本 | 正收益数量 | 正收益比例 | 中位数 | 平均值 | 最低 | 最高 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 5m | 11 | 2 | 18.2% | -0.38% | +0.06% | -2.39% | +5.52% |
| 15m | 11 | 5 | 45.5% | -0.01% | -0.46% | -3.32% | +0.77% |
| 1h | 12 | 3 | 25.0% | -0.78% | -1.50% | -5.10% | +0.69% |
| 6h | 13 | 8 | 61.5% | +1.88% | +4.39% | -8.09% | +51.59% |
| 24h | 13 | 7 | 53.8% | +1.35% | +70.18% | -25.22% | +910.75% |
| 后续最高 | 13 | 13 | 100% | +15.16% | +825.62% | +3.25% | +10443.71% |
| 核对时 | 13 | 2 | 15.4% | -17.88% | +416.06% | -43.43% | +5629.40% |

平均值被早期 PONS 严重扭曲。对这类长尾策略应优先看中位数、逐笔分布、最大回撤和可执行退出，不应使用平均最高收益做决策。

## 10. 数据限制

1. 这是历史模拟，不是实际成交。
2. 未扣除滑点、Gas、Price Impact、交易费和下单延迟。
3. `peak` 是事后最高价，不能证明策略能够在该位置离场。
4. 小币种 K 线存在空档。AOL、ARB 等首根 1m 数据延迟数分钟至数十分钟，不能把它解释为系统执行延迟。
5. 账号样本窗口不一致，且只覆盖 Provider 最新 100 条结果。
6. Grok 分类仍需要人工复核；例如正面介绍 Buy/Burn 机制可能被归为看多，但不等同于明确买入指令。
7. 本轮只回测每个 Actor-Token 的首次有效信号，没有模拟后续每一次加仓、冷却或持仓合并。
8. 当前收益会随核对时间变化。

## 11. Provider 用量与延迟

### 11.1 6551

- 正常批量采集：4 个账号各 100 条，共约 20 points。
- 本次实验因系统临时目录写入失败而重复拉取一次，另有一次结构检查调用；实际实验消耗约 41 points。
- 正式实现应先落盘再处理，并复用缓存，避免同一研究任务重复请求。

### 11.2 Grok 内容分类

- 四个账号内容分类合计约 `72,589` Token。
- 分类阶段不使用 `x_search`，只分析 6551 已提供的文本。
- `@theunipcs` 因一帖多资产且要求严格 JSON，需拆成小批次，整体耗时达到数分钟。

### 11.3 Grok CA 解析

- 6 个未解析 Symbol 的官方来源核验使用 `76` 次 `x_search`。
- Provider 报告总 Token 约 `1,636,452`，其中大量为缓存输入。
- 单次解析耗时约 `116.5s`。

结论：Grok 搜索只能用于异步研究或保存规则前的离线核验，不能参与 WSS 信号到下单的实时路径。

## 12. 对 P20 的直接影响

### 12.1 规则必须预绑定唯一 CA

```text
actor_handle + event_type + match_mode + normalized_term
  -> one fixed chain_id + contract_address
```

运行时不搜索 Token，不根据 Symbol 临时选择链，也不调用 Grok。

### 12.2 规则必须逐 Actor-Token 晋级

不能配置“`@theunipcs` 是高权重账号，所以他的所有 Cashtag 都可以买”。正确做法是分别审核：

```text
@theunipcs + $USELESS -> 高一致性候选
@theunipcs + $PONS    -> 高一致性但样本较小
@theunipcs + $ANSEM   -> 仅比较/板块催化，不可实盘
@theunipcs + $DOGE    -> 比较基准，不可实盘
```

### 12.3 首次出现的新 Token 必须阻断实盘

当某个 Actor 发布当前规则库中不存在的新 CA 或新 Token 时：

```text
NEW_TOKEN_BY_ACTOR
  -> 只记录
  -> 异步核验账号是否被盗
  -> 核验项目身份、链和 CA
  -> GMGN 风险检查
  -> 人工决定是否创建规则
```

该门禁可以阻断本轮 `$VLAD` 盗号诈骗样本。

### 12.4 重复信号必须受状态约束

建议至少同时检查：

- 同一 Tweet ID 幂等；
- 同一 Actor-Token 冷却时间；
- 当前是否已有仓位；
- 白名单是否允许重复买入；
- 单笔和累计资金上限；
- 上一笔是否仍在 `SUBMITTED/PENDING`；
- 同一 Token 被多个 Actor 同时命中时只生成一条资金动作。

### 12.5 分级运行

| 等级 | 条件 | 动作 |
|---|---|---|
| Research | 新 Token、歧义 Token、低历史精度 | 只投研 |
| Record | 已固定 CA，但样本不足或精度不稳定 | 记录 Signal，不交易 |
| Paper | 规则完成历史回测和冲突检查 | 模拟交易 |
| Live Candidate | 高一致性、固定 CA、Watch 就绪、资金门通过 | 仍需用户显式批准 |

## 13. 推荐下一步

1. 将本轮结果作为 P20 保存前回测的第一批真实 Fixture，但测试中只保存脱敏正文片段和公开 CA，不保存 API 响应或密钥。
2. 优先将以下规则放入“只记录”灰度：
   - `@theunipcs + $USELESS -> Solana USELESS CA`
   - `@theunipcs + $PONS -> Robinhood PONS CA`
   - `@cryptogle + $LIT -> Ethereum LIT CA`
3. 明确禁止：`@theunipcs + $ANSEM/$DOGE/$SHIB`、`@vladtenev + $VLAD`。
4. 收集更长时间窗口，并至少达到每条规则 20 条有效帖子后再讨论自动实盘精度阈值。
5. 下一次回测加入重复信号冷却、持仓合并和实际离场策略，不能继续只看事后最高价。
