-- P20: reusable account-level dynamic strategy templates.

CREATE TABLE IF NOT EXISTS dynamic_policy_templates (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  config jsonb NOT NULL,
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dynamic_policy_templates_name
  ON dynamic_policy_templates (LOWER(name));

CREATE INDEX IF NOT EXISTS idx_dynamic_policy_templates_updated
  ON dynamic_policy_templates (updated_at DESC, id DESC);
