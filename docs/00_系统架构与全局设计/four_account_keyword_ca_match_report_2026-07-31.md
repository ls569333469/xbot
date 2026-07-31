# 四个高权重 X 账号关键词与 CA 匹配报告

> 时间：2026-07-31。
>
> 账号：`@cz_binance`、`@cryptogle`、`@vladtenev`、`@theunipcs`。
>
> 本报告使用 6551 和 GMGN 官方只读接口，不修改白名单、不创建 Signal 或订单、不改变 Engine。

## 1. 数据范围

每个账号通过 6551 `twitter_user_tweets` 拉取最近 100 条根级 Tweet，共 400 条。请求参数包含 Reply 和 Retweet，随后在本地按根级字段清洗，避免把 `quotedStatus`、`replyStatus` 或 `retweetedStatus` 的内嵌正文误算成 Actor 自己的喊单。

| 账号 | Provider 返回 | 非 Retweet | Retweet | 覆盖时间（Asia/Shanghai） | 含显式关键词/CA 的 Tweet |
|---|---:|---:|---:|---|---:|
| `@cz_binance` | 100 | 84 | 16 | 2026-07-14 23:01 至 2026-07-31 18:00 | 0 |
| `@cryptogle` | 100 | 82 | 18 | 2026-07-27 13:05 至 2026-07-31 14:52 | 21 |
| `@vladtenev` | 100 | 98 | 2 | 2026-06-19 07:42 至 2026-07-30 21:30 | 1 |
| `@theunipcs` | 100 | 78 | 22 | 2026-07-21 17:57 至 2026-07-31 19:27 | 27 |
| **合计** | **400** | **342** | **58** | - | **49** |

今天上午 `2026-07-31 00:00–12:00` 的严格子集：

- `@cz_binance` 4 条非 Retweet；
- `@cryptogle` 6 条非 Retweet；
- `@vladtenev` 和 `@theunipcs` 无上午样本；
- 10 条正文均未命中完整 CA、Cashtag 或 Hashtag。

因此后续统计使用四个账号最近 100 条窗口，而不是把“上午讨论的账号”误解为“只统计今天上午发出的帖子”。

## 2. 原始匹配统计

匹配规则：

- 完整 EVM/Solana CA；
- `$TOKEN` Cashtag，不区分大小写；
- `#TOKEN` Hashtag，不区分大小写；
- 只读取 Actor 根级正文，Quote/Reply 内嵌正文只作为上下文；
- 本轮不执行裸英文词、模糊词或 Grok 语义匹配。

结果：

| 指标 | 数量 |
|---|---:|
| 含显式线索的 Tweet | 49 |
| 唯一显式词条 | 30 |
| Cashtag 出现次数 | 88 |
| Hashtag 出现次数 | 0 |
| 完整 CA Tweet | 2 |

## 3. 词条频次

