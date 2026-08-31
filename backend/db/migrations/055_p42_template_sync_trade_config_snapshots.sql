-- P42 additive migration. It only adds signal snapshots and template-sync audit
-- tables; it does not change runtime gates, Engine state, or existing rows.

ALTER TABLE trade_signals
  ADD COLUMN IF NOT EXISTS trade_config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_trade_signals_trade_config_snapshot
  ON trade_signals(whitelist_id, status, id)
  WHERE trade_config_snapshot = '{}'::jsonb;

CREATE TABLE IF NOT EXISTS whitelist_template_sync_runs (
  id bigserial PRIMARY KEY,
  template_id bigint NOT NULL REFERENCES whitelist_templates(id) ON DELETE RESTRICT,
  template_version int NOT NULL CHECK (template_version >= 1),
  requested_whitelist_ids int[] NOT NULL DEFAULT '{}',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whitelist_template_sync_items (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES whitelist_template_sync_runs(id) ON DELETE CASCADE,
  whitelist_id int REFERENCES ca_whitelist(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('updated', 'unchanged', 'skipped')),
  reason_code text,
  reason_detail text,
  before_config jsonb NOT NULL DEFAULT '{}',
  after_config jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whitelist_template_sync_items_run
  ON whitelist_template_sync_items(run_id, id);

CREATE INDEX IF NOT EXISTS idx_whitelist_template_sync_items_whitelist
  ON whitelist_template_sync_items(whitelist_id, created_at DESC);
