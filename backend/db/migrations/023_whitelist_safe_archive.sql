ALTER TABLE ca_whitelist
  DROP CONSTRAINT IF EXISTS ca_whitelist_status_check;

ALTER TABLE ca_whitelist
  ADD CONSTRAINT ca_whitelist_status_check
  CHECK (status IN ('active', 'paused', 'exhausted', 'expired', 'archived'));

CREATE INDEX IF NOT EXISTS idx_ca_whitelist_archived
  ON ca_whitelist(updated_at DESC)
  WHERE status = 'archived';
