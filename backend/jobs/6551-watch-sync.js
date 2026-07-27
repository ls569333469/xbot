const db = require('../lib/db');
const logger = require('../lib/logger');
const { X6551Client } = require('../lib/x-client-6551');
const { applyWatchPlan } = require('../domains/x-monitor/6551/watch-reconciler');
const {
  claimWatchSyncBatch,
  completeWatchSync,
  failWatchSync
} = require('../domains/x-monitor/6551/watch-sync-outbox');

class WatchSyncWorker {
  constructor(options = {}) {
    this.db = options.db || db;
    this.logger = options.logger || logger;
    this.clientFactory = options.clientFactory || (() => new X6551Client(process.env.OPENNEWS_TOKEN));
    this.applyPlan = options.applyPlan || applyWatchPlan;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.processed = 0;
  }

  enabled() {
    return String(process.env.X_DATA_PROVIDER || '').toLowerCase() === '6551'
      && String(process.env.X_6551_WATCH_APPLY_ENABLED || 'false').toLowerCase() === 'true'
      && Boolean(process.env.OPENNEWS_TOKEN);
  }

  async runOnce() {
    if (this.running) return { status: 'skipped', reason: 'already_running' };
    if (!this.enabled()) return { status: 'skipped', reason: 'watch_sync_disabled' };
    this.running = true;
    this.lastRunAt = new Date();
    this.lastError = null;
    let claimed = [];
    try {
      claimed = await claimWatchSyncBatch(100, this.db);
      if (claimed.length === 0) return { status: 'completed', processed: 0 };
      const result = await this.applyPlan(this.clientFactory(), {
        confirmation: 'APPLY 6551 WATCH CHANGES',
        adopt: claimed.map((item) => item.actor_handle),
        allowUnresolvedBlockers: true
      }, this.db);
      await completeWatchSync(claimed, this.db);
      this.processed += claimed.length;
      this.lastSuccessAt = new Date();
      return { status: 'completed', processed: claimed.length, result };
    } catch (error) {
      this.lastError = error.code || error.message;
      if (claimed.length > 0) await failWatchSync(claimed, this.lastError, this.db);
      throw error;
    } finally {
      this.running = false;
    }
  }

  start(options = {}) {
    if (this.timer) return;
    const intervalMs = Math.max(1000, Number(options.intervalMs || 1000));
    void this.runOnce().catch((error) => {
      this.logger.error('6551-watch-sync', `Initial sync failed: ${error.message}`);
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.logger.error('6551-watch-sync', `Sync failed: ${error.message}`);
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
      enabled: this.enabled(),
      running: Boolean(this.timer),
      active: this.running,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      processed: this.processed
    };
  }
}

const watchSyncWorker = new WatchSyncWorker();

module.exports = { WatchSyncWorker, watchSyncWorker };
