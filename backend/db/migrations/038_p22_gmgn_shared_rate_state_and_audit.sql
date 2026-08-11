-- P22: share GMGN cooldown/rate state across execution processes and preserve request provenance.

CREATE TABLE IF NOT EXISTS gmgn_rate_limit_state (
  scope_key text PRIMARY KEY,
  rate_per_second numeric(12,4) NOT NULL,
  capacity numeric(12,4) NOT NULL,
  available_tokens numeric(18,6) NOT NULL,
  refilled_at timestamptz NOT NULL DEFAULT NOW(),
  cooldown_until timestamptz,
  last_429_at timestamptz,
  last_reset_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE provider_rate_events
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS process_role text,
  ADD COLUMN IF NOT EXISTS signal_id bigint,
  ADD COLUMN IF NOT EXISTS policy_id bigint,
  ADD COLUMN IF NOT EXISTS whitelist_id int,
  ADD COLUMN IF NOT EXISTS context_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_provider_rate_events_source_created
  ON provider_rate_events(provider, source, created_at DESC);
