const db = require('../lib/db');
const logger = require('../lib/logger');
const livePolicy = require('../domains/signal/live-policy');
const { loadCachedContext } = require('../domains/trade/fast-path-context');

class GmgnCacheWarmer {
  constructor(options = {}) {
    this.db = options.db || db;
    this.policy = options.policy || livePolicy;
    this.loader = options.loader || loadCachedContext;
    this.logger = options.logger || logger;
    this.batchSize = Math.max(1, Number(options.batchSize || 3));
    this.cursor = 0;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.failureStartedAt = null;
    this.lastRecoveredAt = null;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.processed = 0;
  }

  async runOnce() {
    if (this.running) return { status: 'skipped', reason: 'already_running' };
    this.running = true;
    this.lastRunAt = new Date();
    try {
      const policy = await this.policy.getPolicy();
      if (policy.whitelistIds.length === 0 || policy.chains.length === 0) {
        this.recordSuccess();
        return { status: 'completed', processed: 0 };
      }
      const result = await this.db.query(
        `SELECT id, chain_id, contract_address
         FROM ca_whitelist
         WHERE id = ANY($1::int[]) AND chain_id = ANY($2::text[]) AND status = 'active'
         ORDER BY id`,
        [policy.whitelistIds, policy.chains]
      );
      const rows = result.rows;
      if (rows.length === 0) {
        this.recordSuccess();
        return { status: 'completed', processed: 0 };
      }
      const batch = [];
      for (let index = 0; index < Math.min(this.batchSize, rows.length); index += 1) {
        batch.push(rows[(this.cursor + index) % rows.length]);
      }
      this.cursor = (this.cursor + batch.length) % rows.length;
      for (const whitelist of batch) {
        await this.loader(whitelist);
        this.processed += 1;
      }
      this.recordSuccess();
      return { status: 'completed', processed: batch.length, total: rows.length };
    } catch (error) {
      this.recordFailure(error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  recordSuccess() {
    const now = new Date();
    const wasFailing = this.consecutiveFailures > 0;
    this.lastSuccessAt = now;
    this.consecutiveSuccesses += 1;
    this.consecutiveFailures = 0;
    this.failureStartedAt = null;
    this.lastError = null;
    if (wasFailing) this.lastRecoveredAt = now;
  }

  recordFailure(error) {
    const now = new Date();
    this.lastFailureAt = now;
    this.failureStartedAt ||= now;
    this.lastError = error.code || error.message;
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
  }

  start(options = {}) {
    if (this.timer) return;
    const intervalMs = Math.max(1000, Number(options.intervalMs || 2000));
    void this.runOnce().catch((error) => {
      this.logger.error('gmgn-cache-warmer', `Initial warmup failed: ${error.message}`);
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.logger.error('gmgn-cache-warmer', `Warmup failed: ${error.message}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return {
      running: Boolean(this.timer),
      active: this.running,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      failureStartedAt: this.failureStartedAt,
      lastRecoveredAt: this.lastRecoveredAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      systemFailure: this.consecutiveFailures >= 3,
      processed: this.processed,
      batchSize: this.batchSize
    };
  }
}

const cacheWarmer = new GmgnCacheWarmer();

module.exports = { GmgnCacheWarmer, cacheWarmer };
