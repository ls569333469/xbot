const db = require('../../lib/db');
const logger = require('../../lib/logger');
const engineState = require('../../lib/engine-state');
const { getTradingMode } = require('../../lib/runtime-mode');
const executionService = require('./execution-service');

function scopeFilter(scope = {}, alias = 'signal', startIndex = 1) {
  const type = String(scope.scope_type || 'combined');
  if (type === 'dynamic_policy' && Number.isInteger(Number(scope.scope_id))) {
    return { sql: `${alias}.actor_policy_id = $${startIndex}`, params: [Number(scope.scope_id)] };
  }
  if (type === 'follow_discovery' && Number.isInteger(Number(scope.scope_id))) {
    return { sql: `${alias}.follow_discovery_policy_id = $${startIndex}`, params: [Number(scope.scope_id)] };
  }
  if (type === 'fixed_ca' && Number.isInteger(Number(scope.scope_id))) {
    return { sql: `${alias}.whitelist_id = $${startIndex}`, params: [Number(scope.scope_id)] };
  }
  return { sql: 'TRUE', params: [] };
}

class LiveExecutionQueue {
  constructor(options = {}) {
    this.db = options.db || db;
    this.logger = options.logger || logger;
    this.engine = options.engine || engineState;
    this.modeProvider = options.modeProvider || getTradingMode;
    this.execution = options.execution || executionService;
    this.queue = [];
    this.queuedIds = new Set();
    this.processing = false;
    this.stopping = false;
    this.wsBroadcast = options.wsBroadcast || null;
    this.processed = 0;
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastHistoricalError = null;
    this.lastExecutionAt = null;
    this.idleWaiters = [];
    this.scanTimer = null;
    this.scanRunning = false;
    this.listenerClient = null;
    this.listenerRetryTimer = null;
    this.listenerConnected = false;
    this.lastNotificationAt = null;
  }

  recordError(error) {
    const code = error?.code || error?.message || String(error);
    this.lastError = code;
    this.lastErrorAt = new Date();
    this.lastHistoricalError = { code, at: this.lastErrorAt };
  }

  recordSuccess() {
    this.lastError = null;
    this.lastErrorAt = null;
  }

  configure(options = {}) {
    this.wsBroadcast = options.wsBroadcast || this.wsBroadcast;
    this.stopping = false;
  }

  async scanOnce() {
    if (this.scanRunning) return { status: 'skipped', reason: 'scan_running' };
    if (this.modeProvider() !== 'live' || !this.engine.getArmed()) {
      return { status: 'skipped', reason: 'live_gate_closed' };
    }
    const armedAt = this.engine.getArmedAt?.();
    if (!armedAt) return { status: 'skipped', reason: 'arm_time_unknown' };
    this.scanRunning = true;
    try {
      const maxAgeSeconds = Math.max(1, Number(process.env.SIGNAL_MAX_AGE_SECONDS || 300));
      const scopeGate = scopeFilter(this.engine.getScopeInput?.() || {}, 'signal', 2);
      await this.db.query(
        `UPDATE trade_signals AS signal
         SET status = 'expired',
             reject_reason = CASE
               WHEN lower(COALESCE(activity.provider, '')) = '6551'
                 AND activity.source_created_at IS NULL THEN 'SOURCE_EVENT_TIME_MISSING'
               ELSE 'SIGNAL_EXPIRED'
             END,
             updated_at = NOW()
         FROM x_activities AS activity
           WHERE signal.status = 'recorded' AND signal.execution_mode = 'live'
           AND activity.id = signal.activity_id
           AND (
             (lower(COALESCE(activity.provider, '')) = '6551' AND activity.source_created_at IS NULL)
             OR CASE WHEN lower(COALESCE(activity.provider, '')) = '6551'
               THEN activity.source_created_at ELSE COALESCE(activity.source_created_at, signal.created_at) END
               < NOW() - ($1 * INTERVAL '1 second')
           )`,
         [maxAgeSeconds]
      );
      const result = await this.db.query(
        `SELECT signal.id, signal.execution_mode
         FROM trade_signals AS signal
         JOIN x_activities AS activity ON activity.id = signal.activity_id
         JOIN ca_whitelist AS whitelist ON whitelist.id = signal.whitelist_id
         WHERE signal.status = 'recorded' AND signal.execution_mode = 'live'
           AND whitelist.status = 'active'
           AND whitelist.live_activation_state = 'live_ready'
           AND (signal.activation_wait_version IS NULL
             OR signal.activation_wait_version = whitelist.activation_version)
           AND CASE WHEN lower(COALESCE(activity.provider, '')) = '6551'
             THEN activity.source_created_at ELSE COALESCE(activity.source_created_at, signal.created_at) END >= $1
           AND ${scopeGate.sql}
         ORDER BY COALESCE(activity.source_created_at, signal.created_at) ASC
         LIMIT 20`,
        [armedAt, ...scopeGate.params]
      );
      return { status: 'completed', found: result.rows.length, enqueued: this.enqueue(result.rows) };
    } finally {
      this.scanRunning = false;
    }
  }

