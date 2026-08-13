const db = require('../../lib/db');
const logger = require('../../lib/logger');
const { X6551Client } = require('../../lib/x-client-6551');
const service = require('./service');
const backtest = require('./backtest');

function deriveRunStatus(counts = {}) {
  const pending = Number(counts.pending_count || 0);
  const running = Number(counts.running_count || 0);
  const completed = Number(counts.completed_count || 0);
  const failed = Number(counts.failed_count || 0) + Number(counts.partial_count || 0);
  if (pending + running > 0) return 'running';
  if (failed > 0 && completed === 0) return 'failed';
  if (failed > 0) return 'partial';
  return 'completed';
}

class ActorScreeningWorker {
  constructor(options = {}) {
    this.timer = null; this.active = false; this.running = false;
    this.db = options.db || db; this.logger = options.logger || logger;
  }
  async runOnce() {
    if (this.active) return { status: 'skipped' };
    this.active = true;
    try {
      const result = await this.db.query(
        `SELECT run.id, result.id AS result_id, result.x_handle
         FROM x_actor_screening_runs run
         JOIN x_actor_screening_results result ON result.screening_run_id = run.id
         WHERE run.status IN('pending','running') AND result.status = 'pending'
         ORDER BY run.created_at ASC, result.id ASC LIMIT 1`
      );
      const row = result.rows[0];
      if (!row) return { status: 'idle' };
      await this.db.query(`UPDATE x_actor_screening_runs SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1`, [row.id]);
      await this.db.query(`UPDATE x_actor_screening_results SET status = 'running', started_at = NOW() WHERE id = $1`, [row.result_id]);
      try {
        const client = new X6551Client(process.env.OPENNEWS_TOKEN);
        const summary = await backtest.runActor(row.x_handle, { xClient: client });
        await backtest.persistResult(row.id, summary, this.db);
      } catch (error) {
        await this.db.query(
          `UPDATE x_actor_screening_results SET status = 'failed', error_code = $2,
             last_error = $3, completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [row.result_id, String(error.code || 'SCREENING_FAILED'), error.message]
        );
      }
      const countsResult = await this.db.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
                COUNT(*) FILTER (WHERE status = 'running')::int AS running_count,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
                COUNT(*) FILTER (WHERE status = 'partial')::int AS partial_count,
                MIN(CONCAT_WS(': ', NULLIF(error_code, ''), NULLIF(last_error, '')))
                  FILTER (WHERE status IN ('failed','partial')) AS first_error
         FROM x_actor_screening_results WHERE screening_run_id = $1`, [row.id]
      );
      const counts = countsResult.rows[0] || {};
      const runStatus = deriveRunStatus(counts);
      const terminal = !['pending', 'running'].includes(runStatus);
      await this.db.query(
        `UPDATE x_actor_screening_runs
         SET status = $2, last_error = $3,
             completed_at = CASE WHEN $4 THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, runStatus, counts.first_error || null, terminal]
      );
      return { status: 'completed', runId: row.id, handle: row.x_handle };
    } finally { this.active = false; }
  }
  start(options = {}) { if (this.timer) return; this.running = true; const interval = Math.max(1000, Number(options.intervalMs || 2000)); void this.runOnce(); this.timer = setInterval(() => void this.runOnce(), interval); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.running = false; }
  getStatus() { return { running: this.running, active: this.active }; }
}
const actorScreeningWorker = new ActorScreeningWorker();
module.exports = { ActorScreeningWorker, actorScreeningWorker, deriveRunStatus };
