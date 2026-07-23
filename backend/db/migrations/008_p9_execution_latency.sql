ALTER TABLE x_provider_events
  ADD COLUMN IF NOT EXISTS execution_enqueued_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS swap_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS signal_to_execution_ms int,
  ADD COLUMN IF NOT EXISTS receive_to_swap_ms int;

CREATE INDEX IF NOT EXISTS idx_provider_events_execution_latency
  ON x_provider_events(provider, received_at DESC)
  WHERE swap_started_at IS NOT NULL;