  handleNotification(message) {
    if (message?.channel !== 'xbot_live_signal') return 0;
    if (this.modeProvider() !== 'live' || !this.engine.getArmed()) return 0;
    try {
      const signals = JSON.parse(message.payload || '[]');
      this.lastNotificationAt = new Date();
      return this.enqueue(signals, { source: 'postgres-notify' });
    } catch (error) {
      this.recordError({ code: 'LIVE_SIGNAL_NOTIFICATION_INVALID' });
      this.logger.error('live-execution-queue', `Invalid live signal notification: ${error.message}`);
      return 0;
    }
  }

  scheduleListenerReconnect() {
    if (this.stopping || this.listenerRetryTimer) return;
    this.listenerRetryTimer = setTimeout(() => {
      this.listenerRetryTimer = null;
      void this.startListener();
    }, 1000);
    this.listenerRetryTimer.unref?.();
  }

  async startListener() {
    if (this.stopping || this.listenerClient) return;
    try {
      const client = await this.db.pool.connect();
      this.listenerClient = client;
      client.on('notification', (message) => this.handleNotification(message));
      client.on('error', (error) => {
        if (this.listenerClient !== client) return;
        this.listenerConnected = false;
        this.listenerClient = null;
        this.recordError(error);
        try { client.release(true); } catch {}
        this.scheduleListenerReconnect();
      });
      await client.query('LISTEN xbot_live_signal');
      this.listenerConnected = true;
    } catch (error) {
      this.listenerConnected = false;
      this.recordError(error);
      if (this.listenerClient) {
        try { this.listenerClient.release(true); } catch {}
        this.listenerClient = null;
      }
      this.scheduleListenerReconnect();
    }
  }

  async start(options = {}) {
    if (this.scanTimer) return;
    this.stopping = false;
    await this.startListener();
    const intervalMs = Math.max(250, Number(options.intervalMs || 500));
    void this.scanOnce().catch((error) => {
      this.recordError(error);
      this.logger.error('live-execution-queue', `Initial queue scan failed: ${error.message}`);
    });
    this.scanTimer = setInterval(() => {
      void this.scanOnce().catch((error) => {
        this.recordError(error);
        this.logger.error('live-execution-queue', `Queue scan failed: ${error.message}`);
      });
    }, intervalMs);
    this.scanTimer.unref?.();
  }

  enqueue(signals, context = {}) {
    if (this.stopping) return 0;
    let added = 0;
    for (const signal of signals || []) {
      const id = Number(signal?.id);
      if (!Number.isInteger(id) || this.queuedIds.has(id)) continue;
      if (String(signal.execution_mode || '').toLowerCase() !== 'live') continue;
      this.queuedIds.add(id);
      this.queue.push({ signalId: id, context, enqueuedAt: new Date() });
      added += 1;
      void this.markTiming(id, 'enqueued').catch((error) => {
        this.logger.warn('live-execution-queue', `Failed to record enqueue timing: ${error.message}`);
      });
    }
    if (added > 0) void this.pump();
    return added;
  }

