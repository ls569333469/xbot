const db = require('../lib/db');
const logger = require('../lib/logger');
const market = require('../domains/dynamic-signal/gmgn-market-source');
const repository = require('../domains/dynamic-signal/candidate-repository');
const eventQueue = require('../domains/dynamic-signal/event-queue');
const { p20FeatureState } = require('../lib/p20-features');

const LEASE_SECONDS = 120;

function leaseLostError() {
  const error = new Error('Dynamic launch window lease was lost before persistence');
  error.code = 'DYNAMIC_LAUNCH_WINDOW_LEASE_LOST';
  return error;
}

function updatedOne(result) {
  return result?.rowCount === undefined
    ? result?.rows?.length === 1
    : result.rowCount === 1;
}

async function requestWindow(job, result, executor = db) {
  const terms = (result.extraction?.authorOwnedTerms || [])
    .filter((term) => ['cashtag', 'hashtag', 'approved_name'].includes(term.type));
  if (terms.length === 0) return null;
  const insert = await executor.query(
    `INSERT INTO dynamic_launch_windows(dynamic_job_id, allowed_chain_ids, observed_terms)
     VALUES ($1,$2,$3) ON CONFLICT (dynamic_job_id) DO NOTHING RETURNING *`,
    [job.id, job.allowed_chain_ids || [], JSON.stringify(terms)]
  );
  return insert.rows[0] || null;
}

