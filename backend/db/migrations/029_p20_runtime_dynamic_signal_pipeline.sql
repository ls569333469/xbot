-- P20.2-P20.5 runtime contracts. All runtime stages remain feature-flagged and
-- live execution additionally requires a short-lived actor-policy approval.

CREATE TABLE IF NOT EXISTS x_actor_dynamic_policies (
  id bigserial PRIMARY KEY,
  kol_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'record'
    CHECK(mode IN('record','paper','live','paused')),
  enabled boolean NOT NULL DEFAULT true,
  allowed_chain_ids text[] NOT NULL DEFAULT '{}',
  allowed_event_types text[] NOT NULL DEFAULT ARRAY['tweet','quote','reply']::text[],
  allowed_term_types text[] NOT NULL DEFAULT ARRAY['ca','cashtag','hashtag']::text[],
  approved_aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget_per_trade numeric(18,8) NOT NULL DEFAULT 0,
  daily_budget numeric(18,8) NOT NULL DEFAULT 0,
  daily_new_token_limit int NOT NULL DEFAULT 0,
  per_token_buy_limit int NOT NULL DEFAULT 1,
  slippage numeric(5,2) NOT NULL DEFAULT 10,
  exit_strategy jsonb NOT NULL DEFAULT
    '{"version":1,"sell_ratio_type":"buy_amount","legs":[{"type":"take_profit","trigger_pct":100,"sell_pct":50}]}'::jsonb,
  resolver_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision int NOT NULL DEFAULT 1,
  context_hash text NOT NULL,
  last_approved_revision int,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK(cardinality(allowed_chain_ids) > 0),
  CHECK(allowed_chain_ids <@ ARRAY['sol','bsc','base','eth','robinhood']::text[]),
  CHECK(allowed_event_types <@ ARRAY['tweet','quote','reply']::text[]),
  CHECK(allowed_term_types <@ ARRAY['ca','cashtag','hashtag','approved_name']::text[]),
  CHECK(budget_per_trade >= 0 AND daily_budget >= 0),
  CHECK(daily_new_token_limit >= 0 AND per_token_buy_limit >= 1),
  UNIQUE(kol_id)
);

CREATE INDEX IF NOT EXISTS idx_actor_dynamic_policies_runtime
  ON x_actor_dynamic_policies(enabled, mode, updated_at DESC);

CREATE TABLE IF NOT EXISTS dynamic_signal_jobs (
  id bigserial PRIMARY KEY,
  x_provider_event_id bigint REFERENCES x_provider_events(id) ON DELETE SET NULL,
  x_activity_id int NOT NULL REFERENCES x_activities(id) ON DELETE CASCADE,
  actor_policy_id bigint NOT NULL REFERENCES x_actor_dynamic_policies(id) ON DELETE CASCADE,
  policy_revision int NOT NULL,
  mode text NOT NULL CHECK(mode IN('record','paper','live')),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','processing','resolved','rejected','failed','cancelled')),
  attempt_count int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  locked_at timestamptz,
  lease_expires_at timestamptz,
  worker_id text,
  resolution_attempt_id bigint REFERENCES dynamic_ca_resolution_attempts(id) ON DELETE SET NULL,
  failure_code text,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(x_activity_id, actor_policy_id, policy_revision)
);

