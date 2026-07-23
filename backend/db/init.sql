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
  last_follow_checked_at timestamptz,
  follow_baseline_completed_at timestamptz,
  follow_poll_status text,
  stream_status text NOT NULL DEFAULT 'inactive',
  stream_active_at timestamptz,
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
  paper_spent_budget numeric(18,8) NOT NULL DEFAULT 0,
  paper_buy_count int NOT NULL DEFAULT 0,
  status text DEFAULT 'active' CHECK(status IN('active','paused','exhausted','expired')),
  source text DEFAULT 'manual' CHECK(source IN('manual','semi-auto')),
  expires_at timestamptz,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelist_ca_chain_active ON ca_whitelist(contract_address, chain_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS x_signal_relations (
  id bigserial PRIMARY KEY,
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE CASCADE,
  kol_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  target_x_handle text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(whitelist_id, kol_id, target_x_handle)
);
CREATE INDEX IF NOT EXISTS idx_x_signal_relations_kol ON x_signal_relations(kol_id, enabled);
CREATE INDEX IF NOT EXISTS idx_x_signal_relations_target ON x_signal_relations(target_x_handle, enabled);
CREATE INDEX IF NOT EXISTS idx_x_signal_relations_whitelist ON x_signal_relations(whitelist_id, enabled);

CREATE TABLE IF NOT EXISTS x_activities (
  id serial PRIMARY KEY,
  kol_id int NOT NULL REFERENCES x_kol_accounts(id),
  kol_handle text NOT NULL,
  activity_type text NOT NULL CHECK(activity_type IN('tweet','retweet','quote','reply','follow','unfollow')),
  tweet_id text,
  tweet_text text,
  target_x_handle text,
  target_x_handles text[] DEFAULT '{}',
  extracted_cas text[] DEFAULT '{}',
  extracted_tickers text[] DEFAULT '{}',
  provider_event_id text,
  source_created_at timestamptz,
  provider text,
  semantic_key text,
  observation_started_at timestamptz,
  observation_ended_at timestamptz,
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
  canonical_key text,
  matched_project_handles text[] NOT NULL DEFAULT '{}',
  matched_whitelist_ids int[] NOT NULL DEFAULT '{}',
  matched_relation_ids bigint[] NOT NULL DEFAULT '{}',
  kol_weight int DEFAULT 5,
  risk_check jsonb DEFAULT '{}',
  execution_mode text NOT NULL DEFAULT 'signal' CHECK(execution_mode IN('signal','paper','live')),
  status text DEFAULT 'signal_only' CHECK(status IN('signal_only','recorded','pending','approved','rejected','executed','expired')),
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
  execution_mode text NOT NULL DEFAULT 'unknown' CHECK(execution_mode IN('unknown','paper','live')),
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

CREATE TABLE IF NOT EXISTS x_follow_poll_runs (
  id bigserial PRIMARY KEY,
  kol_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  poll_type text NOT NULL CHECK(poll_type IN('baseline','incremental')),
  status text NOT NULL CHECK(status IN('running','completed','gap_detected','failed','budget_blocked')),
  started_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  observation_started_at timestamptz,
  page_count int NOT NULL DEFAULT 0,
  returned_count int NOT NULL DEFAULT 0,
  new_count int NOT NULL DEFAULT 0,
  credits_used numeric(18,2) NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS x_follow_seen (
  id bigserial PRIMARY KEY,
  kol_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  target_x_user_id text NOT NULL,
  target_x_handle text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT NOW(),
  first_seen_poll_id bigint REFERENCES x_follow_poll_runs(id) ON DELETE SET NULL,
  was_in_baseline boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(kol_id, target_x_user_id)
);

CREATE TABLE IF NOT EXISTS x_follow_signal_once (
  id bigserial PRIMARY KEY,
  kol_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  ca_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE CASCADE,
  source_target_x_handle text NOT NULL,
  first_activity_id int NOT NULL REFERENCES x_activities(id) ON DELETE CASCADE,
  signal_id int REFERENCES trade_signals(id) ON DELETE SET NULL,
  triggered_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(kol_id, ca_id)
);

CREATE TABLE IF NOT EXISTS x_provider_usage_daily (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  usage_date date NOT NULL DEFAULT CURRENT_DATE,
  endpoint text NOT NULL,
  request_count bigint NOT NULL DEFAULT 0,
  credits_used numeric(18,2) NOT NULL DEFAULT 0,
  error_count bigint NOT NULL DEFAULT 0,
  latency_ms_total bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(provider, usage_date, endpoint)
);

CREATE TABLE IF NOT EXISTS x_provider_watches (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  username text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  desired_flags jsonb NOT NULL DEFAULT '{}',
  remote_flags jsonb NOT NULL DEFAULT '{}',
  managed boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'observed'
    CHECK(sync_status IN('observed','in_sync','pending_add','pending_update','pending_delete','error')),
  last_seen_remote_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(provider, username)
);

CREATE TABLE IF NOT EXISTS x_provider_events (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text,
  tw_account text,
  semantic_key text,
  provider_created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT NOW(),
  raw_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','processing','processed','ignored','dead_letter')),
  attempt_count int NOT NULL DEFAULT 0,
  activity_ids int[] NOT NULL DEFAULT '{}',
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(provider, provider_event_id)
);

-- ═══ Indexes ═══
CREATE INDEX IF NOT EXISTS idx_whitelist_chain_status ON ca_whitelist(chain_id, status);
CREATE INDEX IF NOT EXISTS idx_whitelist_ca_chain ON ca_whitelist(contract_address, chain_id);
CREATE INDEX IF NOT EXISTS idx_activities_unprocessed ON x_activities(processed) WHERE processed = FALSE;
CREATE INDEX IF NOT EXISTS idx_activities_created ON x_activities(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_activities_tweet ON x_activities(kol_id, tweet_id) WHERE tweet_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_activities_provider_event ON x_activities(kol_id, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signals_status ON trade_signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_created ON trade_signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_chain ON positions(chain_id, status);
CREATE INDEX IF NOT EXISTS idx_budget_chain_period ON budget_tracking(chain_id, period_type, period_key);
CREATE INDEX IF NOT EXISTS idx_logs_module_created ON system_logs(module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follow_seen_kol_handle ON x_follow_seen(kol_id, target_x_handle);
CREATE INDEX IF NOT EXISTS idx_follow_poll_runs_kol_started ON x_follow_poll_runs(kol_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_execution_status ON trade_signals(execution_mode, status, created_at);
CREATE INDEX IF NOT EXISTS idx_positions_execution_status ON positions(execution_mode, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_signals_canonical ON trade_signals(canonical_key) WHERE canonical_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_watches_provider_managed ON x_provider_watches(provider, managed, sync_status);
CREATE INDEX IF NOT EXISTS idx_provider_events_status_received ON x_provider_events(provider, status, received_at);
CREATE INDEX IF NOT EXISTS idx_provider_events_created ON x_provider_events(provider, provider_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_semantic ON x_activities(kol_id, semantic_key) WHERE semantic_key IS NOT NULL;
