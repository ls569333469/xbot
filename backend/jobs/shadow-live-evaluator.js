const crypto = require('crypto');
const db = require('../lib/db');
const logger = require('../lib/logger');
const { getTradingMode } = require('../lib/runtime-mode');
const engineState = require('../lib/engine-state');
const livePolicy = require('../domains/signal/live-policy');
const executionService = require('../domains/trade/execution-service');

function enabled(value = process.env.SHADOW_LIVE_ENABLED) {
  return String(value || 'false').toLowerCase() === 'true';
}

function policyFingerprint(policy) {
  const normalized = {
    providers: [...(policy.providers || [])].sort(),
    eventTypes: [...(policy.eventTypes || [])].sort(),
    chains: [...(policy.chains || [])].sort(),
    whitelistIds: [...(policy.whitelistIds || [])].map(Number).sort((left, right) => left - right),
    maxSignalAgeSeconds: Number(policy.maxSignalAgeSeconds || 0)
  };
  return {
    hash: crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
    normalized
  };
}

class ShadowLiveEvaluator {
  constructor(options = {}) {
    this.db = options.db || db;
    this.logger = options.logger || logger;
    this.modeProvider = options.modeProvider || getTradingMode;
    this.engine = options.engine || engineState;
    this.policy = options.policy || livePolicy;
    this.builder = options.builder || executionService.buildPrepared;
    this.enabledProvider = options.enabledProvider || enabled;
    this.now = options.now || (() => new Date());
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.processed = 0;
    this.sessionId = null;
    this.sessionPolicyHash = null;
    this.sessionStartedAt = null;
    this.sessionResumed = false;
    this.sessionStats = { total: 0, passed: 0, rejected: 0, failed: 0 };
    this.lastSessionHeartbeatAt = 0;
  }