| 词条 | 次数 | 账号 | 初步状态 |
|---|---:|---|---|
| `PONS` | 24 | cryptogle 15；theunipcs 9 | 已确认 Robinhood CA |
| `USELESS` | 17 | theunipcs 17 | 已确认 Solana CA |
| `SHIB` | 6 | theunipcs 6 | GMGN 当前单热候选，多为比较对象 |
| `CASHCAT` | 4 | cryptogle 1；theunipcs 3 | GMGN 当前单热候选，需上下文 |
| `DOGE` | 4 | theunipcs 4 | 原生 Dogecoin/比较对象，不映射热榜包装 Token |
| `LIT` | 2 | cryptogle 2 | 已确认 Ethereum CA |
| `DAHOOD` | 2 | cryptogle 2 | GMGN 当前单热候选，需上下文 |
| `BRODIE` | 2 | theunipcs 2 | 两个 Robinhood 候选 |
| `PUMP` | 2 | theunipcs 2 | 当前热榜候选与正文语义不一致 |
| `AERO` | 2 | theunipcs 2 | 未进入当前 GMGN 热索引 |
| `LDO` | 2 | theunipcs 2 | 未进入当前 GMGN 热索引 |
| `HYPE` | 2 | theunipcs 2 | 未进入当前 GMGN 热索引 |
| `WIF` | 2 | theunipcs 2 | 未进入当前 GMGN 热索引 |
| `DICE` | 1 | cryptogle | GMGN 当前单热候选，需上下文 |
| `SLIPPY` | 1 | cryptogle | GMGN 当前单热候选，需上下文 |
| `ETH` | 1 | cryptogle | 原生资产，不生成 Token CA |
| `VLAD` | 1 | vladtenev | 原文完整 CA，但账号被盗事件硬拒绝 |
| `MARSCOIN` | 1 | theunipcs | 四个跨链候选，无法裸词消歧 |
| `JUGGERNAUT` | 1 | theunipcs | 两个 Robinhood 版本 |
| `NOXA` | 1 | theunipcs | GMGN 当前单热候选，需上下文 |
| `UNI` | 1 | theunipcs | 原文完整 Ethereum CA；正文为比较语境 |
| `FLOKI` | 1 | theunipcs | GMGN 当前单热候选；正文为历史比较 |
| `JUP` | 1 | theunipcs | 未进入当前 GMGN 热索引 |
| `RAY` | 1 | theunipcs | 未进入当前 GMGN 热索引 |
| `BONK` | 1 | theunipcs | 已确认 Solana CA；正文为历史比较 |
| `BTC` | 1 | theunipcs | 原生资产，不生成 Token CA |
| `PEPE` | 1 | theunipcs | GMGN 当前单热候选；正文为比较对象 |
| `TRUMP` | 1 | theunipcs | 未进入当前 GMGN 热索引 |
| `PENGU` | 1 | theunipcs | 未进入当前 GMGN 热索引 |
| `FARTCOIN` | 1 | theunipcs | 已确认 Solana CA；正文为比较对象 |

## 4. 已确认或有完整 CA 锚点

| Symbol | 次数 | Chain | CA | 证据与处理 |
|---|---:|---|---|---|
| `PONS` | 24 | Robinhood | `0x39dbed3a2bd333467115de45665cc57f813c4571` | 已有项目账号与 GMGN 交叉核验 |
| `USELESS` | 17 | Solana | `Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk` | 已有官方项目 X 与 GMGN 交叉核验 |
| `LIT` | 2 | Ethereum | `0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2` | 历史原帖完整 CA + GMGN |
| `BONK` | 1 | Solana | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | 已核验，但本次正文为历史比较 |
| `FARTCOIN` | 1 | Solana | `9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump` | 已核验；当前 GMGN 热榜另有同名 BSC Token，不能覆盖该映射 |
| `VLAD` | 1 | Robinhood | `0x92d176ccbeeffecd8089e841d09ea17b6c22d969` | 原文完整 CA，GMGN 返回 Vladhood/Pons；账号被盗事件，`ACCOUNT_COMPROMISE_REJECTED` |
| `UNI` | 1 | Ethereum | `0x1f9840a85d5af5bf1d1762f925bdaddc4201f984` | 原文完整 CA，GMGN 返回 Uniswap；正文为 PONS 比较材料，不是 UNI 新喊单 |

共得到 7 个有明确 CA 锚点的 Token，但其中 `VLAD` 必须安全拒绝，`BONK`、`FARTCOIN` 和 `UNI` 在本次正文中是比较/历史语境，不能仅因命中 CA 或 Cashtag 自动买入。

## 5. GMGN 当前单热候选

GMGN 五链 Rank + Hot Search 合并得到 697 个唯一 CA。以下词条当前只有一个热索引候选，但“单热候选”不等于事件级唯一正确 CA：

| Symbol | Chain | Candidate CA | GMGN 身份 | 处理 |
|---|---|---|---|---|
| `CASHCAT` | Robinhood | `0x020bfc650a365f8bb26819deaabf3e21291018b4` | Cash Cat / Noxa / `@cashcat_token` | 项目上下文一致时可继续核验 |
| `DAHOOD` | Robinhood | `0x29fbaa3668e688c83fae9b5dd13cc3cfc097ccbf` | daHood / Pons / `@daHoodfun` | 原文关联 `@daHoodfun`，候选较强 |
| `DICE` | Robinhood | `0x3f9f0b6073ee8c495aed96869af31850fed40feb` | Dice Protocol / Pons | 需要 Quote 项目身份进一步锚定 |
| `FLOKI` | Ethereum | `0xcf0c122c6b73ff809c693db761e7baebe62b6a2e` | FLOKI / `@floki` | 本次为历史周期比较，不触发买入 |
| `NOXA` | Robinhood | `0x39e0d9057bd9039cd14590f54de20b9d3457c56e` | Noxa / Noxa | 本次讨论 launchpad 历史，不触发买入 |
| `PEPE` | Ethereum | `0x6982508145454ce325ddbe47a25d4ec3d2311933` | Pepe / `@pepecoineth` | 本次为 USELESS 比较对象 |
| `SHIB` | Ethereum | `0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce` | SHIBA INU / `@shibtoken` | 6 次均主要作为 USELESS 比较基准 |
| `SLIPPY` | Robinhood | `0xf0568863195770965a6d8abb0aa87f4314b80320` | SLIPPY / Uniswap V4 | 需要项目账号/Quote 上下文复核 |

