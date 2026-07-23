CREATE TABLE IF NOT EXISTS service_heartbeats (
  role text PRIMARY KEY CHECK (role IN ('all', 'ingestion', 'execution')),
  instance_id text NOT NULL,
  process_id integer,
  status_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_heartbeats_heartbeat
  ON service_heartbeats(heartbeat_at DESC);

