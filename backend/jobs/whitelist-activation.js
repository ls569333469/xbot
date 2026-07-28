const crypto = require('crypto');
const db = require('../lib/db');
const logger = require('../lib/logger');
const gmgnHttp = require('../lib/gmgn-http');
const gmgnAdapter = require('../lib/gmgn-adapter');
const { decimalToRaw } = require('../lib/decimal-units');
const { loadCachedContext } = require('../domains/trade/fast-path-context');
const { compileExitStrategy } = require('../domains/trade/exit-strategy-compiler');
const { probeRpc } = require('../domains/trade/chain-receipt-service');
const { validateTokenAddress } = require('../domains/trade/chain-adapters');
const {
  enqueueWatchSyncForHandles,
  watchApplyEnabled,
  watchDemandFingerprint
} = require('../domains/x-monitor/6551/watch-sync-outbox');
const { flagsEqual, loadDesiredWatches } = require('../domains/x-monitor/6551/watch-reconciler');
const {
  claimActivationBatch,
  completeActivation,
  deferActivation,
  discardActivation,
  failActivation
} = require('../domains/whitelist/activation-outbox');

const PERMANENT_CODES = new Set([
  'TOKEN_ADDRESS_INVALID',
  'WHITELIST_ACTIVATION_CONFIG_INVALID',
  'EXIT_STRATEGY_INVALID',
  'LIVE_CHAIN_UNSUPPORTED',
  'WATCH_SYNC_DISABLED'
]);

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function loadActivationContext(whitelistId, executor = db) {
  const result = await executor.query(
    `SELECT whitelist.*,
            COALESCE((
              SELECT array_agg(DISTINCT actor.x_handle ORDER BY actor.x_handle)
              FROM (
                SELECT relation.kol_id AS actor_id
                FROM x_signal_relations AS relation
                WHERE relation.whitelist_id = whitelist.id AND relation.enabled = true
                UNION
                SELECT rule.actor_id
                FROM x_signal_source_rules AS rule
                WHERE rule.whitelist_id = whitelist.id AND rule.enabled = true
              ) AS trigger
              JOIN x_kol_accounts AS actor ON actor.id = trigger.actor_id AND actor.enabled = true
            ), '{}'::text[]) AS actor_handles
     FROM ca_whitelist AS whitelist
     WHERE whitelist.id = $1`,
    [Number(whitelistId)]
  );
  return result.rows[0] || null;
}

function validateWhitelist(whitelist) {
  validateTokenAddress(whitelist.chain_id, whitelist.contract_address);
  const values = [whitelist.budget_per_trade, whitelist.total_budget, whitelist.slippage].map(Number);
  if (!values.every(Number.isFinite)
      || values[0] <= 0 || values[1] < values[0] || values[2] <= 0 || values[2] > 100
      || !Array.isArray(whitelist.actor_handles) || whitelist.actor_handles.length === 0) {
    const error = new Error('Whitelist activation configuration is invalid');
    error.code = 'WHITELIST_ACTIVATION_CONFIG_INVALID';
    throw error;
  }
  compileExitStrategy(whitelist.exit_strategy, whitelist);
}

async function assertWatchesInSync(whitelist, executor = db) {
  if (String(process.env.X_DATA_PROVIDER || '').toLowerCase() !== '6551') return;
  const handles = whitelist.actor_handles || [];
  await enqueueWatchSyncForHandles(handles, executor);
  const desired = await loadDesiredWatches(executor);
  const desiredByHandle = new Map(desired.map((item) => [String(item.username).toLowerCase(), item]));
  const result = await executor.query(
    `SELECT watch.username, watch.sync_status, watch.managed,
            watch.desired_flags, watch.remote_flags,
            outbox.status AS outbox_status,
            outbox.desired_fingerprint AS outbox_desired_fingerprint
     FROM x_provider_watches AS watch
     LEFT JOIN x_watch_sync_outbox AS outbox ON outbox.actor_handle = watch.username
     WHERE watch.provider = '6551' AND watch.username = ANY($1::text[])`,
    [handles]
  );
  const inSync = new Set(result.rows
    .filter((item) => {
      const expected = desiredByHandle.get(String(item.username).toLowerCase());
      if (!expected) return false;
      return item.sync_status === 'in_sync'
        && item.managed === true
        && item.outbox_status === 'succeeded'
        && item.outbox_desired_fingerprint === watchDemandFingerprint(true, expected.flags)
        && flagsEqual(item.remote_flags, expected.flags);
    })
    .map((item) => String(item.username).toLowerCase()));
  const missing = handles.filter((handle) => !inSync.has(String(handle).toLowerCase()));
  if (missing.length > 0) {
    const error = new Error(`6551 Watch is not synchronized: ${missing.join(', ')}`);
    error.code = watchApplyEnabled() ? 'WATCH_SYNC_PENDING' : 'WATCH_SYNC_DISABLED';
    throw error;
  }
}

