const db = require('../lib/db');
const logger = require('../lib/logger');
const { p20FeatureState } = require('../lib/p20-features');
const market = require('../domains/dynamic-signal/gmgn-market-source');
const repository = require('../domains/dynamic-signal/candidate-repository');

const CHAINS = ['sol', 'bsc', 'base', 'eth', 'robinhood'];

class CandidateCacheWarmup {
  constructor(options = {}) {
    this.db = options.db || db; this.logger = options.logger || logger;
    this.timer = null; this.active = false; this.running = false;
    this.lastRunAt = null; this.lastSuccessAt = null; this.lastError = null; this.processed = 0;
  }
  async runOnce() {
    if (this.active || !p20FeatureState().P20_CANDIDATE_INDEX_ENABLED) return { status: 'skipped' };
    this.active = true; this.lastRunAt = new Date();
    try {
      const expiry = new Date(Date.now() + 2 * 60_000);
      let processed = 0;
      for (const chain of CHAINS) {
        try {
          const rank = await market.fetchRank({ chain, limit: 100 });
          processed += (await repository.upsertMany(rank.candidates, 'gmgn_rank', this.db, { expiresAt: expiry })).length;
        } catch (error) {
          this.logger.warn('p20-candidate-warmup', `Rank warmup failed for ${chain}: ${error.message}`);
        }
      }
      try {
        const hot = await market.fetchHotSearches({
          params: CHAINS.map((chain) => ({ chain, interval: '24h', limit: 100 }))
        });
        processed += (await repository.upsertMany(hot.candidates, 'gmgn_hot', this.db, { expiresAt: expiry })).length;
      } catch (error) {
        this.logger.warn('p20-candidate-warmup', `Hot-search warmup failed: ${error.message}`);
      }
      this.processed += processed; this.lastSuccessAt = new Date(); this.lastError = null;
      return { status: 'completed', processed };
    } catch (error) {
      this.lastError = String(error.code || error.message); throw error;
    } finally { this.active = false; }
  }
  start(options = {}) { if (this.timer) return; this.running = true; const interval = Math.max(30_000, Number(options.intervalMs || 60_000)); void this.runOnce(); this.timer = setInterval(() => void this.runOnce().catch(() => {}), interval); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.running = false; }
  getStatus() { return { running: this.running, active: this.active, lastRunAt: this.lastRunAt, lastSuccessAt: this.lastSuccessAt, lastError: this.lastError, processed: this.processed }; }
}
const candidateCacheWarmup = new CandidateCacheWarmup();
module.exports = { CandidateCacheWarmup, candidateCacheWarmup };
