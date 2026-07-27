ALTER TABLE ca_whitelist
  ADD COLUMN IF NOT EXISTS live_activation_state text NOT NULL DEFAULT 'syncing',
  ADD COLUMN IF NOT EXISTS activation_version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS activation_context_hash text,
  ADD COLUMN IF NOT EXISTS activation_error_code text,
  ADD COLUMN IF NOT EXISTS activation_error_detail text,
  ADD COLUMN IF NOT EXISTS activation_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

ALTER TABLE ca_whitelist
  DROP CONSTRAINT IF EXISTS ca_whitelist_live_activation_state_check;

ALTER TABLE ca_whitelist
  ADD CONSTRAINT ca_whitelist_live_activation_state_check
  CHECK (live_activation_state IN ('syncing', 'live_ready', 'sync_failed'));

ALTER TABLE ca_whitelist
  DROP CONSTRAINT IF EXISTS ca_whitelist_activation_version_check;

ALTER TABLE ca_whitelist
  ADD CONSTRAINT ca_whitelist_activation_version_check
  CHECK (activation_version >= 1);

CREATE INDEX IF NOT EXISTS idx_ca_whitelist_live_activation
  ON ca_whitelist(status, live_activation_state, chain_id, id);

CREATE TABLE IF NOT EXISTS whitelist_activation_outbox (
  whitelist_id int PRIMARY KEY REFERENCES ca_whitelist(id) ON DELETE CASCADE,
  desired_version int NOT NULL CHECK(desired_version >= 1),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending', 'processing', 'succeeded', 'failed')),
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

INSERT INTO whitelist_activation_outbox(whitelist_id, desired_version, status)
SELECT id, activation_version, 'pending'
FROM ca_whitelist
WHERE status = 'active'
ON CONFLICT (whitelist_id) DO NOTHING;

ALTER TABLE trade_signals
  ADD COLUMN IF NOT EXISTS activation_wait_version int;

ALTER TABLE trade_signals
  DROP CONSTRAINT IF EXISTS trade_signals_activation_wait_version_check;

ALTER TABLE trade_signals
  ADD CONSTRAINT trade_signals_activation_wait_version_check
  CHECK (activation_wait_version IS NULL OR activation_wait_version >= 1);

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
    CHECK(status IN('prepared', 'consumed', 'expired', 'stale')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arm_preparations_expiry
  ON arm_preparations(status, expires_at);
