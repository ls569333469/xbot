ALTER TABLE x_kol_accounts
  ADD COLUMN IF NOT EXISTS profile_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS profile_attempt_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS profile_last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS profile_next_retry_at timestamptz DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS profile_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS profile_last_error_code text;

UPDATE x_kol_accounts
SET profile_status = CASE
      WHEN x_user_id IS NOT NULL
       AND lower(btrim(x_user_id)) <> lower(regexp_replace(x_handle, '^@+', ''))
        THEN 'verified'
      ELSE 'pending'
    END,
    profile_next_retry_at = CASE
      WHEN x_user_id IS NOT NULL
       AND lower(btrim(x_user_id)) <> lower(regexp_replace(x_handle, '^@+', ''))
        THEN NULL
      ELSE NOW()
    END,
    profile_verified_at = CASE
      WHEN x_user_id IS NOT NULL
       AND lower(btrim(x_user_id)) <> lower(regexp_replace(x_handle, '^@+', ''))
        THEN COALESCE(profile_verified_at, updated_at, NOW())
      ELSE NULL
    END;

ALTER TABLE x_kol_accounts
  DROP CONSTRAINT IF EXISTS chk_x_kol_accounts_profile_status;

ALTER TABLE x_kol_accounts
  ADD CONSTRAINT chk_x_kol_accounts_profile_status
  CHECK (profile_status IN ('pending', 'verified'));

ALTER TABLE x_kol_accounts
  DROP CONSTRAINT IF EXISTS chk_x_kol_accounts_profile_attempt_count;

ALTER TABLE x_kol_accounts
  ADD CONSTRAINT chk_x_kol_accounts_profile_attempt_count
  CHECK (profile_attempt_count >= 0);

CREATE INDEX IF NOT EXISTS idx_x_kol_accounts_profile_retry
  ON x_kol_accounts(profile_next_retry_at, id)
  WHERE profile_status = 'pending';