  async loadSessionStats() {
    if (!this.sessionId) return;
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
              COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM shadow_trade_evaluations WHERE session_id = $1`,
      [this.sessionId]
    );
    const row = result.rows[0] || {};
    this.sessionStats = {
      total: Number(row.total || 0),
      passed: Number(row.passed || 0),
      rejected: Number(row.rejected || 0),
      failed: Number(row.failed || 0)
    };
  }

  async ensureSession(policy) {
    const fingerprint = policyFingerprint(policy);
    const now = this.now();
    if (this.sessionId && this.sessionPolicyHash === fingerprint.hash) {
      if (now.getTime() - this.lastSessionHeartbeatAt >= 5_000) {
        await this.db.query(
          `UPDATE shadow_run_sessions
           SET last_heartbeat_at = $2, updated_at = NOW()
           WHERE id = $1 AND status = 'running'`,
          [this.sessionId, now]
        );
        this.lastSessionHeartbeatAt = now.getTime();
      }
      return this.sessionId;
    }

    const current = (await this.db.query(
      `SELECT *, GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at)) * 1000)::int) AS age_ms
       FROM shadow_run_sessions WHERE status = 'running' ORDER BY id DESC LIMIT 1`
    )).rows[0];
    const resumable = current
      && current.policy_hash === fingerprint.hash
      && Number(current.age_ms || 0) <= 15_000;
    if (current && !resumable) {
      await this.db.query(
        `UPDATE shadow_run_sessions
         SET status = 'interrupted', completed_at = NOW(), stop_reason = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [current.id, current.policy_hash === fingerprint.hash ? 'HEARTBEAT_STALE' : 'POLICY_CHANGED']
      );
    }

    if (resumable) {
      this.sessionId = Number(current.id);
      this.sessionStartedAt = current.started_at;
      this.sessionResumed = true;
    } else {
      const created = await this.db.query(
        `INSERT INTO shadow_run_sessions(
           policy_hash, policy_json, required_duration_hours, required_samples,
           code_version, last_heartbeat_at
         ) VALUES ($1,$2,24,50,$3,$4)
         RETURNING id, started_at`,
        [fingerprint.hash, fingerprint.normalized,
          process.env.XBOT_CODE_VERSION || 'local-worktree', now]
      );
      this.sessionId = Number(created.rows[0].id);
      this.sessionStartedAt = created.rows[0].started_at;
      this.sessionResumed = false;
    }
    this.sessionPolicyHash = fingerprint.hash;
    this.lastSessionHeartbeatAt = now.getTime();
    await this.loadSessionStats();
    return this.sessionId;
  }

  async markExecutionTiming(signalId) {
    await this.db.query(
      `UPDATE x_provider_events AS provider_event
       SET execution_enqueued_at = COALESCE(execution_enqueued_at, NOW()),
           execution_started_at = COALESCE(execution_started_at, NOW()),
           signal_to_execution_ms = GREATEST(0, ROUND(EXTRACT(EPOCH FROM
             (NOW() - signal.created_at)) * 1000)::int),
           updated_at = NOW()
       FROM trade_signals AS signal
       WHERE signal.id = $1
         AND signal.activity_id = ANY(COALESCE(provider_event.activity_ids, '{}'::int[]))`,
      [signalId]
    );
  }

  async evaluateSignal(signal, sessionId = this.sessionId) {
    const claimed = await this.db.query(
      `INSERT INTO shadow_trade_evaluations(signal_id, chain, status, session_id)
       VALUES ($1,$2,'running',$3) ON CONFLICT (signal_id) DO NOTHING RETURNING id`,
      [signal.id, signal.chain_id, sessionId]
    );
    if (claimed.rows.length === 0) return { status: 'duplicate', signalId: signal.id };
    await this.markExecutionTiming(signal.id);
    try {
      const prepared = await this.builder(signal.id, { policyPhase: 'shadow' });
      const passed = prepared.risk.passed && prepared.livePolicy.allowed;
      const status = passed ? 'passed' : 'rejected';
      await this.db.query(
        `UPDATE shadow_trade_evaluations
         SET status = $2, risk_snapshot = $3, quote_summary = $4,
             error_code = $5, completed_at = NOW(), updated_at = NOW()
         WHERE signal_id = $1`,
        [signal.id, status, prepared.riskSnapshot, prepared.summary,
          passed ? null : prepared.risk.reasons[0] || prepared.livePolicy.blockers[0] || 'SHADOW_REJECTED']
      );
      this.processed += 1;
      this.sessionStats.total += 1;
      this.sessionStats[status] += 1;
      return { status, signalId: signal.id };
    } catch (error) {
      await this.db.query(
        `UPDATE shadow_trade_evaluations
         SET status = 'failed', error_code = $2, completed_at = NOW(), updated_at = NOW()
         WHERE signal_id = $1`,
        [signal.id, error.code || error.message]
      );
      this.sessionStats.total += 1;
      this.sessionStats.failed += 1;
      throw error;
    }
  }

  async runOnce() {
    if (this.running) return { status: 'skipped', reason: 'already_running' };
    if (!this.enabledProvider()) return { status: 'skipped', reason: 'disabled' };
    const mode = this.modeProvider();
    const liveLocked = mode === 'live' && !this.engine.getArmed();
    if (mode !== 'signal' && !liveLocked) {
      return { status: 'skipped', reason: mode === 'live' ? 'live_engine_armed' : 'unsupported_mode' };
    }
    const signalExecutionMode = liveLocked ? 'live' : 'signal';
    const signalStatus = liveLocked ? 'recorded' : 'signal_only';
    this.running = true;
    this.lastRunAt = new Date();
    try {
      const policy = await this.policy.getPolicy();
      if (policy.providers.length === 0 || policy.eventTypes.length === 0
          || policy.chains.length === 0 || policy.whitelistIds.length === 0) {
        return { status: 'skipped', reason: 'live_policy_empty' };
      }
      const sessionId = await this.ensureSession(policy);
      const result = await this.db.query(
        `SELECT signal.id, whitelist.chain_id
         FROM trade_signals AS signal
         JOIN ca_whitelist AS whitelist ON whitelist.id = signal.whitelist_id
         LEFT JOIN shadow_trade_evaluations AS shadow ON shadow.signal_id = signal.id
         WHERE signal.status = $4 AND signal.execution_mode = $5
           AND signal.created_at >= NOW() - ($1 * INTERVAL '1 second')
           AND signal.whitelist_id = ANY($2::int[])
           AND whitelist.chain_id = ANY($3::text[])
           AND shadow.id IS NULL
         ORDER BY signal.created_at ASC LIMIT 20`,
        [policy.maxSignalAgeSeconds, policy.whitelistIds, policy.chains,
          signalStatus, signalExecutionMode]
      );
      const results = [];
      for (const signal of result.rows) {
        try {
          results.push(await this.evaluateSignal(signal, sessionId));
        } catch (error) {
          this.lastError = error.code || error.message;
          results.push({ status: 'failed', signalId: signal.id, error: this.lastError });
        }
      }
      this.lastSuccessAt = new Date();
      return { status: 'completed', processed: results.length, results };
    } finally {
      this.running = false;
    }
  }

  start(options = {}) {
    if (this.timer || !this.enabledProvider()) return false;
    const intervalMs = Math.max(250, Number(options.intervalMs || 500));
    void this.runOnce().catch((error) => {
      this.lastError = error.code || error.message;
      this.logger.error('shadow-live', `Initial evaluation failed: ${error.message}`);
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.lastError = error.code || error.message;
        this.logger.error('shadow-live', `Evaluation failed: ${error.message}`);
      });
    }, intervalMs);
    this.timer.unref?.();
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return {
      enabled: this.enabledProvider(),
      running: Boolean(this.timer),
      active: this.running,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      processed: this.processed,
      session: this.sessionId ? {
        id: this.sessionId,
        startedAt: this.sessionStartedAt,
        resumed: this.sessionResumed,
        requiredDurationHours: 24,
        requiredSamples: 50,
        ...this.sessionStats
      } : null
    };
  }
}

const shadowLiveEvaluator = new ShadowLiveEvaluator();

module.exports = { ShadowLiveEvaluator, enabled, policyFingerprint, shadowLiveEvaluator };
