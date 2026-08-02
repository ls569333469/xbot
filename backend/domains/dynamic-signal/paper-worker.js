const db = require('../../lib/db');
const logger = require('../../lib/logger');
const paperEngine = require('../trade/paper-engine');

async function ensureSession(policyId, policyRevision, executor = db) {
  const current = await executor.query(
    `SELECT * FROM dynamic_paper_sessions
     WHERE actor_policy_id = $1 AND policy_revision = $2 AND status = 'running'
     ORDER BY id DESC LIMIT 1`, [Number(policyId), Number(policyRevision)]
  );
  if (current.rows[0]) return current.rows[0];
  const result = await executor.query(
    `INSERT INTO dynamic_paper_sessions(actor_policy_id, policy_revision)
     VALUES ($1,$2)
     ON CONFLICT (actor_policy_id, policy_revision) WHERE status = 'running'
     DO NOTHING RETURNING *`, [Number(policyId), Number(policyRevision)]
  );
  if (!result.rows[0]) {
    const concurrent = await executor.query(
      `SELECT * FROM dynamic_paper_sessions
       WHERE actor_policy_id = $1 AND policy_revision = $2 AND status = 'running'
       ORDER BY id DESC LIMIT 1`, [Number(policyId), Number(policyRevision)]
    );
    if (concurrent.rows[0]) return concurrent.rows[0];
    throw new Error('Paper session creation lost its running-session race');
  }
  return result.rows[0];
}

async function createEvaluation(sessionId, targetId, signalId, executor = db) {
  const result = await executor.query(
    `INSERT INTO dynamic_paper_evaluations
      (paper_session_id, dynamic_target_id, signal_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (paper_session_id, dynamic_target_id) DO NOTHING
     RETURNING *`, [sessionId, targetId, signalId]
  );
  return result.rows[0] || null;
}

async function execute(evaluation, signal, wsBroadcast, executor = db) {
  if (!evaluation || !signal) return null;
  try {
    const position = await paperEngine.openSimulatedPosition(signal, wsBroadcast);
    await executor.query(
      `UPDATE dynamic_paper_evaluations SET status = 'open', position_id = $2,
       entry_snapshot = $3, updated_at = NOW() WHERE id = $1`,
      [evaluation.id, position.id, {
        entry_price: position.entry_price,
        amount_in: position.amount_in,
        opened_at: position.opened_at
      }]
    );
    return position;
  } catch (error) {
    await executor.query(
      `UPDATE dynamic_paper_evaluations SET status = 'failed', failure_code = $2,
       result_snapshot = $3, updated_at = NOW() WHERE id = $1`,
      [evaluation.id, String(error.code || 'PAPER_OPEN_FAILED'), { message: error.message }]
    );
    throw error;
  }
}

async function completeEligibleSessions(executor = db) {
  const result = await executor.query(
    `UPDATE dynamic_paper_sessions session SET status = 'completed', completed_at = NOW(),
       summary = jsonb_build_object(
         'evaluations', (SELECT COUNT(*) FROM dynamic_paper_evaluations e WHERE e.paper_session_id = session.id),
         'open', (SELECT COUNT(*) FROM dynamic_paper_evaluations e WHERE e.paper_session_id = session.id AND e.status = 'open'),
         'closed', (SELECT COUNT(*) FROM dynamic_paper_evaluations e WHERE e.paper_session_id = session.id AND e.status = 'closed'),
         'failed', (SELECT COUNT(*) FROM dynamic_paper_evaluations e WHERE e.paper_session_id = session.id AND e.status = 'failed')
       )
     WHERE session.status = 'running' AND session.ends_at <= NOW()
     RETURNING session.*`
  );
  return result.rows;
}

class DynamicPaperSessionWorker {
  constructor(options = {}) {
    this.db = options.db || db;
    this.logger = options.logger || logger;
    this.timer = null;
    this.active = false;
    this.running = false;
    this.lastRunAt = null;
    this.lastError = null;
  }

  async runOnce() {
    if (this.active) return { status: 'skipped', reason: 'already_running' };
    this.active = true;
    this.lastRunAt = new Date();
    try {
      const sessions = await completeEligibleSessions(this.db);
      this.lastError = null;
      return { status: 'completed', completed: sessions.length };
    } catch (error) {
      this.lastError = String(error.code || error.message);
      this.logger.error('dynamic-paper-session-worker', `Paper session completion failed: ${error.message}`);
      return { status: 'failed', error: this.lastError };
    } finally {
      this.active = false;
    }
  }

  start(options = {}) {
    if (this.timer) return;
    this.running = true;
    const intervalMs = Math.max(30_000, Number(options.intervalMs || 60_000));
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  getStatus() {
    return {
      running: this.running,
      active: this.active,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError
    };
  }
}

const dynamicPaperSessionWorker = new DynamicPaperSessionWorker();
module.exports = {
  DynamicPaperSessionWorker,
  completeEligibleSessions,
  createEvaluation,
  dynamicPaperSessionWorker,
  ensureSession,
  execute
};
