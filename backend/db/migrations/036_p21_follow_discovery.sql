-- P21: account research separation and follow-discovery strategy runtime.

CREATE TABLE IF NOT EXISTS follow_discovery_policies (
  id bigserial PRIMARY KEY,
  kol_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE RESTRICT,
  mode text NOT NULL DEFAULT 'record'
    CHECK (mode IN ('record','paper','live','paused')),
  enabled boolean NOT NULL DEFAULT true,
  allowed_chain_ids text[] NOT NULL DEFAULT '{}',
  trade_template_id bigint REFERENCES dynamic_policy_templates(id) ON DELETE RESTRICT,
  trade_config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolver_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  context_hash text NOT NULL,
  baseline_at timestamptz NOT NULL DEFAULT NOW(),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (cardinality(allowed_chain_ids) > 0),
  CHECK (allowed_chain_ids <@ ARRAY['sol','bsc','base','eth','robinhood']::text[])
);

ALTER TABLE follow_discovery_policies
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE follow_discovery_policies
  DROP CONSTRAINT IF EXISTS follow_discovery_policies_kol_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_follow_discovery_policy_kol_current
  ON follow_discovery_policies (kol_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_follow_discovery_policies_runtime
  ON follow_discovery_policies (enabled, mode, updated_at DESC);

CREATE TABLE IF NOT EXISTS follow_discovery_events (
  id bigserial PRIMARY KEY,
  x_provider_event_id bigint REFERENCES x_provider_events(id) ON DELETE SET NULL,
  x_activity_id int NOT NULL REFERENCES x_activities(id) ON DELETE CASCADE,
  policy_id bigint NOT NULL REFERENCES follow_discovery_policies(id) ON DELETE RESTRICT,
  policy_revision int NOT NULL,
  mode text NOT NULL CHECK (mode IN ('record','paper','live')),
  actor_user_id text NOT NULL,
  actor_handle text NOT NULL,
  target_user_id text NOT NULL,
  target_handle text NOT NULL,
  behavior_key text NOT NULL UNIQUE,
  provider_created_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('baseline','pending','processing','resolved','rejected','failed','cancelled')),
  stage text NOT NULL DEFAULT 'queued',
  attempt_count int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  locked_at timestamptz,
  lease_expires_at timestamptz,
  worker_id text,
  project_classification text,
  classification_confidence text,
  profile_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  chain_id text,
  contract_address text,
  variant_id bigint REFERENCES dynamic_asset_variants(id) ON DELETE SET NULL,
  whitelist_id int,
  signal_id int,
  failure_code text,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (chain_id IS NULL OR chain_id IN ('sol','bsc','base','eth','robinhood')),
  CHECK (chain_id IS NULL OR chain_id = 'sol' OR contract_address = lower(contract_address))
);

CREATE INDEX IF NOT EXISTS idx_follow_discovery_events_claim
  ON follow_discovery_events (status, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_follow_discovery_events_policy
  ON follow_discovery_events (policy_id, provider_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follow_discovery_events_target
  ON follow_discovery_events (target_user_id, provider_created_at DESC);

ALTER TABLE ca_whitelist
  ADD COLUMN IF NOT EXISTS follow_discovery_policy_id bigint
    REFERENCES follow_discovery_policies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS follow_discovery_event_id bigint
    REFERENCES follow_discovery_events(id) ON DELETE SET NULL;

ALTER TABLE ca_whitelist DROP CONSTRAINT IF EXISTS ca_whitelist_source_check;
ALTER TABLE ca_whitelist
  ADD CONSTRAINT ca_whitelist_source_check
  CHECK (source IN ('manual','semi-auto','dynamic_keyword','follow_discovery'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelist_follow_discovery_active
  ON ca_whitelist (follow_discovery_policy_id, contract_address, chain_id)
  WHERE status = 'active' AND source = 'follow_discovery';

DROP INDEX IF EXISTS uq_whitelist_manual_ca_chain_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelist_manual_ca_chain_active
  ON ca_whitelist (contract_address, chain_id)
  WHERE status = 'active'
    AND source NOT IN ('dynamic_keyword', 'follow_discovery');

ALTER TABLE trade_signals
  ADD COLUMN IF NOT EXISTS follow_discovery_policy_id bigint
    REFERENCES follow_discovery_policies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS follow_discovery_event_id bigint
    REFERENCES follow_discovery_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS follow_discovery_policy_revision int,
  ADD COLUMN IF NOT EXISTS follow_discovery_context_hash text;

ALTER TABLE trade_signals DROP CONSTRAINT IF EXISTS trade_signals_signal_type_check;
ALTER TABLE trade_signals
  ADD CONSTRAINT trade_signals_signal_type_check
  CHECK (signal_type IN ('handle_match','ca_mention','ticker_mention','dynamic_keyword','follow_discovery'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_signal_follow_discovery_event
  ON trade_signals (follow_discovery_event_id)
  WHERE follow_discovery_event_id IS NOT NULL;

ALTER TABLE follow_discovery_events
  ADD CONSTRAINT follow_discovery_events_whitelist_id_fkey
  FOREIGN KEY (whitelist_id) REFERENCES ca_whitelist(id) ON DELETE SET NULL,
  ADD CONSTRAINT follow_discovery_events_signal_id_fkey
  FOREIGN KEY (signal_id) REFERENCES trade_signals(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS follow_discovery_usage_daily_by_chain (
  policy_id bigint NOT NULL REFERENCES follow_discovery_policies(id) ON DELETE RESTRICT,
  usage_date date NOT NULL,
  chain_id text NOT NULL CHECK (chain_id IN ('sol','bsc','base','eth','robinhood')),
  spent_native numeric(18,8) NOT NULL DEFAULT 0,
  reserved_native numeric(18,8) NOT NULL DEFAULT 0,
  new_token_count int NOT NULL DEFAULT 0,
  signal_count int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (policy_id, usage_date, chain_id)
);

CREATE TABLE IF NOT EXISTS follow_discovery_usage_events (
  id bigserial PRIMARY KEY,
  policy_id bigint NOT NULL REFERENCES follow_discovery_policies(id) ON DELETE RESTRICT,
  signal_id int NOT NULL REFERENCES trade_signals(id) ON DELETE CASCADE UNIQUE,
  chain_id text NOT NULL,
  contract_address text NOT NULL,
  usage_date date NOT NULL DEFAULT CURRENT_DATE,
  amount_native numeric(18,8) NOT NULL,
  counts_new_token boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','committed','released')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_follow_discovery_usage_token
  ON follow_discovery_usage_events
  (policy_id, usage_date, chain_id, contract_address, status);
