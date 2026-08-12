const crypto = require('node:crypto');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const gmgnAccess = require('../../lib/gmgn-access-service').accessFor('asset_metadata');
const { getChain } = require('../../lib/chain-config');
const { getGmgnCredentials } = require('../../lib/gmgn-credentials');
const { PRIORITIES } = require('../../lib/gmgn-rate-scheduler');
const logger = require('../../lib/logger');
const repository = require('./repository');

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000,
  6 * 60 * 60_000, 24 * 60 * 60_000];

function sameAddress(chainId, expected, actual) {
  const left = String(expected || '').trim();
  const right = String(actual || '').trim();
  return chainId === 'sol' ? left === right : left.toLowerCase() === right.toLowerCase();
}

function retryAt(error, attemptCount, now = Date.now()) {
  const resetAt = Number(error?.resetAt || error?.responseMeta?.resetAt || 0);
  if (resetAt > now) return new Date(resetAt + 1000);
  const index = Math.min(Math.max(0, Number(attemptCount || 1) - 1), RETRY_DELAYS_MS.length - 1);
  return new Date(now + RETRY_DELAYS_MS[index]);
}

function normalize(asset, raw) {
  const info = gmgnAdapter.normalizeTokenInfo(raw);
  if (!sameAddress(asset.chain_id, asset.contract_address, info.address)) {
    const error = new Error('GMGN token info returned a different contract address');
    error.code = 'GMGN_TOKEN_ADDRESS_MISMATCH';
    throw error;
  }
  return {
    name: info.name,
    symbol: String(info.symbol || '').trim() || null,
    logoUrl: String(raw?.logo || '').trim() || null,
    decimals: info.decimals,
    raw
  };
}

class AssetMetadataWorker {
  constructor(options = {}) {
    this.repository = options.repository || repository;
    this.gmgnAccess = options.gmgnAccess || gmgnAccess;
    this.logger = options.logger || logger;
    this.now = options.now || Date.now;
    this.workerId = options.workerId || `asset-metadata:${process.pid}:${crypto.randomUUID()}`;
    this.isEnabled = options.isEnabled || (() => Boolean(getGmgnCredentials().apiKey));
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.completed = 0;
    this.failed = 0;
  }

  async runOnce() {
    if (this.running) return { status: 'skipped', reason: 'already_running' };
    if (!this.isEnabled()) return { status: 'skipped', reason: 'gmgn_key_missing' };
    const schedulerStatus = this.gmgnAccess.scheduler?.getStatus?.() || {};
    if (schedulerStatus.state !== 'healthy'
        || Number(schedulerStatus.reservedWeight || 0) > 0
        || Number(schedulerStatus.queueDepth || 0) > 0
        || Number(schedulerStatus.reservedOrConsumedLastSecond || 0) > 0) {
      return { status: 'skipped', reason: 'gmgn_busy' };
    }
    this.running = true;
    this.lastRunAt = new Date(this.now());
    try {
      const asset = await this.repository.claimNext(this.workerId);
      if (!asset) return { status: 'completed', processed: 0 };
      const chain = getChain(asset.chain_id);
      if (!chain?.gmgnId) {
        const error = new Error(`Unsupported GMGN metadata chain: ${asset.chain_id}`);
        error.code = 'GMGN_CHAIN_UNSUPPORTED';
        throw Object.assign(error, { claimedAsset: asset });
      }
      try {
        const raw = await this.gmgnAccess.getTokenInfo(chain.gmgnId, asset.contract_address, {
          priority: PRIORITIES.CACHE_WARMUP,
          deadlineAt: this.now() + 10_000,
          requestContext: {
            source: 'asset_metadata', stage: 'token_info',
            context: { asset_metadata_id: Number(asset.id) }
          }
        });
        const metadata = normalize(asset, raw);
        await this.repository.complete(asset, metadata, this.workerId);
        this.completed += 1;
        this.lastSuccessAt = new Date(this.now());
        this.lastError = null;
        return { status: 'completed', processed: 1, assetId: asset.id };
      } catch (error) {
        await this.repository.fail(asset, error, this.workerId,
          retryAt(error, asset.attempt_count, this.now()));
        this.failed += 1;
        this.lastError = error.code || error.message;
        this.logger.warn('asset-metadata', 'GMGN metadata lookup deferred', {
          assetId: asset.id, chain: asset.chain_id, code: this.lastError
        });
        return { status: 'deferred', processed: 1, assetId: asset.id, code: this.lastError };
      }
    } finally {
      this.running = false;
    }
  }

  start(options = {}) {
    if (this.timer) return;
    const intervalMs = Math.max(5_000, Number(options.intervalMs || 5000));
    void this.runOnce().catch((error) => {
      this.lastError = error.code || error.message;
      this.logger.error('asset-metadata', error.message);
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.lastError = error.code || error.message;
        this.logger.error('asset-metadata', error.message);
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
      enabled: this.isEnabled(), running: Boolean(this.timer), active: this.running,
      lastRunAt: this.lastRunAt, lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError, completed: this.completed, failed: this.failed
    };
  }
}

const assetMetadataWorker = new AssetMetadataWorker();

module.exports = {
  AssetMetadataWorker,
  RETRY_DELAYS_MS,
  assetMetadataWorker,
  normalize,
  retryAt,
  sameAddress
};
