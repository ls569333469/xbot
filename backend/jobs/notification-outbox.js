const db = require('../lib/db');
const logger = require('../lib/logger');

class NotificationOutboxWorker {
  constructor() {
    this.timer = null;
    this.running = false;
    this.wsBroadcast = null;
  }

  async claim(limit = 20) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT * FROM notification_outbox
         WHERE status IN ('pending','failed') AND next_attempt_at <= NOW()
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit]
      );
      if (result.rows.length > 0) {
        await client.query(
          `UPDATE notification_outbox SET status = 'sending', updated_at = NOW()
           WHERE id = ANY($1::bigint[])`,
          [result.rows.map((row) => row.id)]
        );
      }
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
          logger.warn('trade-alert', row.topic, row.payload);
          this.wsBroadcast?.({ type: 'trade:alert', payload: row });
          await db.query(
            `UPDATE notification_outbox SET status = 'sent', sent_at = NOW(),
             attempt_count = attempt_count + 1, last_error = NULL, updated_at = NOW()
             WHERE id = $1 AND status = 'sending'`,
            [row.id]
          );
        } catch (error) {
          await db.query(
            `UPDATE notification_outbox SET status = 'failed', attempt_count = attempt_count + 1,
             last_error = $2, next_attempt_at = NOW() + INTERVAL '30 seconds', updated_at = NOW()
             WHERE id = $1`,
            [row.id, error.message]
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