async function probeWhitelist(whitelist, dependencies = {}) {
  const loadContext = dependencies.loadCachedContext || loadCachedContext;
  const context = await loadContext(whitelist, { fresh: true });
  const rpcProbe = await (dependencies.probeRpc || probeRpc)(context.chain.id, {
    walletAddress: context.wallet.address
  });
  if (!rpcProbe.ok) {
    const error = new Error(`Chain RPC probe failed: ${rpcProbe.error}`);
    error.code = rpcProbe.error || 'CHAIN_RPC_UNAVAILABLE';
    throw error;
  }
  const inputAmountRaw = decimalToRaw(whitelist.budget_per_trade, context.chain.decimals);
  const quote = gmgnAdapter.normalizeQuote(await (dependencies.quoteOrder || gmgnHttp.quoteOrder)(
    context.chain.id,
    context.wallet.address,
    context.chain.nativeToken,
    whitelist.contract_address,
    inputAmountRaw,
    Number(whitelist.slippage)
  ));
  if (!quote.outputAmountRaw || BigInt(quote.outputAmountRaw) <= 0n) {
    const error = new Error('Activation quote has no output amount');
    error.code = 'ACTIVATION_QUOTE_EMPTY';
    throw error;
  }
  return fingerprint({
    whitelistId: Number(whitelist.id),
    activationVersion: Number(whitelist.activation_version),
    chain: context.chain.id,
    contractAddress: whitelist.contract_address,
    budgetPerTrade: String(whitelist.budget_per_trade),
    totalBudget: String(whitelist.total_budget),
    slippage: String(whitelist.slippage),
    exitStrategy: whitelist.exit_strategy,
    exitStrategyVersion: Number(whitelist.exit_strategy_version),
    actorHandles: [...whitelist.actor_handles].sort(),
    wallet: context.wallet.address,
    rpcIdentity: rpcProbe.identity || null,
    quoteOutputAmountRaw: quote.outputAmountRaw
  });
}

class WhitelistActivationWorker {
  constructor(options = {}) {
    this.db = options.db || db;
    this.logger = options.logger || logger;
    this.dependencies = options.dependencies || {};
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.processed = 0;
  }

  async process(row) {
    const whitelist = await loadActivationContext(row.whitelist_id, this.db);
    if (!whitelist || whitelist.status !== 'active'
        || Number(whitelist.activation_version) !== Number(row.desired_version)) {
      await discardActivation(row, this.db);
      return { status: 'superseded' };
    }
    try {
      validateWhitelist(whitelist);
      await assertWatchesInSync(whitelist, this.db);
      const contextHash = await probeWhitelist(whitelist, this.dependencies);
      const activated = await completeActivation(row, contextHash, this.db);
      if (activated) {
        await this.db.query("SELECT pg_notify('xbot_activation_ready', $1)", [String(whitelist.id)]);
      }
      return { status: activated ? 'live_ready' : 'superseded' };
    } catch (error) {
      const permanent = PERMANENT_CODES.has(error.code) || Number(row.attempt_count || 0) >= 4;
      if (permanent) await failActivation(row, error, this.db);
      else await deferActivation(row, error, this.db);
      return { status: permanent ? 'sync_failed' : 'deferred', error: error.code || error.message };
    }
  }

  async runOnce() {
    if (this.running) return { status: 'skipped', reason: 'already_running' };
    this.running = true;
    this.lastRunAt = new Date();
    this.lastError = null;
    try {
      const rows = await claimActivationBatch(2, this.db);
      const results = await Promise.all(rows.map((row) => this.process(row)));
      this.processed += rows.length;
      if (results.some((item) => item.status === 'live_ready')) this.lastSuccessAt = new Date();
      return { status: 'completed', processed: rows.length, results };
    } catch (error) {
      this.lastError = error.code || error.message;
      throw error;
    } finally {
      this.running = false;
    }
  }

  start(options = {}) {
    if (this.timer) return;
    const intervalMs = Math.max(500, Number(options.intervalMs || 1000));
    void this.runOnce().catch((error) => {
      this.logger.error('whitelist-activation', `Initial activation failed: ${error.message}`);
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.logger.error('whitelist-activation', `Activation failed: ${error.message}`);
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
      lastError: this.lastError,
      processed: this.processed
    };
  }
}

const whitelistActivationWorker = new WhitelistActivationWorker();

module.exports = {
  WhitelistActivationWorker,
  assertWatchesInSync,
  loadActivationContext,
  probeWhitelist,
  validateWhitelist,
  whitelistActivationWorker
};