CREATE INDEX IF NOT EXISTS idx_dynamic_signal_jobs_claim
  ON dynamic_signal_jobs(status, next_attempt_at, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS dynamic_launch_windows (
  id bigserial PRIMARY KEY,
  dynamic_job_id bigint NOT NULL REFERENCES dynamic_signal_jobs(id) ON DELETE CASCADE,
  allowed_chain_ids text[] NOT NULL,
  observed_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','processing','resolved','expired','failed')),
  attempt_count int NOT NULL DEFAULT 0,
  worker_id text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL DEFAULT (NOW() + INTERVAL '30 seconds'),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(dynamic_job_id)
);

CREATE INDEX IF NOT EXISTS idx_dynamic_launch_windows_claim
  ON dynamic_launch_windows(status, next_attempt_at, expires_at);

ALTER TABLE dynamic_launch_windows
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

ALTER TABLE dynamic_ca_resolution_attempts
  ADD COLUMN IF NOT EXISTS dynamic_job_id bigint REFERENCES dynamic_signal_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_policy_id bigint REFERENCES x_actor_dynamic_policies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_policy_revision int,
  ADD COLUMN IF NOT EXISTS processing_mode text NOT NULL DEFAULT 'record',
  ADD COLUMN IF NOT EXISTS policy_context_hash text;

ALTER TABLE dynamic_ca_resolution_attempts
  DROP CONSTRAINT IF EXISTS dynamic_ca_resolution_attempts_processing_mode_check;
ALTER TABLE dynamic_ca_resolution_attempts
  ADD CONSTRAINT dynamic_ca_resolution_attempts_processing_mode_check
  CHECK(processing_mode IN('record','paper','live'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_dynamic_resolution_job
  ON dynamic_ca_resolution_attempts(dynamic_job_id)
  WHERE dynamic_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dynamic_targets (
  id bigserial PRIMARY KEY,
  actor_policy_id bigint NOT NULL REFERENCES x_actor_dynamic_policies(id) ON DELETE RESTRICT,
  actor_policy_revision int NOT NULL,
  resolution_attempt_id bigint NOT NULL REFERENCES dynamic_ca_resolution_attempts(id) ON DELETE RESTRICT,
  variant_id bigint NOT NULL REFERENCES dynamic_asset_variants(id) ON DELETE RESTRICT,
  whitelist_id int REFERENCES ca_whitelist(id) ON DELETE SET NULL,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  contract_address text NOT NULL,
  mode text NOT NULL CHECK(mode IN('paper','live')),
  status text NOT NULL DEFAULT 'active'
    CHECK(status IN('active','paused','expired','archived')),
  config_snapshot jsonb NOT NULL,
  context_hash text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK(chain_id = 'sol' OR contract_address = lower(contract_address)),
  UNIQUE(actor_policy_id, chain_id, contract_address)
);

CREATE INDEX IF NOT EXISTS idx_dynamic_targets_runtime
  ON dynamic_targets(actor_policy_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dynamic_live_approvals (
  id bigserial PRIMARY KEY,
  actor_policy_id bigint NOT NULL REFERENCES x_actor_dynamic_policies(id) ON DELETE CASCADE,
  policy_revision int NOT NULL,
  context_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK(status IN('active','expired','revoked','consumed')),
  approved_by text NOT NULL,
  approval_note text,
  approved_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK(expires_at > approved_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dynamic_live_approval_active
  ON dynamic_live_approvals(actor_policy_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS dynamic_policy_usage_daily (
  actor_policy_id bigint NOT NULL REFERENCES x_actor_dynamic_policies(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  spent_native numeric(18,8) NOT NULL DEFAULT 0,
  reserved_native numeric(18,8) NOT NULL DEFAULT 0,
  new_token_count int NOT NULL DEFAULT 0,
  signal_count int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY(actor_policy_id, usage_date)
);

CREATE TABLE IF NOT EXISTS dynamic_policy_usage_events (
  id bigserial PRIMARY KEY,
  actor_policy_id bigint NOT NULL REFERENCES x_actor_dynamic_policies(id) ON DELETE CASCADE,
  signal_id int NOT NULL REFERENCES trade_signals(id) ON DELETE CASCADE,
  chain_id text NOT NULL,
  contract_address text NOT NULL,
  usage_date date NOT NULL DEFAULT CURRENT_DATE,
  amount_native numeric(18,8) NOT NULL,
  counts_new_token boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'reserved'
    CHECK(status IN('reserved','committed','released')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(signal_id)
);
CREATE INDEX IF NOT EXISTS idx_dynamic_policy_usage_token
  ON dynamic_policy_usage_events(actor_policy_id, usage_date, chain_id, contract_address, status);

CREATE TABLE IF NOT EXISTS dynamic_paper_sessions (
  id bigserial PRIMARY KEY,
  actor_policy_id bigint NOT NULL REFERENCES x_actor_dynamic_policies(id) ON DELETE CASCADE,
  policy_revision int NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK(status IN('running','completed','cancelled','failed')),
  started_at timestamptz NOT NULL DEFAULT NOW(),
  ends_at timestamptz NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  completed_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dynamic_paper_session_running
  ON dynamic_paper_sessions(actor_policy_id, policy_revision)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS dynamic_paper_evaluations (
  id bigserial PRIMARY KEY,
  paper_session_id bigint NOT NULL REFERENCES dynamic_paper_sessions(id) ON DELETE CASCADE,
  dynamic_target_id bigint NOT NULL REFERENCES dynamic_targets(id) ON DELETE CASCADE,
  signal_id int REFERENCES trade_signals(id) ON DELETE SET NULL,
  position_id int REFERENCES positions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','open','closed','failed','excluded')),
  entry_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(paper_session_id, dynamic_target_id)
);

ALTER TABLE x_actor_screening_results
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS provider_coverage_rate numeric(8,6),
  ADD COLUMN IF NOT EXISTS ambiguity_rate numeric(8,6),
  ADD COLUMN IF NOT EXISTS historical_candidate_coverage_rate numeric(8,6),
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE x_actor_screening_results
  DROP CONSTRAINT IF EXISTS x_actor_screening_results_status_check;
ALTER TABLE x_actor_screening_results
  ADD CONSTRAINT x_actor_screening_results_status_check
  CHECK(status IN('pending','running','completed','partial','failed'));

ALTER TABLE ca_whitelist
  ADD COLUMN IF NOT EXISTS managed_by_system boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dynamic_target_id bigint REFERENCES dynamic_targets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_policy_id bigint REFERENCES x_actor_dynamic_policies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_policy_revision int;

ALTER TABLE ca_whitelist DROP CONSTRAINT IF EXISTS ca_whitelist_source_check;
UPDATE ca_whitelist SET source = 'manual' WHERE source IS NULL;
ALTER TABLE ca_whitelist ALTER COLUMN source SET NOT NULL;
ALTER TABLE ca_whitelist
  ADD CONSTRAINT ca_whitelist_source_check
  CHECK(source IN('manual','semi-auto','dynamic_keyword'));

DROP INDEX IF EXISTS uq_whitelist_ca_chain_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelist_manual_ca_chain_active
  ON ca_whitelist(contract_address, chain_id)
  WHERE status = 'active' AND source <> 'dynamic_keyword';
CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelist_dynamic_actor_ca_chain_active
  ON ca_whitelist(actor_policy_id, contract_address, chain_id)
  WHERE status = 'active' AND source = 'dynamic_keyword';

ALTER TABLE dynamic_targets
  DROP CONSTRAINT IF EXISTS dynamic_targets_whitelist_id_fkey;
ALTER TABLE dynamic_targets
  ADD CONSTRAINT dynamic_targets_whitelist_id_fkey
  FOREIGN KEY(whitelist_id) REFERENCES ca_whitelist(id) ON DELETE SET NULL;

ALTER TABLE trade_signals
  ADD COLUMN IF NOT EXISTS matched_dynamic_resolution_id bigint
    REFERENCES dynamic_ca_resolution_attempts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dynamic_target_id bigint REFERENCES dynamic_targets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_policy_id bigint REFERENCES x_actor_dynamic_policies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_policy_revision int,
  ADD COLUMN IF NOT EXISTS dynamic_policy_context_hash text,
  ADD COLUMN IF NOT EXISTS dynamic_intent_class text,
  ADD COLUMN IF NOT EXISTS dynamic_intent_reason_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS dynamic_intent_rule_revision text,
  ADD COLUMN IF NOT EXISTS dynamic_authorization jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE trade_signals DROP CONSTRAINT IF EXISTS trade_signals_signal_type_check;
ALTER TABLE trade_signals
  ADD CONSTRAINT trade_signals_signal_type_check
  CHECK(signal_type IN('handle_match','ca_mention','ticker_mention','dynamic_keyword'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_signal_dynamic_resolution
  ON trade_signals(matched_dynamic_resolution_id)
  WHERE matched_dynamic_resolution_id IS NOT NULL;
