const queries = require('../domains/kol/queries');
const { fetchVerifiedProfile } = require('../domains/kol/service');
const { createXClient } = require('../lib/x-client');
const logger = require('../lib/logger');

const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000
];

function retryDelayMs(error, attemptCount) {
  if (error?.code === 'X6551_AUTH_ERROR') return 6 * 60 * 60_000;
  const index = Math.min(Math.max(0, Number(attemptCount || 1) - 1), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index];
}

class KolProfileEnrichmentWorker {
  constructor(options = {}) {
    this.queries = options.queries || queries;
    this.clientFactory = options.clientFactory || createXClient;
    this.logger = options.logger || logger;
    this.isEnabled = options.isEnabled || (() => (
      String(process.env.X_DATA_PROVIDER || '').toLowerCase() === '6551'
      && Boolean(process.env.OPENNEWS_TOKEN)
    ));
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.verified = 0;
    this.failed = 0;
  }

  async runOnce(options = {}) {
    if (this.running) return { status: 'skipped', reason: 'already_running' };
    if (!this.isEnabled()) return { status: 'skipped', reason: 'profile_enrichment_disabled' };
    this.running = true;
    this.lastRunAt = new Date();
    this.lastError = null;
    let verified = 0;
    let failed = 0;
    try {
      const accounts = await this.queries.claimPendingProfiles(options.batchSize || 1);
      if (accounts.length === 0) {
        this.lastSuccessAt = new Date();
        return { status: 'completed', processed: 0, verified: 0, failed: 0 };
      }
      for (const account of accounts) {
        try {
          const client = this.clientFactory();
          const profile = await fetchVerifiedProfile(account.x_handle, { xClient: client });
          const saved = await this.queries.completeProfileVerification(
            account.id,
            account.x_handle,
            profile
          );
          if (saved) {
            verified += 1;
            this.verified += 1;
          }
        } catch (error) {
          const attemptCount = Number(account.profile_attempt_count || 0) + 1;
          const nextRetryAt = new Date(Date.now() + retryDelayMs(error, attemptCount));
          await this.queries.failProfileVerification(
            account.id,
            error.code || 'X_PROFILE_UNAVAILABLE',
            nextRetryAt
          );
          failed += 1;
          this.failed += 1;
          this.lastError = error.code || error.message;
          this.logger.warn('kol-profile', '6551 Profile verification deferred', {
            handle: account.x_handle,
            code: this.lastError,
            nextRetryAt: nextRetryAt.toISOString()
          });
        }
      }
      this.lastSuccessAt = new Date();
      return { status: 'completed', processed: accounts.length, verified, failed };
    } finally {
      this.running = false;
    }
  }

  start(options = {}) {
    if (this.timer) return;
    const intervalMs = Math.max(1000, Number(options.intervalMs || 5000));
    void this.runOnce().catch((error) => {
      this.lastError = error.code || error.message;
      this.logger.error('kol-profile', `Initial verification failed: ${error.message}`);
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.lastError = error.code || error.message;
        this.logger.error('kol-profile', `Verification failed: ${error.message}`);
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
      enabled: this.isEnabled(),
      running: Boolean(this.timer),
      active: this.running,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      verified: this.verified,
      failed: this.failed
    };
  }
}

const kolProfileEnrichmentWorker = new KolProfileEnrichmentWorker();

module.exports = {
  KolProfileEnrichmentWorker,
  RETRY_DELAYS_MS,
  kolProfileEnrichmentWorker,
  retryDelayMs
};
