-- seed.sql — 系统初始配置数据（PRD §10 完整字段）
-- 执行方式: psql -U pm_user -d xbot -f seed.sql

INSERT INTO config (key, value_json) VALUES

-- ═══ 链级配置（每链完整参数）═══
('chain_configs', '{
  "sol": {
    "enabled": true,
    "nativeSymbol": "SOL",
    "dailyBudget": 0.5,
    "weeklyBudget": 0.5,
    "maxPerTrade": 0.05,
    "maxOpenPositions": 1,
    "dailyLossLimit": 0.5,
    "defaultTpPct": 100,
    "defaultSlPct": 20,
    "defaultSlippage": 10
  },
  "bsc": {
    "enabled": true,
    "nativeSymbol": "BNB",
    "dailyBudget": 0.01,
    "weeklyBudget": 0.02,
    "maxPerTrade": 0.001,
    "maxOpenPositions": 2,
    "dailyLossLimit": 0.01,
    "defaultTpPct": 100,
    "defaultSlPct": 20,
    "defaultSlippage": 10
  },
  "base": {
    "enabled": true,
    "nativeSymbol": "ETH",
    "dailyBudget": 0.001,
    "weeklyBudget": 0.002,
    "maxPerTrade": 0.0002,
    "maxOpenPositions": 1,
    "dailyLossLimit": 0.001,
    "defaultTpPct": 100,
    "defaultSlPct": 20,
    "defaultSlippage": 10
  },
  "eth": {
    "enabled": false,
    "nativeSymbol": "ETH",
    "dailyBudget": 0.5,
    "weeklyBudget": 2,
    "maxPerTrade": 0.1,
    "maxOpenPositions": 3,
    "dailyLossLimit": 0.3,
    "defaultTpPct": 100,
    "defaultSlPct": 20,
    "defaultSlippage": 10
  },
  "robinhood": {
    "enabled": false,
    "nativeSymbol": "USD",
    "dailyBudget": 100,
    "weeklyBudget": 500,
    "maxPerTrade": 50,
    "maxOpenPositions": 3,
    "dailyLossLimit": 50,
    "defaultTpPct": 50,
    "defaultSlPct": 15,
    "defaultSlippage": 5
  }
}'),

-- ═══ 全局风控配置（24 项检查阈值）═══
('risk_config', '{
  "security_check_enabled": true,
  "max_buy_tax": 5,
  "max_sell_tax": 10,
  "max_rug_ratio": 0.3,
  "consecutive_failure_lock": 3,
  "reject_cooldown_ms": 600000,
  "min_liquidity_usd": 10000,
  "max_slippage_pct": 15,
  "consecutive_loss_limit": 5,
  "ca_cooldown_min": 30
}'),

-- ═══ X 监控配置 ═══
('x_monitor_config', '{
  "timeline_poll_interval_sec": 60,
  "follows_poll_interval_sec": 3600,
  "max_kol_per_round": 3,
  "enabled": true
}')

ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW();
