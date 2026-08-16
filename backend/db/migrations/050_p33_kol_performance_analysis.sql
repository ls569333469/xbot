-- P33: independent, read-only KOL performance analysis and account profiles.
-- This migration deliberately does not alter live signals, execution, or position tables.

CREATE TABLE IF NOT EXISTS kol_performance_runs (
  id bigserial PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('post_calls', 'follow_discovery')),
  actor_handle text NOT NULL,
  sample_started_at timestamptz,
  sample_ended_at timestamptz,
  as_of_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'extracting', 'pricing', 'completed', 'no_samples', 'price_retry', 'failed')),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason_codes text[] NOT NULL DEFAULT '{}',
  error_code text,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kol_performance_runs_mode_actor
  ON kol_performance_runs (mode, actor_handle, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kol_performance_runs_claim
  ON kol_performance_runs (status, created_at)
  WHERE status IN ('pending', 'extracting', 'pricing');

CREATE TABLE IF NOT EXISTS kol_performance_events (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES kol_performance_runs(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('tweet', 'reply', 'quote', 'follow')),
  source_id text NOT NULL,
  source_url text,
  target_handle text,
  source_occurred_at timestamptz NOT NULL,
  content_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  extraction_status text NOT NULL
    CHECK (extraction_status IN ('resolved', 'no_match', 'ambiguous', 'provider_failed')),
  chain_id text CHECK (chain_id IS NULL OR chain_id IN ('sol', 'bsc', 'base', 'eth', 'robinhood')),
  contract_address text,
  contract_address_key text,
  token_name text,
  token_symbol text,
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK ((chain_id IS NULL) = (contract_address IS NULL)),
  CHECK ((contract_address IS NULL) = (contract_address_key IS NULL)),
  CHECK (chain_id IS NULL OR chain_id = 'sol' OR contract_address = lower(contract_address)),
  UNIQUE (run_id, source_type, source_id, contract_address_key)
);

CREATE INDEX IF NOT EXISTS idx_kol_performance_events_run_time
  ON kol_performance_events (run_id, source_occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_kol_performance_events_asset
  ON kol_performance_events (chain_id, contract_address_key)
  WHERE chain_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kol_performance_assets (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES kol_performance_runs(id) ON DELETE CASCADE,
  first_event_id bigint NOT NULL REFERENCES kol_performance_events(id) ON DELETE RESTRICT,
  chain_id text NOT NULL CHECK (chain_id IN ('sol', 'bsc', 'base', 'eth', 'robinhood')),
  contract_address text NOT NULL,
  contract_address_key text NOT NULL,
  token_name text,
  token_symbol text,
  entry_price numeric,
  entry_candle_at timestamptz,
  peak_price numeric,
  peak_candle_at timestamptz,
  peak_multiple numeric,
  price_status text NOT NULL DEFAULT 'pending'
    CHECK (price_status IN ('pending', 'completed', 'retry', 'no_data', 'failed')),
  price_error_code text,
  price_error_detail text,
  price_attempt_count int NOT NULL DEFAULT 0 CHECK (price_attempt_count >= 0),
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (chain_id = 'sol' OR contract_address = lower(contract_address)),
  UNIQUE (run_id, chain_id, contract_address_key)
);

CREATE INDEX IF NOT EXISTS idx_kol_performance_assets_price
  ON kol_performance_assets (run_id, price_status, id);

CREATE TABLE IF NOT EXISTS kol_price_replay_cache (
  chain_id text NOT NULL CHECK (chain_id IN ('sol', 'bsc', 'base', 'eth', 'robinhood')),
  contract_address_key text NOT NULL,
  resolution text NOT NULL,
  from_unix bigint NOT NULL,
  to_unix bigint NOT NULL,
  provider_version text NOT NULL,
  rows_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, contract_address_key, resolution, from_unix, to_unix, provider_version),
  CHECK (from_unix > 0 AND to_unix > from_unix)
);

CREATE TABLE IF NOT EXISTS kol_profile_runs (
  id bigserial PRIMARY KEY,
  actor_handle text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kol_profile_runs_actor
  ON kol_profile_runs (actor_handle, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kol_profile_runs_claim
  ON kol_profile_runs (status, created_at) WHERE status IN ('pending', 'running');
