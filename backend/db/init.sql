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
  profile_status text NOT NULL DEFAULT 'pending'
    CHECK (profile_status IN ('pending', 'verified')),
  profile_attempt_count int NOT NULL DEFAULT 0
    CHECK (profile_attempt_count >= 0),
  profile_last_checked_at timestamptz,
  profile_next_retry_at timestamptz DEFAULT NOW(),
  profile_verified_at timestamptz,
  profile_last_error_code text,
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
  exit_strategy jsonb NOT NULL DEFAULT
    '{"version":1,"sell_ratio_type":"buy_amount","legs":[{"type":"take_profit","trigger_pct":100,"sell_pct":100},{"type":"stop_loss","drop_pct":20,"sell_pct":100}]}'::jsonb,
  exit_strategy_version int NOT NULL DEFAULT 1,
  slippage numeric(5,2) DEFAULT 10,
  allow_repeat_buy boolean DEFAULT false,
  max_repeat_buys int DEFAULT 1,
  current_buy_count int DEFAULT 0,
  paper_spent_budget numeric(18,8) NOT NULL DEFAULT 0,
  paper_buy_count int NOT NULL DEFAULT 0,
  status text DEFAULT 'active' CHECK(status IN('active','paused','exhausted','expired','archived')),
  source text DEFAULT 'manual' CHECK(source IN('manual','semi-auto')),
  token_logo_url text,
  token_official_x_handle text,
  token_website_url text,
  token_metadata_source text,
  token_metadata_fetched_at timestamptz,
  expires_at timestamptz,
  live_activation_state text NOT NULL DEFAULT 'syncing'
    CHECK(live_activation_state IN('syncing','live_ready','sync_failed')),
  activation_version int NOT NULL DEFAULT 1 CHECK(activation_version >= 1),
  activation_context_hash text,
  activation_error_code text,
  activation_error_detail text,
  activation_checked_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelist_ca_chain_active ON ca_whitelist(contract_address, chain_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_ca_whitelist_live_activation
  ON ca_whitelist(status, live_activation_state, chain_id, id);

CREATE TABLE IF NOT EXISTS whitelist_activation_outbox (
  whitelist_id int PRIMARY KEY REFERENCES ca_whitelist(id) ON DELETE CASCADE,
  desired_version int NOT NULL CHECK(desired_version >= 1),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','processing','succeeded','failed')),
  attempt_count int NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  locked_at timestamptz,
  last_error_code text,
  last_error_detail text,
  requested_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whitelist_activation_outbox_claim
  ON whitelist_activation_outbox(status, next_attempt_at, requested_at);

CREATE TABLE IF NOT EXISTS x_signal_relations (
  id bigserial PRIMARY KEY,
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE CASCADE,
  kol_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  target_x_handle text NOT NULL,
  event_types text[] NOT NULL DEFAULT ARRAY['retweet','quote','reply','follow']::text[],
  CONSTRAINT x_signal_relations_event_types_check CHECK(
    cardinality(event_types) > 0
    AND event_types <@ ARRAY['retweet','quote','reply','follow']::text[]
  ),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(whitelist_id, kol_id, target_x_handle)
);
CREATE INDEX IF NOT EXISTS idx_x_signal_relations_kol ON x_signal_relations(kol_id, enabled);
CREATE INDEX IF NOT EXISTS idx_x_signal_relations_target ON x_signal_relations(target_x_handle, enabled);
CREATE INDEX IF NOT EXISTS idx_x_signal_relations_whitelist ON x_signal_relations(whitelist_id, enabled);

CREATE TABLE IF NOT EXISTS whitelist_x_accounts (
  id bigserial PRIMARY KEY,
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE CASCADE,
  handle text NOT NULL,
  role text NOT NULL DEFAULT 'project',
  usage text NOT NULL DEFAULT 'identity'
    CHECK(usage IN('identity','direct_source','interaction_target')),
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(whitelist_id, handle, usage)
);
CREATE INDEX IF NOT EXISTS idx_whitelist_x_accounts_whitelist
  ON whitelist_x_accounts(whitelist_id, usage);

CREATE TABLE IF NOT EXISTS x_signal_source_rules (
  id bigserial PRIMARY KEY,
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE CASCADE,
  actor_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  event_types text[] NOT NULL DEFAULT ARRAY['tweet']::text[],
  match_mode text NOT NULL DEFAULT 'ca_only'
    CHECK(match_mode = 'ca_only'),
  source_kind text NOT NULL DEFAULT 'project'
    CHECK(source_kind IN('project','ecosystem','launch')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT x_signal_source_rules_event_types_check CHECK(
    cardinality(event_types) > 0
    AND event_types <@ ARRAY['tweet','retweet','quote','reply']::text[]
  ),
  UNIQUE(whitelist_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_x_signal_source_rules_actor
  ON x_signal_source_rules(actor_id, enabled);
CREATE INDEX IF NOT EXISTS idx_x_signal_source_rules_whitelist
  ON x_signal_source_rules(whitelist_id, enabled);

CREATE TABLE IF NOT EXISTS project_launch_rules (
  id bigserial PRIMARY KEY,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  project_name text,
  budget_per_trade numeric(18,8) NOT NULL CHECK(budget_per_trade > 0),
  total_budget numeric(18,8) NOT NULL CHECK(total_budget >= budget_per_trade),
  slippage numeric(5,2) NOT NULL DEFAULT 10 CHECK(slippage > 0 AND slippage <= 100),
  allow_repeat_buy boolean NOT NULL DEFAULT false,
  max_repeat_buys int NOT NULL DEFAULT 1 CHECK(max_repeat_buys >= 1),
  exit_strategy jsonb NOT NULL,
  exit_strategy_version int NOT NULL DEFAULT 1 CHECK(exit_strategy_version >= 1),
  status text NOT NULL DEFAULT 'active'
    CHECK(status IN('active','paused','triggered','expired')),
  discovery_count int NOT NULL DEFAULT 0 CHECK(discovery_count BETWEEN 0 AND 1),
  triggered_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_launch_rules_active
  ON project_launch_rules(chain_id, status, expires_at);

CREATE TABLE IF NOT EXISTS project_launch_sources (
  id bigserial PRIMARY KEY,
  launch_rule_id bigint NOT NULL REFERENCES project_launch_rules(id) ON DELETE CASCADE,
  actor_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'project',
  event_types text[] NOT NULL DEFAULT ARRAY['tweet']::text[],
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT project_launch_sources_event_types_check CHECK(
    cardinality(event_types) > 0
    AND event_types <@ ARRAY['tweet','retweet','quote','reply']::text[]
  ),
  UNIQUE(launch_rule_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_project_launch_sources_actor
  ON project_launch_sources(actor_id, enabled);

CREATE TABLE IF NOT EXISTS project_launch_relations (
  id bigserial PRIMARY KEY,
  launch_rule_id bigint NOT NULL REFERENCES project_launch_rules(id) ON DELETE CASCADE,
  actor_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  target_x_handle text NOT NULL,
  event_types text[] NOT NULL DEFAULT ARRAY['retweet','quote','reply']::text[],
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT project_launch_relations_event_types_check CHECK(
    cardinality(event_types) > 0
    AND event_types <@ ARRAY['retweet','quote','reply']::text[]
  ),
  UNIQUE(launch_rule_id, actor_id, target_x_handle)
);
CREATE INDEX IF NOT EXISTS idx_project_launch_relations_actor
  ON project_launch_relations(actor_id, enabled);

ALTER TABLE ca_whitelist
  ADD COLUMN IF NOT EXISTS launch_rule_id bigint
    REFERENCES project_launch_rules(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ca_whitelist_launch_rule
  ON ca_whitelist(launch_rule_id);

CREATE TABLE IF NOT EXISTS x_watch_sync_outbox (
  actor_handle text PRIMARY KEY,
  desired_version bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','processing','succeeded','failed')),
  attempt_count int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  locked_at timestamptz,
  last_error text,
  requested_at timestamptz NOT NULL DEFAULT NOW(),
  synced_at timestamptz,
  desired_present boolean NOT NULL DEFAULT false,
  desired_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  desired_fingerprint text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_x_watch_sync_outbox_due
  ON x_watch_sync_outbox(status, next_attempt_at);

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
  matched_source_rule_ids bigint[] NOT NULL DEFAULT '{}',
  kol_weight int DEFAULT 5,
  risk_check jsonb DEFAULT '{}',
  execution_mode text NOT NULL DEFAULT 'signal' CHECK(execution_mode IN('signal','paper','live')),
  status text DEFAULT 'signal_only' CHECK(status IN('signal_only','recorded','pending','approved','rejected','executed','expired')),
  reject_reason text,
  activation_wait_version int CHECK(activation_wait_version IS NULL OR activation_wait_version >= 1),
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),
  UNIQUE(activity_id, whitelist_id, signal_type)
);
CREATE INDEX IF NOT EXISTS idx_trade_signals_activation_wait
  ON trade_signals(whitelist_id, activation_wait_version, created_at)
  WHERE status = 'recorded' AND activation_wait_version IS NOT NULL;

CREATE TABLE IF NOT EXISTS arm_preparations (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  operator text NOT NULL,
  configuration_fingerprint text NOT NULL,
  policy_fingerprint text NOT NULL,
  snapshot_hash text NOT NULL,
  activation_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  compact_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'prepared'
    CHECK(status IN('prepared','arming','consumed','expired','stale','failed')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_detail text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_arm_preparations_expiry
  ON arm_preparations(status, expires_at);

CREATE TABLE IF NOT EXISTS project_launch_discoveries (
  id bigserial PRIMARY KEY,
  launch_rule_id bigint NOT NULL REFERENCES project_launch_rules(id) ON DELETE RESTRICT,
  activity_id int NOT NULL REFERENCES x_activities(id) ON DELETE RESTRICT,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  contract_address text NOT NULL,
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE RESTRICT,
  signal_id int REFERENCES trade_signals(id) ON DELETE SET NULL,
  trigger_kind text NOT NULL CHECK(trigger_kind IN('project_source','ecosystem_relation')),
  actor_handle text NOT NULL,
  target_x_handle text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(launch_rule_id, chain_id, contract_address),
  UNIQUE(launch_rule_id, activity_id)
);
CREATE INDEX IF NOT EXISTS idx_project_launch_discoveries_rule
  ON project_launch_discoveries(launch_rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_launch_discoveries_contract
  ON project_launch_discoveries(chain_id, contract_address, created_at);

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

CREATE TABLE IF NOT EXISTS whitelist_templates (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  template_snapshot jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelist_templates_default_chain
  ON whitelist_templates(chain_id) WHERE is_default = true;
CREATE INDEX IF NOT EXISTS idx_whitelist_templates_chain
  ON whitelist_templates(chain_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS token_research_reports (
  id bigserial PRIMARY KEY,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  contract_address text NOT NULL,
  status text NOT NULL DEFAULT 'completed'
    CHECK(status IN('pending','completed','partial','failed')),
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  analyzer_version text NOT NULL DEFAULT 'p16-v1',
  prompt_version text NOT NULL DEFAULT 'p16-project-team-v3',
  model_name text,
  xai_duration_ms int,
  xai_error_code text,
  cache_key text,
  analysis_started_at timestamptz,
  analysis_finished_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_research_reports_lookup
  ON token_research_reports(chain_id, contract_address, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_research_reports_cache
  ON token_research_reports(cache_key, expires_at DESC);

CREATE TABLE IF NOT EXISTS research_jobs (
  id bigserial PRIMARY KEY,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  mode text NOT NULL CHECK(mode IN('single','batch')),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','running','completed','partial','failed','cancelled')),
  total_count int NOT NULL CHECK(total_count BETWEEN 1 AND 30),
  completed_count int NOT NULL DEFAULT 0,
  failed_count int NOT NULL DEFAULT 0,
  cancelled_count int NOT NULL DEFAULT 0,
  concurrency_limit int NOT NULL DEFAULT 3 CHECK(concurrency_limit BETWEEN 1 AND 3),
  prompt_version text NOT NULL DEFAULT 'p16-project-team-v3',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  started_at timestamptz,
  finished_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_research_jobs_status
  ON research_jobs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS research_job_items (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  contract_address text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK(status IN('queued','gmgn','grok','verification','completed','failed','cancelled')),
  report_id bigint REFERENCES token_research_reports(id) ON DELETE SET NULL,
  attempt_count int NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms int,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, contract_address)
);
CREATE INDEX IF NOT EXISTS idx_research_job_items_claim
  ON research_job_items(status, locked_at, created_at);
CREATE INDEX IF NOT EXISTS idx_research_job_items_job
  ON research_job_items(job_id, id);

CREATE TABLE IF NOT EXISTS x_actor_directory (
  id bigserial PRIMARY KEY,
  x_user_id text,
  handle text NOT NULL,
  display_name text,
  avatar_url text,
  role_types text[] NOT NULL DEFAULT '{}',
  organization text,
  chain_ids text[] NOT NULL DEFAULT '{}',
  source_types text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence text NOT NULL DEFAULT 'unverified'
    CHECK(confidence IN('verified','high','medium','low','unverified')),
  status text NOT NULL DEFAULT 'candidate'
    CHECK(status IN('candidate','confirmed','rejected','archived')),
  follower_count bigint,
  is_verified boolean NOT NULL DEFAULT false,
  is_favorite boolean NOT NULL DEFAULT false,
  use_count int NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_x_actor_directory_handle
  ON x_actor_directory(lower(handle));
CREATE INDEX IF NOT EXISTS idx_x_actor_directory_search
  ON x_actor_directory(status, updated_at DESC);

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
