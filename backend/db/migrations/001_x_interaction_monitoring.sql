ALTER TABLE x_kol_accounts
  ADD COLUMN IF NOT EXISTS last_follow_checked_at timestamptz;

ALTER TABLE x_activities
  ADD COLUMN IF NOT EXISTS target_x_handles text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS provider_event_id text,
  ADD COLUMN IF NOT EXISTS source_created_at timestamptz;

UPDATE x_activities
SET target_x_handles = ARRAY[target_x_handle]
WHERE target_x_handle IS NOT NULL
  AND COALESCE(cardinality(target_x_handles), 0) = 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_activities_tweet
  ON x_activities(kol_id, tweet_id)
  WHERE tweet_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_activities_provider_event
  ON x_activities(kol_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