class DynamicLaunchWindowWorker {
  constructor(options = {}) {
    this.db = options.db || db;
    this.logger = options.logger || logger;
    this.getFeatureState = options.getFeatureState || p20FeatureState;
    this.workerId = options.workerId || `launch-window:${process.pid}:${Date.now()}`;
    this.timer = null;
    this.active = false;
    this.running = false;
  }
  runtimeEnabled() {
    const flags = this.getFeatureState();
    return flags.P20_DYNAMIC_RESOLUTION_ENABLED && flags.P20_RECORD_ENABLED;
  }
  modeEnabled(mode) {
    const flags = this.getFeatureState();
    return eventQueue.effectiveMode(mode, flags) === mode;
  }
  async runOnce() {
    if (this.active) return { status: 'skipped' };
    if (!this.runtimeEnabled()) return { status: 'skipped', reason: 'p20_disabled' };
    this.active = true;
    try {
      const claimed = await this.db.query(
         `WITH candidate AS (
            SELECT id FROM dynamic_launch_windows
            WHERE ((status = 'pending' AND next_attempt_at <= NOW())
              OR (status = 'processing' AND lease_expires_at < NOW()))
              AND expires_at > NOW()
            ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
          ), claimed AS (
            UPDATE dynamic_launch_windows AS launch_window SET status = 'processing',
              attempt_count = attempt_count + 1, worker_id = $1,
              locked_at = NOW(), lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),
              updated_at = NOW()
            FROM candidate WHERE launch_window.id = candidate.id RETURNING launch_window.*
          ) SELECT claimed.*, job.mode AS job_mode
            FROM claimed JOIN dynamic_signal_jobs job ON job.id = claimed.dynamic_job_id`,
        [this.workerId, LEASE_SECONDS]
      );
      const row = claimed.rows[0];
      if (!row) {
        await this.db.query(
          `UPDATE dynamic_launch_windows
           SET status = 'expired', locked_at = NULL, lease_expires_at = NULL, updated_at = NOW()
           WHERE status IN ('pending','processing') AND expires_at <= NOW()`
        );
        return { status: 'idle' };
      }
      try {
        if (!this.modeEnabled(row.job_mode)) {
          const modeUpdate = await this.db.query(
            `UPDATE dynamic_launch_windows SET status = 'failed',
                 last_error = 'DYNAMIC_RUNTIME_MODE_CHANGED', locked_at = NULL,
                 lease_expires_at = NULL, updated_at = NOW()
             WHERE id = $1 AND worker_id = $2 AND status = 'processing'
               AND lease_expires_at > NOW() RETURNING id`, [row.id, this.workerId]
          );
          if (!updatedOne(modeUpdate)) throw leaseLostError();
          await eventQueue.cancel(
            row.dynamic_job_id, 'DYNAMIC_RUNTIME_MODE_CHANGED', this.db, this.workerId
          );
          return { status: 'cancelled', reason: 'runtime_mode_changed', windowId: row.id };
        }
        if (!this.runtimeEnabled()) {
          await this.db.query(
            `UPDATE dynamic_launch_windows SET status = 'pending', next_attempt_at = NOW(),
                locked_at = NULL, lease_expires_at = NULL, updated_at = NOW()
             WHERE id = $1 AND worker_id = $2 AND status = 'processing'
               AND lease_expires_at > NOW()`, [row.id, this.workerId]
          );
          return { status: 'skipped', reason: 'p20_disabled', windowId: row.id };
        }
        const expiresAt = new Date(Date.now() + 60_000);
        for (const chain of row.allowed_chain_ids || []) {
          const renewal = await this.db.query(
            `UPDATE dynamic_launch_windows
             SET lease_expires_at = NOW() + ($3 * INTERVAL '1 second'), updated_at = NOW()
             WHERE id = $1 AND worker_id = $2 AND status = 'processing'
               AND lease_expires_at > NOW() RETURNING id`,
            [row.id, this.workerId, LEASE_SECONDS]
          );
          if (!updatedOne(renewal)) throw leaseLostError();
          const source = await market.fetchTrenches({ chain, limit: 80 });
          await repository.upsertMany(source.candidates, 'gmgn_trenches', this.db, { expiresAt });
        }
        const index = await repository.loadIndex({ allowedChains: row.allowed_chain_ids }, this.db);
        const lookup = index.lookupTerms(row.observed_terms, { allowedChains: row.allowed_chain_ids });
        if (lookup.candidates.length > 0) {
          const resolvedWindow = await this.db.query(
            `UPDATE dynamic_launch_windows SET status = 'resolved', locked_at = NULL,
               lease_expires_at = NULL, updated_at = NOW()
             WHERE id = $1 AND worker_id = $2 AND status = 'processing'
               AND lease_expires_at > NOW() RETURNING id`, [row.id, this.workerId]
          );
          if (!updatedOne(resolvedWindow)) throw leaseLostError();
          await this.db.query(
            `UPDATE dynamic_signal_jobs SET status = 'pending', next_attempt_at = NOW(),
               failure_code = NULL, last_error = NULL, completed_at = NULL, updated_at = NOW()
             WHERE id = $1 AND status = 'rejected'
               AND EXISTS (
                 SELECT 1 FROM dynamic_launch_windows
                 WHERE id = $2 AND status = 'resolved' AND worker_id = $3
               )`, [row.dynamic_job_id, row.id, this.workerId]
          );
          return { status: 'resolved', windowId: row.id };
        }
        const waitingWindow = await this.db.query(
          `UPDATE dynamic_launch_windows SET status = 'pending', next_attempt_at = NOW() + INTERVAL '2 seconds',
             locked_at = NULL, lease_expires_at = NULL, updated_at = NOW()
           WHERE id = $1 AND worker_id = $2 AND status = 'processing'
             AND lease_expires_at > NOW() RETURNING id`, [row.id, this.workerId]
        );
        if (!updatedOne(waitingWindow)) throw leaseLostError();
        return { status: 'waiting', windowId: row.id };
      } catch (error) {
        await this.db.query(
          `UPDATE dynamic_launch_windows SET status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'pending' END,
             next_attempt_at = NOW() + INTERVAL '5 seconds', last_error = $2,
             locked_at = NULL, lease_expires_at = NULL, updated_at = NOW()
           WHERE id = $1 AND worker_id = $3 AND status = 'processing'
             AND lease_expires_at > NOW()`,
          [row.id, error.message, this.workerId]
        );
        return { status: 'failed', error: error.message };
      }
    } finally { this.active = false; }
  }
  start(options = {}) {
    if (this.timer) return;
    this.running = true;
    const interval = Math.max(500, Number(options.intervalMs || 1000));
    const execute = () => void this.runOnce().catch((error) => {
      this.logger.error('dynamic-launch-window', `Worker iteration failed: ${error.message}`);
    });
    execute();
    this.timer = setInterval(execute, interval);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.running = false; }
  getStatus() { return { running: this.running, active: this.active }; }
}
const dynamicLaunchWindowWorker = new DynamicLaunchWindowWorker();
module.exports = { DynamicLaunchWindowWorker, dynamicLaunchWindowWorker, requestWindow };
