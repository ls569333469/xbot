-- P27 extends the existing outbox for durable entity events and lease recovery.

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'alert',
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text;

ALTER TABLE notification_outbox
  DROP CONSTRAINT IF EXISTS notification_outbox_channel_check;
ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_channel_check
  CHECK (channel IN ('alert','entity_event')) NOT VALID;
ALTER TABLE notification_outbox VALIDATE CONSTRAINT notification_outbox_channel_check;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_outbox_channel_dedupe
  ON notification_outbox(channel, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_claim
  ON notification_outbox(channel, status, next_attempt_at, locked_at, id);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_retention
  ON notification_outbox(status, sent_at, id)
  WHERE status IN ('sent','failed');
