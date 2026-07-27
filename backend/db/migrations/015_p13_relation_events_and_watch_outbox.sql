ALTER TABLE x_signal_relations
  ADD COLUMN IF NOT EXISTS event_types text[] NOT NULL
  DEFAULT ARRAY['tweet','retweet','quote','reply','follow']::text[];

UPDATE x_signal_relations
SET event_types = ARRAY['tweet','retweet','quote','reply','follow']::text[]
WHERE event_types IS NULL OR cardinality(event_types) = 0;

ALTER TABLE x_signal_relations
  DROP CONSTRAINT IF EXISTS x_signal_relations_event_types_check;
ALTER TABLE x_signal_relations
  ADD CONSTRAINT x_signal_relations_event_types_check CHECK(
    cardinality(event_types) > 0
    AND event_types <@ ARRAY['tweet','retweet','quote','reply','follow']::text[]
  );

CREATE TABLE IF NOT EXISTS x_watch_sync_outbox (
  actor_handle text PRIMARY KEY,
  desired_version bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','processing','succeeded','failed')),
  attempt_count int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  locked_at timestamptz,
  last_error text,
  requested_at timestamptz NOT NULL DEFAULT NOW(),
  synced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_x_watch_sync_outbox_due
  ON x_watch_sync_outbox(status, next_attempt_at);
