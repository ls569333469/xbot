# GMGN OpenAPI

[English](Home) | 简体中文

使用 GMGN Agent Skills，你可以通过 AI Agent 实时查询多个链上热门代币排行榜、代币基础信息、社交媒体信息、实时交易动态、实时战壕新币、Top 持仓大户、Top 交易大户、聪明钱持仓占比、KOL 持仓占比、老鼠仓持仓、捆绑持仓占比等代币专业数据，以及支持市价单、限价单、高级止盈止损策略单、一键 Cooking 策略单（买入 + 条件单一体化），和钱包资产管理——包括实时持仓、最近盈亏、交易动态——全部通过自然语言即可完成。

使用方式，在 AI Agent 中运行以下命令安装：

```bash
npx skills add GMGNAI/gmgn-skills
```

然后直接向 AI Agent 发送自然语言，例如：

```
帮我查一下 Solana 最近 1 小时热门代币排行。
```

详细的请求参数与 CLI 选项，请参考下面 gmgn-skills 仓库中的 skill.md 文档。

---

## 文档目录

| 页面 | 说明 |
| --- | --- |
| [概览](https://github.com/GMGNAI/gmgn-skills/blob/main/Readme.md) | 安装方式、API Key 申请与配置、支持链、升级说明 |
| [交易接口](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-swap/SKILL.md) | **市价单**：支持单钱包与多钱包（最多 100 个）并发交易，各钱包独立执行互不影响；**限价单**：指定价格触发买入或卖出；**追踪止盈止损**：价格到达目标位后自动跟随价格峰值，回撤达到设定比例才触发，骑满行情同时锁住利润；支持同一笔买入同时挂多档止盈 + 止损，一键构建完整离场策略 |
| [市场数据](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-market/SKILL.md#market-trending-options) | 热门代币排行榜，支持多维过滤与排序（1m / 5m / 1h / 6h / 24h） |
| [战壕接口](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-market/SKILL.md#market-trenches-parameters) | 查询战壕新币（内盘新创建、即将打满、已开外盘），支持按发射台、Dev 持仓、聪明钱入场、老鼠仓占比等条件过滤 |
| [Token 接口](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-token/SKILL.md) | 查询 Token 基础信息（价格、供应量、持有人、社媒链接、风险评分）、主池子详情、安全信息（蜜罐、税率、锁仓状态）、Top 持有人与 Top 交易者 |
| [K 线数据](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-market/SKILL.md#market-kline-parameters) | Token K 线（OHLCV）数据，支持 1m / 5m / 15m / 1h / 4h / 1d 粒度 |
| [Cooking 接口](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-cooking/SKILL.md) | 一键买入 + 止盈止损条件单一体化，一条命令完成建仓与离场策略配置 |
| [用户接口](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-portfolio/SKILL.md) | 查询绑定钱包列表及余额、全量 Token 持仓与 PnL 统计、交易活动记录、钱包统计数据、单 Token 余额查询 |
| [追踪接口](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-track/SKILL.md) | 实时查询关注钱包的交易动态、KOL 交易记录、聪明钱交易记录，支持多链 |
