-- P35: account-scoped deterministic keyword-to-asset routes.
-- Routes reference the canonical dynamic asset variant; chain and address are
-- read from that variant so authorization cannot drift across duplicate fields.

CREATE TABLE IF NOT EXISTS dynamic_policy_asset_routes (
  id bigserial PRIMARY KEY,
  actor_policy_id bigint NOT NULL
    REFERENCES x_actor_dynamic_policies(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  variant_id bigint NOT NULL
    REFERENCES dynamic_asset_variants(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  verification_source text NOT NULL
    CHECK (verification_source = 'local_rpc'),
  verification_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (id, actor_policy_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dynamic_policy_asset_routes_active_asset
  ON dynamic_policy_asset_routes(actor_policy_id, variant_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dynamic_policy_asset_routes_policy
  ON dynamic_policy_asset_routes(actor_policy_id, enabled, id)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS dynamic_policy_asset_aliases (
  id bigserial PRIMARY KEY,
  route_id bigint NOT NULL,
  actor_policy_id bigint NOT NULL,
  alias_text text NOT NULL CHECK (char_length(alias_text) BETWEEN 1 AND 80),
  normalized_key text NOT NULL CHECK (length(normalized_key) > 0),
  sort_order int NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (route_id, actor_policy_id)
    REFERENCES dynamic_policy_asset_routes(id, actor_policy_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dynamic_policy_asset_aliases_active_key
  ON dynamic_policy_asset_aliases(actor_policy_id, normalized_key)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dynamic_policy_asset_aliases_route
  ON dynamic_policy_asset_aliases(route_id, sort_order, id)
  WHERE archived_at IS NULL;

ALTER TABLE dynamic_ca_resolution_attempts
  ADD COLUMN IF NOT EXISTS selected_preset_route_id bigint
    REFERENCES dynamic_policy_asset_routes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS preset_route_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE dynamic_ca_resolution_candidates
  ADD COLUMN IF NOT EXISTS preset_route_id bigint
    REFERENCES dynamic_policy_asset_routes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS preset_route_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
