-- P23: make live arm scope and readiness snapshot explicit and auditable.
-- Additive only. Existing runtime state and historical trade records remain intact.

ALTER TABLE arm_preparations
  ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'combined',
  ADD COLUMN IF NOT EXISTS scope_id bigint,
  ADD COLUMN IF NOT EXISTS scope_chain_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS scope_revision int,
  ADD COLUMN IF NOT EXISTS scope_manifest_hash text,
  ADD COLUMN IF NOT EXISTS readiness_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS probe_requested boolean NOT NULL DEFAULT true;

ALTER TABLE arm_preparations
  DROP CONSTRAINT IF EXISTS arm_preparations_scope_type_check;

ALTER TABLE arm_preparations
  ADD CONSTRAINT arm_preparations_scope_type_check
  CHECK (scope_type IN ('combined','fixed_ca','dynamic_policy','follow_discovery'));

CREATE INDEX IF NOT EXISTS idx_arm_preparations_scope
  ON arm_preparations(scope_type, scope_id, created_at DESC);

ALTER TABLE trade_runtime_state
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT NOW();
