-- P27 migration trust root. This migration extends migration bookkeeping only.

ALTER TABLE schema_migrations
  ADD COLUMN IF NOT EXISTS checksum_sha256 text,
  ADD COLUMN IF NOT EXISTS migration_manifest_id bigint,
  ADD COLUMN IF NOT EXISTS release_sha text;

ALTER TABLE schema_migrations
  DROP CONSTRAINT IF EXISTS schema_migrations_checksum_sha256_check;
ALTER TABLE schema_migrations
  ADD CONSTRAINT schema_migrations_checksum_sha256_check
  CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;

CREATE TABLE IF NOT EXISTS release_migration_manifests (
  id bigserial PRIMARY KEY,
  release_sha text NOT NULL UNIQUE,
  manifest_digest text NOT NULL UNIQUE CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  migration_count int NOT NULL CHECK (migration_count > 0),
  first_migration text NOT NULL,
  last_migration text NOT NULL,
  manifest_json jsonb NOT NULL,
  signed_by text NOT NULL,
  confirmed_by text NOT NULL,
  confirmation_note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE schema_migrations
  DROP CONSTRAINT IF EXISTS schema_migrations_migration_manifest_id_fkey;
ALTER TABLE schema_migrations
  ADD CONSTRAINT schema_migrations_migration_manifest_id_fkey
  FOREIGN KEY (migration_manifest_id) REFERENCES release_migration_manifests(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_schema_migrations_manifest
  ON schema_migrations(migration_manifest_id, name);
