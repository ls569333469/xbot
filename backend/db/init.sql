-- DDL for xbot backend
CREATE TABLE IF NOT EXISTS x_kol_accounts (
  id serial PRIMARY KEY,
  x_user_id text UNIQUE,
  x_handle text NOT NULL,
  display_name text,
  chain_ids text[] DEFAULT '{}',
  weight int DEFAULT 5,
  enabled boolean DEFAULT true,
  last_polled_at timestamptz,
  last_tweet_id text,
  last_follow_snapshot jsonb,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ca_whitelist (
  id serial PRIMARY KEY,
  contract_address text NOT NULL,
  chain_id text NOT NULL,
  symbol text,
  project_name text,
  project_x_handles text[] DEFAULT '{}',
  budget_per_trade numeric(18,8) NOT NULL,
  total_budget numeric(18,8) NOT NULL,
  spent_budget numeric(18,8) DEFAULT 0,
  auto_tp_pct numeric(5,2) DEFAULT 100,
  auto_sl_pct numeric(5,2) DEFAULT 20,
  slippage numeric(5,2) DEFAULT 10,
  allow_repeat_buy boolean DEFAULT false,
  max_repeat_buys int DEFAULT 1,
  current_buy_count int DEFAULT 0,
  status text DEFAULT 'active' CHECK(status IN('active','paused','exhausted','expired')),
  source text DEFAULT 'manual' CHECK(source IN('manual','semi-auto')),
  expires_at timestamptz,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelist_ca_chain_active ON ca_whitelist(contract_address, chain_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS x_activities (
  id serial PRIMARY KEY,
  kol_id int NOT NULL REFERENCES x_kol_accounts(id),
  kol_handle text NOT NULL,
  activity_type text NOT NULL CHECK(activity_type IN('tweet','retweet','quote','reply','follow')),
  tweet_id text,
  tweet_text text,
  target_x_handle text,
  extracted_cas text[] DEFAULT '{}',
  extracted_tickers text[] DEFAULT '{}',
  raw_json jsonb,
  processed boolean DEFAULT false,
  created_at timestamptz DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trade_signals (
  id serial PRIMARY KEY,
  activity_id int NOT NULL REFERENCES x_activities(id),
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id),
  kol_id int NOT NULL REFERENCES x_kol_accounts(id),
  kol_handle text NOT NULL,
  signal_type text NOT NULL CHECK(signal_type IN('handle_match','ca_mention','ticker_mention')),
  match_detail text,
  kol_weight int DEFAULT 5,
  risk_check jsonb DEFAULT '{}',
  status text DEFAULT 'recorded' CHECK(status IN('recorded','pending','approved','rejected','executed','expired')),
  reject_reason text,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),
  UNIQUE(activity_id, whitelist_id, signal_type)
);

CREATE TABLE IF NOT EXISTS positions (
  id serial PRIMARY KEY,
  signal_id int REFERENCES trade_signals(id) UNIQUE,
  whitelist_id int REFERENCES ca_whitelist(id),
  contract_address text NOT NULL,
  chain_id text NOT NULL,
  symbol text,
  amount_in numeric(18,8),
  amount_out numeric(18,8),
  entry_price numeric(24,12),
  buy_tx_hash text,
  buy_order_id text,
  sell_tx_hash text,
  tp_pct numeric(5,2),
  sl_pct numeric(5,2),
  tp_order_id text,
  sl_order_id text,
  tpsl_status text DEFAULT 'pending' CHECK(tpsl_status IN('pending','ok','partial','failed')),
  exit_price numeric(24,12),
  pnl numeric(18,8),
  pnl_pct numeric(8,2),
  sim_peaks jsonb DEFAULT '{}',
  status text DEFAULT 'pending' CHECK(status IN('pending','open','tp_hit','sl_hit','manual_close','failed')),
  opened_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_tracking (
  id serial PRIMARY KEY,
  chain_id text NOT NULL,
  period_type text NOT NULL CHECK(period_type IN('daily','weekly')),
  period_key text NOT NULL,
  spent numeric(18,8) DEFAULT 0,
  budget_limit numeric(18,8) NOT NULL,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),
  UNIQUE(chain_id, period_type, period_key)
);

CREATE TABLE IF NOT EXISTS config (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL,
  updated_at timestamptz DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_logs (
  id serial PRIMARY KEY,
  level text NOT NULL,
  module text NOT NULL,
  message text NOT NULL,
  meta jsonb,
  created_at timestamptz DEFAULT NOW()
);

-- ═══ Indexes ═══
CREATE INDEX IF NOT EXISTS idx_whitelist_chain_status ON ca_whitelist(chain_id, status);
CREATE INDEX IF NOT EXISTS idx_whitelist_ca_chain ON ca_whitelist(contract_address, chain_id);
CREATE INDEX IF NOT EXISTS idx_activities_unprocessed ON x_activities(processed) WHERE processed = FALSE;
CREATE INDEX IF NOT EXISTS idx_activities_created ON x_activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_status ON trade_signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_created ON trade_signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_chain ON positions(chain_id, status);
CREATE INDEX IF NOT EXISTS idx_budget_chain_period ON budget_tracking(chain_id, period_type, period_key);
CREATE INDEX IF NOT EXISTS idx_logs_module_created ON system_logs(module, created_at DESC);