`PUMP` 的当前唯一热索引候选是 BSC `Pump CTO`：

```text
0x3008d8e5a628a2d8971d4382496960de56aeb6bc
```

但原文中的 `$PUMP` 是与 PONS、AERO、LDO、HYPE、UNI 并列的成熟项目比较语境，不能映射到该 BSC Token。该样本证明“Symbol + 当前热榜唯一候选”仍会买错。

## 6. 多候选词条

### 6.1 BRODIE

| Chain | CA | GMGN 版本 |
|---|---|---|
| Robinhood | `0xcfd6a7bde7a2e647c0e46c424f1772020ad9423a` | Robinhood Dog / Uniswap V2 |
| Robinhood | `0x45f82ac5d507e988f7406935da8eefe495a360e0` | Robinhood Dog / Pons |

只看 Symbol 无法选择；加入 `renowned_wallets >= 3` 后，第一个 2026-07-31 新出现的候选因 KOL=0 被过滤，只剩 Pons 版本。

### 6.2 JUGGERNAUT

| Chain | CA | GMGN 版本 |
|---|---|---|
| Robinhood | `0xd7321801caae694090694ff55a9323139f043b88` | The Juggernaut / Noxa |
| Robinhood | `0xaeab3067fb9c4b18a7912fe77c1fec7b1a558888` | The Juggernaut / Flap PVE |

本次正文明确讨论 Noxa 历史持仓，因此原 Noxa 版本更符合上下文。两个候选的 KOL 都大于 2，但 Noxa 版本同时是市值、流动性和 Holder 数第一；市场主导规则与正文上下文一致。

### 6.3 MARSCOIN

| Chain | CA | GMGN 版本 |
|---|---|---|
| BSC | `0xfe189e97832da1573e4e4ff034f4ffc3a15c7777` | MarsCoin / Flap |
| Robinhood | `0xd8ec6474c02e5f913a8fd566648a2df4b18dbba3` | MarsCoin / Bankr |
| Solana | `7pjoah1BbycgJffij2b58P55NiHDbMqdo7Y1Wrzxpump` | MarsCoin / Pump.fun |
| Robinhood | `0x68776f8909abc9ca4e7c834fad9de1a179d6230f` | MarsCoin / Pons |

原文写明在 FOMO 约 320 万美元市值买入、两天后上涨超过 1,000%。按 `renowned_wallets >= 3` 过滤后，Pons 小盘因 KOL=2 被过滤；剩余候选中 BSC Flap 版本同时是市值、流动性和 Holder 数第一，且当前市值约 3,370 万美元，与正文的涨幅量级吻合。

### 6.4 KOL + 市值/流动性规则回放

规则：

```text
1. 只保留 GMGN renowned_wallets >= 3 的候选
2. 分别按当前市值和流动性降序排列
3. 只有同一个 CA 同时位列两项第一才选择
4. Holder 数第一作为额外一致性证据
5. 完整 CA、平台和正文上下文冲突时，市场排名不能覆盖强锚点
```

| 词条 | 原候选 | KOL 过滤后 | 双第一结果 | KOL | 市值 | 流动性 | Holder | 回放 |
|---|---:|---:|---|---:|---:|---:|---:|---|
| `BRODIE` | 2 | 1 | `0x45f82ac5d507e988f7406935da8eefe495a360e0` | 31 | $0.82M | $114K | 3,951 | 正确 |
| `JUGGERNAUT` | 2 | 2 | `0xd7321801caae694090694ff55a9323139f043b88` | 48 | $1.50M | $164K | 9,911 | 正确，且匹配 Noxa 上下文 |
| `MARSCOIN` | 4 | 3 | `0xfe189e97832da1573e4e4ff034f4ffc3a15c7777` | 94 | $33.70M | $712K | 16,609 | 正确，且匹配正文涨幅 |
| `UNI` | 2 | 2 | `0x1f9840a85d5af5bf1d1762f925bdaddc4201f984` | 34 | $4.36B | $13.64M | 387,380 | 正确，且原文有完整 CA |