  async markTiming(signalId, stage) {
    const assignment = stage === 'enqueued'
      ? 'execution_enqueued_at = COALESCE(execution_enqueued_at, NOW())'
      : `execution_started_at = COALESCE(execution_started_at, NOW()),
         signal_to_execution_ms = GREATEST(0, ROUND(EXTRACT(EPOCH FROM
           (NOW() - COALESCE(activity.source_created_at, signal.created_at))) * 1000)::int)`;
    await this.db.query(
      `UPDATE x_provider_events AS provider_event
       SET ${assignment}, updated_at = NOW()
       FROM trade_signals AS signal
       JOIN x_activities AS activity ON activity.id = signal.activity_id
       WHERE signal.id = $1
         AND signal.activity_id = ANY(COALESCE(provider_event.activity_ids, '{}'::int[]))`,
      [signalId]
    );
  }

  async claimSignal(signalId) {
    const maxAgeSeconds = Math.max(1, Number(process.env.SIGNAL_MAX_AGE_SECONDS || 300));
    await this.db.query(
      `UPDATE trade_signals AS signal
       SET status = 'expired',
           reject_reason = CASE
             WHEN lower(COALESCE(activity.provider, '')) = '6551'
               AND activity.source_created_at IS NULL THEN 'SOURCE_EVENT_TIME_MISSING'
             ELSE 'SIGNAL_EXPIRED'
           END,
           updated_at = NOW()
       FROM x_activities AS activity
       WHERE signal.id = $1 AND signal.status = 'recorded'
         AND activity.id = signal.activity_id
         AND (
           (lower(COALESCE(activity.provider, '')) = '6551' AND activity.source_created_at IS NULL)
           OR CASE WHEN lower(COALESCE(activity.provider, '')) = '6551'
             THEN activity.source_created_at ELSE COALESCE(activity.source_created_at, signal.created_at) END
             < NOW() - ($2 * INTERVAL '1 second')
         )`,
      [signalId, maxAgeSeconds]
    );
    const armedAt = this.engine.getArmedAt?.();
    if (!armedAt) return null;
    const scopeGate = scopeFilter(this.engine.getScopeInput?.() || {}, 'signal', 3);
    const result = await this.db.query(
      `WITH claimed AS (
         UPDATE trade_signals AS signal
         SET status = 'pending', updated_at = NOW()
         FROM x_activities AS activity, ca_whitelist AS whitelist
         WHERE signal.id = $1 AND signal.status = 'recorded' AND signal.execution_mode = 'live'
           AND activity.id = signal.activity_id
           AND whitelist.id = signal.whitelist_id
           AND whitelist.status = 'active'
           AND whitelist.live_activation_state = 'live_ready'
           AND (signal.activation_wait_version IS NULL
             OR signal.activation_wait_version = whitelist.activation_version)
           AND CASE WHEN lower(COALESCE(activity.provider, '')) = '6551'
             THEN activity.source_created_at ELSE COALESCE(activity.source_created_at, signal.created_at) END >= $2
           AND ${scopeGate.sql}
         RETURNING signal.*
       ), timing AS (
         UPDATE x_provider_events AS provider_event
         SET execution_started_at = COALESCE(execution_started_at, NOW()),
             signal_to_execution_ms = GREATEST(0, ROUND(EXTRACT(EPOCH FROM
               (NOW() - COALESCE(activity.source_created_at, claimed.created_at))) * 1000)::int),
             updated_at = NOW()
         FROM claimed
         JOIN x_activities AS activity ON activity.id = claimed.activity_id
         WHERE claimed.activity_id = ANY(COALESCE(provider_event.activity_ids, '{}'::int[]))
       )
       SELECT claimed.*, whitelist.chain_id
       FROM claimed
       JOIN ca_whitelist AS whitelist ON whitelist.id = claimed.whitelist_id`,
      [signalId, armedAt, ...scopeGate.params]
    );
    return result.rows[0] || null;
  }

