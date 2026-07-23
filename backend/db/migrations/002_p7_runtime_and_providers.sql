ALTER TABLE ca_whitelist
  ADD COLUMN IF NOT EXISTS paper_spent_budget numeric(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paper_buy_count int NOT NULL DEFAULT 0;

ALTER TABLE x_kol_accounts
  ADD COLUMN IF NOT EXISTS follow_baseline_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS follow_poll_status text,
  ADD COLUMN IF NOT EXISTS stream_status text NOT NULL DEFAULT 'inactive',
  ADD COLUMN IF NOT EXISTS stream_active_at timestamptz;

ALTER TABLE x_activities
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS observation_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS observation_ended_at timestamptz;

ALTER TABLE trade_signals
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'signal';

ALTER TABLE trade_signals DROP CONSTRAINT IF EXISTS trade_signals_status_check;
ALTER TABLE trade_signals
  ADD CONSTRAINT trade_signals_status_check
  CHECK(status IN('signal_only','recorded','pending','approved','rejected','executed','expired'));

ALTER TABLE trade_signals DROP CONSTRAINT IF EXISTS trade_signals_execution_mode_check;
ALTER TABLE trade_signals
  ADD CONSTRAINT trade_signals_execution_mode_check
  CHECK(execution_mode IN('signal','paper','live'));

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'unknown';

ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_execution_mode_check;
ALTER TABLE positions
  ADD CONSTRAINT positions_execution_mode_check
  CHECK(execution_mode IN('unknown','paper','live'));

CREATE TABLE IF NOT EXISTS x_follow_seen (
  id bigserial PRIMARY KEY,
  kol_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  target_x_user_id text NOT NULL,
  target_x_handle text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT NOW(),
  first_seen_poll_id bigint,
  was_in_baseline boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(kol_id, target_x_user_id)
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

ALTER TABLE x_follow_seen
  DROP CONSTRAINT IF EXISTS x_follow_seen_first_seen_poll_id_fkey;
ALTER TABLE x_follow_seen
  ADD CONSTRAINT x_follow_seen_first_seen_poll_id_fkey
  FOREIGN KEY (first_seen_poll_id) REFERENCES x_follow_poll_runs(id) ON DELETE SET NULL;

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

CREATE INDEX IF NOT EXISTS idx_follow_seen_kol_handle
  ON x_follow_seen(kol_id, target_x_handle);
CREATE INDEX IF NOT EXISTS idx_follow_poll_runs_kol_started
  ON x_follow_poll_runs(kol_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_execution_status
  ON trade_signals(execution_mode, status, created_at);
CREATE INDEX IF NOT EXISTS idx_positions_execution_status
  ON positions(execution_mode, status);
