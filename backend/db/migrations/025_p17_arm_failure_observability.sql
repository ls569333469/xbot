ALTER TABLE arm_preparations
  DROP CONSTRAINT IF EXISTS arm_preparations_status_check;

ALTER TABLE arm_preparations
  ADD CONSTRAINT arm_preparations_status_check
  CHECK(status IN('prepared','arming','consumed','expired','stale','failed'));

ALTER TABLE arm_preparations
  ADD COLUMN IF NOT EXISTS failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS failure_detail text;
