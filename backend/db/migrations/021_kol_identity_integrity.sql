UPDATE x_kol_accounts
SET x_user_id = lower(regexp_replace(x_handle, '^@+', '')),
    updated_at = NOW()
WHERE x_user_id IS NULL
   OR lower(btrim(x_user_id)) IN ('', 'undefined', 'null');

ALTER TABLE x_kol_accounts
  DROP CONSTRAINT IF EXISTS chk_x_kol_accounts_user_id_valid;

ALTER TABLE x_kol_accounts
  ADD CONSTRAINT chk_x_kol_accounts_user_id_valid
  CHECK (
    x_user_id IS NULL
    OR lower(btrim(x_user_id)) NOT IN ('', 'undefined', 'null')
  );