  async executeItem(item) {
    if (this.modeProvider() !== 'live' || !this.engine.getArmed()) {
      if (this.engine.getStatus?.().status === 'paused_transient') {
        return { status: 'skipped', reason: 'live_gate_temporarily_paused' };
      }
      await this.db.query(
        `UPDATE trade_signals
         SET status = 'signal_only', reject_reason = 'LIVE_TRADING_STOPPED', updated_at = NOW()
         WHERE id = $1 AND status = 'recorded' AND execution_mode = 'live'`,
        [item.signalId]
      );
      return { status: 'skipped', reason: 'live_gate_closed' };
    }
    const signal = await this.claimSignal(item.signalId);
    if (!signal) return { status: 'skipped', reason: 'not_claimable' };
    try {
      const result = await this.execution.executeAutomatic(
        item.signalId,
        '6551-live-worker',
        {
          chainId: signal.chain_id,
          traceId: signal.trace_id,
          strategyScope: require('./runtime-signal-authorization').scoped(signal)
        }
      );
      this.recordSuccess();
      this.lastExecutionAt = new Date();
      this.wsBroadcast?.({
        type: 'trade:execution-submitted',
        payload: { signalId: item.signalId, attemptId: result.attempt_id, status: result.status }
      });
      return { status: 'submitted', result };
    } catch (error) {
      this.recordError(error);
      if (error?.providerWait === true && error?.retryable === true) {
        await this.db.query(
          `UPDATE trade_signals
           SET status = 'recorded', reject_reason = $2, updated_at = NOW()
           WHERE id = $1 AND status = 'pending'`,
          [item.signalId, error.code || 'GMGN_PROVIDER_WAIT']
        );
        this.logger.warn(
          'live-execution-queue',
          `Signal ${item.signalId} deferred until the GMGN cooldown clears: ${error.message}`
        );
        return { status: 'provider_wait', reason: error.code || 'GMGN_PROVIDER_WAIT' };
      }
      await this.db.query(
        `UPDATE trade_signals SET status = 'rejected', reject_reason = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [item.signalId, error.code || error.message]
      );
      throw error;
    }
  }

  async pump() {
    if (this.processing || this.stopping) return;
    this.processing = true;
    try {
      while (!this.stopping && this.queue.length > 0) {
        const item = this.queue.shift();
        try {
          await this.executeItem(item);
          this.processed += 1;
        } catch (error) {
          this.logger.error(
            'live-execution-queue',
            `Signal ${item.signalId} execution failed: ${error.message}`
          );
        } finally {
          this.queuedIds.delete(item.signalId);
        }
      }
    } finally {
      this.processing = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  waitForIdle() {
    if (!this.processing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async stop() {
    this.stopping = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    if (this.listenerRetryTimer) clearTimeout(this.listenerRetryTimer);
    this.listenerRetryTimer = null;
    const listener = this.listenerClient;
    this.listenerClient = null;
    this.listenerConnected = false;
    if (listener) {
      await listener.query('UNLISTEN xbot_live_signal').catch(() => {});
      listener.release();
    }
    await this.waitForIdle();
  }

  getStatus() {
    return {
      running: !this.stopping,
      scannerRunning: Boolean(this.scanTimer),
      listenerConnected: this.listenerConnected,
      lastNotificationAt: this.lastNotificationAt,
      scanActive: this.scanRunning,
      active: this.processing,
      queueDepth: this.queue.length,
      processed: this.processed,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastHistoricalError: this.lastHistoricalError,
      lastExecutionAt: this.lastExecutionAt
    };
  }
}

const liveExecutionQueue = new LiveExecutionQueue();

module.exports = { LiveExecutionQueue, liveExecutionQueue, scopeFilter };
