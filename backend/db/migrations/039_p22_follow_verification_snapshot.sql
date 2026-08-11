-- P22: carry the P21 GMGN verification snapshot into activation without re-reading it.

ALTER TABLE ca_whitelist
  ADD COLUMN IF NOT EXISTS provider_verification_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
