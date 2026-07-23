ALTER TABLE x_activities
  ADD COLUMN IF NOT EXISTS semantic_key text;

ALTER TABLE x_activities
  DROP CONSTRAINT IF EXISTS x_activities_activity_type_check;
ALTER TABLE x_activities
  ADD CONSTRAINT x_activities_activity_type_check
  CHECK(activity_type IN('tweet','retweet','quote','reply','follow','unfollow'));

ALTER TABLE trade_signals
  ADD COLUMN IF NOT EXISTS canonical_key text,
  ADD COLUMN IF NOT EXISTS matched_project_handles text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS matched_whitelist_ids int[] NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_signals_canonical
  ON trade_signals(canonical_key)
  WHERE canonical_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS x_provider_watches (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  username text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  desired_flags jsonb NOT NULL DEFAULT '{}',
  remote_flags jsonb NOT NULL DEFAULT '{}',
  managed boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'observed'
    CHECK(sync_status IN('observed','in_sync','pending_add','pending_update','pending_delete','error')),
  last_seen_remote_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(provider, username)
);

CREATE TABLE IF NOT EXISTS x_provider_events (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text,
  tw_account text,
  semantic_key text,
  provider_created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT NOW(),
  raw_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','processing','processed','ignored','dead_letter')),
  attempt_count int NOT NULL DEFAULT 0,
  activity_ids int[] NOT NULL DEFAULT '{}',
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_watches_provider_managed
  ON x_provider_watches(provider, managed, sync_status);
CREATE INDEX IF NOT EXISTS idx_provider_events_status_received
  ON x_provider_events(provider, status, received_at);
CREATE INDEX IF NOT EXISTS idx_provider_events_created
  ON x_provider_events(provider, provider_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_semantic
  ON x_activities(kol_id, semantic_key)
  WHERE semantic_key IS NOT NULL;
