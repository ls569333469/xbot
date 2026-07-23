# GMGN OpenAPI

English | [简体中文](Home-Chinese)

With GMGN Agent Skills, you can use AI agents to query real-time trending token rankings across multiple chains, token fundamentals, social media signals, live trading activity, new tokens in Trenches, top holders, top traders, smart money positions, KOL holdings, insider wallets, bundled wallet exposure, and other professional on-chain analytics. It also supports market orders, limit orders, advanced take-profit/stop-loss strategy orders, one-command cooking orders (buy + condition orders in a single flow), and wallet management — including real-time holdings, recent P&L, and transaction history — all through natural language.

To use, run the following command in your AI agent:

```bash
npx skills add GMGNAI/gmgn-skills
```

Then send natural language prompts to your agent — for example:

```
Show me the trending tokens on Solana in the last 1 hour.
```

For detailed request parameters and CLI options, refer to the skill.md documents in the gmgn-skills repository below.

---

## Documentation

| Page | Description |
| --- | --- |
| [Overview](https://github.com/GMGNAI/gmgn-skills/blob/main/Readme.md) | Installation, API key setup, supported chains, and upgrade instructions |
| [Trade](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-swap/SKILL.md) | **Market order**: single-wallet and multi-wallet concurrent trading (up to 100 wallets), each executing independently; **Limit order**: trigger buy or sell at a specified price; **Trailing take-profit / stop-loss**: automatically tracks the price peak after target is reached — fires only after a set drawdown %, riding momentum while locking in gains; supports attaching multiple take-profit tiers + stop-loss to a single buy in one command |
| [Market Data](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-market/SKILL.md#market-trending-options) | Trending tokens with multi-dimensional filter and sort options (1m / 5m / 1h / 6h / 24h) |
| [Trenches](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-market/SKILL.md#market-trenches-parameters) | Query new tokens in the Trenches (New created, Almost bonded, Migrated) — filtered by launchpad, dev holdings, smart money entry, rat trader ratio, and more |
| [Token](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-token/SKILL.md) | Query token basic info (price, supply, holders, social links, risk scores), main pool details, security information (honeypot, taxes, lock status), top holders, and top traders |
| [K-line](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-market/SKILL.md#market-kline-parameters) | Token K-line (OHLCV) candlestick data — 1m / 5m / 15m / 1h / 4h / 1d resolution |
| [Cooking](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-cooking/SKILL.md) | One-command buy + take-profit/stop-loss condition orders in a single flow |
| [User & Wallet](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-portfolio/SKILL.md) | List bound wallets and balances, query all token holdings with PnL stats, retrieve transaction activity history, wallet performance statistics, and single token balance |
| [Track](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-track/SKILL.md) | Real-time trade activity from wallets you follow, KOL trades, and Smart Money trades across chains |
