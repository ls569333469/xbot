const db = require('../lib/db');
const logger = require('../lib/logger');
const crypto = require('node:crypto');
const { entityEnvelope } = require('../lib/entity-outbox');

const DEFAULT_LEASE_MS = 30_000;

class NotificationOutboxWorker {
  constructor(options = {}) {
    this.timer = null;
    this.running = false;
    this.wsBroadcast = null;
    this.workerId = options.workerId || `outbox:${process.pid}:${crypto.randomUUID()}`;
    this.leaseMs = Math.max(5_000, Number(options.leaseMs || DEFAULT_LEASE_MS));
  }

  async claim(limit = 20) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `WITH due AS (
           SELECT id FROM notification_outbox
           WHERE next_attempt_at <= NOW()
             AND (
               status IN ('pending','failed')
               OR (status = 'sending' AND locked_at < NOW() - ($2::bigint * INTERVAL '1 millisecond'))
             )
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE notification_outbox AS item
         SET status = 'sending', locked_at = NOW(), locked_by = $3, updated_at = NOW()
         FROM due WHERE item.id = due.id
         RETURNING item.*`,
        [Math.min(100, Math.max(1, Number(limit))), this.leaseMs, this.workerId]
      );
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async runOnce() {
    if (this.running) return { status: 'busy' };
    this.running = true;
    try {
      const rows = await this.claim();
      for (const row of rows) {
        try {
          if (row.channel === 'entity_event') {
            this.wsBroadcast?.(entityEnvelope(row));
          } else {
            logger.warn('trade-alert', row.topic, row.payload);
            this.wsBroadcast?.({ type: 'trade:alert', payload: row });
          }
          await db.query(
            `UPDATE notification_outbox SET status = 'sent', sent_at = NOW(),
             attempt_count = attempt_count + 1, last_error = NULL,
             locked_at = NULL, locked_by = NULL, updated_at = NOW()
             WHERE id = $1 AND status = 'sending' AND locked_by = $2`,
            [row.id, this.workerId]
          );
        } catch (error) {
          await db.query(
            `UPDATE notification_outbox SET status = 'failed', attempt_count = attempt_count + 1,
             last_error = $2, next_attempt_at = NOW() + INTERVAL '30 seconds',
             locked_at = NULL, locked_by = NULL, updated_at = NOW()
             WHERE id = $1 AND status = 'sending' AND locked_by = $3`,
            [row.id, error.message, this.workerId]
          );
        }
      }
      return { status: 'completed', processed: rows.length };
    } finally {
      this.running = false;
    }
  }

  start(options = {}) {
    if (this.timer) return;
    this.wsBroadcast = options.wsBroadcast || this.wsBroadcast;
    void this.runOnce().catch((error) => logger.error('trade-outbox', error.message));
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => logger.error('trade-outbox', error.message));
    }, Math.max(1000, Number(options.intervalMs || 2000)));
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const outboxWorker = new NotificationOutboxWorker();
module.exports = { NotificationOutboxWorker, outboxWorker, run: () => outboxWorker.runOnce() };
