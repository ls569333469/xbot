ALTER TABLE x_watch_sync_outbox
  ADD COLUMN IF NOT EXISTS desired_present boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS desired_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS desired_fingerprint text NOT NULL DEFAULT '';

COMMENT ON COLUMN x_watch_sync_outbox.desired_present IS
  'Whether the actor currently requires a managed remote Watch.';
COMMENT ON COLUMN x_watch_sync_outbox.desired_flags IS
  'Normalized full 6551 Watch flag snapshot for the desired version.';
COMMENT ON COLUMN x_watch_sync_outbox.desired_fingerprint IS
  'SHA-256 fingerprint of desired_present and normalized desired_flags.';
