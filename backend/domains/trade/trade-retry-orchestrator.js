const db = require('../../lib/db');
const logger = require('../../lib/logger');
const intentRepository = require('./trade-intent-repository');
const { walletWriteLane } = require('./wallet-write-lane');
const { TradeCircuitBreaker } = require('./trade-circuit-breaker');

const CANCEL_CODES = new Set([
  'RETRY_RUNTIME_DISABLED',
  'LIVE_READINESS_FAILED',
  'LIVE_CHAIN_READINESS_FAILED',
  'LIVE_ENGINE_NOT_ARMED',
  'LIVE_TRADING_DISABLED',
  'EMERGENCY_STOP_ACTIVE',
  'SIGNAL_TOO_OLD',
  'CHAIN_CONSECUTIVE_FAILURE_LOCK'
]);

class TradeRetryOrchestrator {
  constructor(options = {}) {
    this.db = options.db || db;
    this.logger = options.logger || logger;
    this.intentRepository = options.intentRepository || intentRepository;
    this.walletLane = options.walletLane || walletWriteLane;
    this.circuitBreaker = options.circuitBreaker || new TradeCircuitBreaker({ db: this.db });
    this.buyHandler = options.buyHandler || null;
    this.sellHandler = options.sellHandler || null;
    this.timer = null;
    this.running = false;
    this.startedAt = null;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.processed = 0;
    this.succeeded = 0;
    this.lastMaintenanceAt = null;
    this.maintenanceIntervalMs = Math.max(1000, Number(options.maintenanceIntervalMs || 5000));
  }

  handler(side) {
    if (side === 'buy') {
      return this.buyHandler || require('./execution-service').retryIntent;
    }
    return this.sellHandler || require('./close-service').retryIntent;
  }

  async resolveHandlerFailure(intent, error) {
    const current = await this.intentRepository.getIntent(intent.id, this.db);
    if (!current || current.status !== 'retry_verifying') return current;
    const terminalStatus = CANCEL_CODES.has(error.code) ? 'cancelled' : 'rejected';
    return this.intentRepository.finishRetryClaim(
      intent.id,
      terminalStatus,
      error.code || 'RETRY_PRE_SUBMIT_FAILED',
      this.db
    );
  }

  async runOnce() {
    if (this.running) return { status: 'skipped', reason: 'already_running' };
    this.running = true;
    this.lastRunAt = new Date();
    try {
      let staleWrites = [];
      let stalePreSubmit = [];
      let restoredClaims = [];
      let expiredIntents = [];
      const maintenanceDue = !this.lastMaintenanceAt
        || Date.now() - this.lastMaintenanceAt.getTime() >= this.maintenanceIntervalMs;
      if (maintenanceDue) {
        staleWrites = await this.walletLane.recoverStaleSubmissions();
        stalePreSubmit = await this.intentRepository.recoverStalePreSubmitAttempts(
          90,
          50,
          this.db
        );
        restoredClaims = await this.intentRepository.restoreAbandonedClaims(this.db);
        expiredIntents = await this.intentRepository.expireScheduledRetries(50, this.db);
        this.lastMaintenanceAt = new Date();
      }
      const intents = await this.intentRepository.claimDueRetries(10, this.db);
      const results = [];
      for (const intent of intents) {
        try {
          const result = await this.handler(intent.side)(intent, 'retry-worker');
          results.push({ intentId: intent.id, status: result.status, attemptId: result.attempt_id });
          this.succeeded += 1;
        } catch (error) {
          await this.resolveHandlerFailure(intent, error);
          results.push({ intentId: intent.id, status: 'error', error: error.code || error.message });
          this.lastError = error.message;
          this.logger.warn('trade-retry', `Intent ${intent.id} retry stopped: ${error.message}`);
        }
        this.processed += 1;
      }
      this.lastSuccessAt = new Date();
      return {
        status: 'completed',
        claimed: intents.length,
        restoredClaims: restoredClaims.length,
        staleWrites: staleWrites.length,
        stalePreSubmit: stalePreSubmit.length,
        expiredIntents: expiredIntents.length,
        results
      };
    } finally {
      this.running = false;
    }
  }

  start(options = {}) {
    if (this.timer) return;
    const intervalMs = Math.max(100, Number(options.intervalMs || 100));
    this.startedAt = new Date();
    void this.runOnce().catch((error) => {
      this.lastError = error.message;
      this.logger.error('trade-retry', `Startup retry scan failed: ${error.message}`);
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.lastError = error.message;
        this.logger.error('trade-retry', `Retry scan failed: ${error.message}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async getStatus() {
    let backlog = [];
    let quarantines = [];
    let circuits = [];
    try {
      backlog = (await this.db.query(
        `SELECT status, COUNT(*)::int AS count, MIN(next_retry_at) AS oldest
         FROM trade_intents
         WHERE status IN('retry_scheduled','retry_verifying','uncertain')
         GROUP BY status ORDER BY status`
      )).rows;
      quarantines = (await this.db.query(
        `SELECT chain, wallet_address, reason_code, quarantined_at
         FROM wallet_write_lanes WHERE state = 'quarantined'
         ORDER BY quarantined_at ASC`
      )).rows.map((row) => ({
        ...row,
        wallet_address: row.wallet_address.length > 14
          ? `${row.wallet_address.slice(0, 6)}...${row.wallet_address.slice(-4)}`
          : row.wallet_address
      }));
      circuits = await this.circuitBreaker.list();
    } catch (error) {
      this.lastError = error.message;
    }
    return {
      running: Boolean(this.timer),
      active: this.running,
      startedAt: this.startedAt,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      processed: this.processed,
      succeeded: this.succeeded,
      scanIntervalMs: 100,
      maintenanceIntervalMs: this.maintenanceIntervalMs,
      lastMaintenanceAt: this.lastMaintenanceAt,
      backlog,
      quarantines,
      circuits
    };
  }
}

const tradeRetryOrchestrator = new TradeRetryOrchestrator();

module.exports = { CANCEL_CODES, TradeRetryOrchestrator, tradeRetryOrchestrator };
