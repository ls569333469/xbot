ALTER TABLE x_provider_events
  ADD COLUMN IF NOT EXISTS trace_id text,
  ADD COLUMN IF NOT EXISTS timing_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS swap_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS receive_to_submitted_ms int;

ALTER TABLE x_activities
  ADD COLUMN IF NOT EXISTS trace_id text;

ALTER TABLE trade_signals
  ADD COLUMN IF NOT EXISTS trace_id text;

ALTER TABLE trade_attempts
  ADD COLUMN IF NOT EXISTS trace_id text,
  ADD COLUMN IF NOT EXISTS timing_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE trade_orders
  ADD COLUMN IF NOT EXISTS reconciliation_claim_token text,
  ADD COLUMN IF NOT EXISTS reconciliation_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_available_at timestamptz;

UPDATE x_provider_events
SET trace_id = 'provider-event:' || id
WHERE trace_id IS NULL;

UPDATE x_activities AS activity
SET trace_id = provider_event.trace_id
FROM x_provider_events AS provider_event
WHERE activity.trace_id IS NULL
  AND activity.id = ANY(COALESCE(provider_event.activity_ids, '{}'::int[]));

UPDATE trade_signals AS signal
SET trace_id = COALESCE(activity.trace_id, 'signal:' || signal.id)
FROM x_activities AS activity
WHERE signal.activity_id = activity.id AND signal.trace_id IS NULL;

UPDATE trade_attempts AS attempt
SET trace_id = COALESCE(signal.trace_id, 'attempt:' || attempt.id)
FROM trade_signals AS signal
WHERE attempt.signal_id = signal.id AND attempt.trace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_provider_events_trace_id
  ON x_provider_events(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_signals_trace_id
  ON trade_signals(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_attempts_trace_id
  ON trade_attempts(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_orders_reconciliation_claim
  ON trade_orders(reconciliation_claimed_at)
  WHERE reconciliation_claim_token IS NOT NULL;