本样本回放为 `4/4`，支持把这条规则加入 Dynamic CA Resolver 的确定性候选排序。

新出现的两个低质量候选被直接过滤：

- BRODIE `0xcfd6...423a`：2026-07-31 创建，KOL=0；
- MARSCOIN `0x6877...230f`：2026-07-31 创建，KOL=2。

但 `renowned_wallets` 是 GMGN 标记的 KOL 总数，不是当前有效主动买家数。四个赢家 Top 20 KOL 中满足“主动买入、仍有余额、未完全卖出、非纯转入”的数量分别为 `4 / 0 / 9 / 2`。因此：

- **KOL 总数 >= 3**：可作为候选身份预过滤；
- **有效 KOL 买家数**：用于当前交易热度和风险，不得作为统一身份硬门槛。

## 7. 当前热索引未覆盖

`AERO`、`HYPE`、`JUP`、`LDO`、`PENGU`、`RAY`、`TRUMP`、`WIF` 没有出现在本轮 697 个 GMGN 热候选中。

这不表示 Token 不存在，只表示 Rank + Hot Search 不能完成任意 Symbol 搜索。它们在本次内容中主要是成熟项目、历史阶段或比较对象，因此不应为了补全 CA 在热路径调用 Grok 或猜测地址。

`BTC`、`ETH`、`DOGE` 是原生资产/原生链语义，本次不映射为当前 GMGN 热榜中的包装或同名 Token CA。

## 8. 账号级结论

### `@cz_binance`

- 84 条非 Retweet 中没有完整 CA、Cashtag 或 Hashtag；
- 当前只适合自然语言研究或新关注项目发现，不适合显式关键词自动交易。

### `@cryptogle`

- 21 条命中；
- `PONS` 15 次，`LIT` 2 次；
- 还出现 `CASHCAT`、`DICE`、`DAHOOD`、`SLIPPY`、`ETH`；
- PONS 重复提及很多，必须有冷却、已有持仓和累计预算限制；
- DICE/SLIPPY 等首次出现词条需要 Dynamic CA Resolver，不能直接继承 PONS 的 CA。

### `@vladtenev`

- 唯一命中是 `$VLAD + 完整 CA`；
- 该帖属于已确认的账号被盗事件；
- 证明完整 CA 是强身份锚点，但不能绕过 Actor Security State。

### `@theunipcs`

- 27 条命中；
- `USELESS` 17 次、`PONS` 9 次；
- 大量 `DOGE/SHIB/BONK/FARTCOIN/PUMP/AERO/LDO/HYPE/UNI` 是比较、历史和市场基准；
- 单纯 Cashtag 精确匹配会产生显著误报；
- 必须先做内容意图分类，再进入 CA Resolver 和资金门。

## 9. 对 P20 的验证

本轮真实数据支持 P20 v3 的以下设计：

1. Cashtag 提取很快，但只完成“观察词条”，不完成交易授权；
2. 关键词首次出现时可以动态寻找 CA，不要求预存白名单；
3. 当前热榜单候选不能直接视为唯一正确 CA；
4. 项目账号、平台、完整 CA、Quote 来源和上下文必须参与事件级消歧；
5. 多真实版本必须保留为 Asset Family / Variant；
6. 比较、历史、清仓、反向观点和账号被盗必须在资金门前阻断；
7. 同一 Actor 重复提及同一 Token 必须受冷却、持仓和累计预算约束；
8. GMGN Rank/Hot 缺失必须返回 `not_found_in_hot_index`，不能伪装为 Token 不存在。

## 10. Provider 用量

- 6551 响应结构探针：4 次，共 20 points；
- 6551 实际正文拉取：4 次，共 20 points；
- 本轮 6551 合计：40 points；
- GMGN：五链 Rank、一次 Hot Search、两次 Token Info，全部成功，无 429；
- 未调用 Grok；
- 未调用任何 GMGN 交易写接口。
