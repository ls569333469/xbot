const db = require('../../lib/db');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const { requireChain, validateTokenAddress } = require('./chain-adapters');

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenFromLocalSnapshot(signal, snapshot = {}) {
  const info = snapshot.info && typeof snapshot.info === 'object' ? snapshot.info : {};
  const decimals = Number(info.decimals ?? signal.token_decimals);
  return {
    raw: info,
    address: String(info.address || info.token_address || signal.contract_address),
    name: info.name || info.token_name || signal.project_name || null,
    symbol: String(info.symbol || signal.symbol || ''),
    decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null,
    priceUsd: numberOrNull(info?.price?.price ?? info.price_usd ?? info.price),
    liquidityUsd: numberOrNull(info.liquidity ?? info.liquidity_usd),
    marketCapUsd: numberOrNull(info.market_cap ?? info.usd_market_cap),
    rugRatio: numberOrNull(info.rug_ratio ?? info?.stat?.rug_ratio),
    fieldAvailability: {}
  };
}

function localCacheMeta(source) {
  return { version: 'p24-local-context-v1', age_ms: 0, hit: true, source };
}

async function loadExecutionProfile(signal, chain, options = {}) {
  if (options.executionProfile) return options.executionProfile;
  const executor = options.executor || db;
  const result = await executor.query(
    `SELECT chain, wallet_address, balances_json, native_balance, last_checked_at
     FROM chain_live_readiness WHERE chain = $1`,
    [chain.id]
  );
  const readiness = result.rows[0] || {};
  const walletAddress = String(signal.wallet_address || readiness.wallet_address || '').trim();
  if (!walletAddress) {
    const error = new Error(`Local execution profile has no ${chain.id} wallet address`);
    error.code = 'LOCAL_WALLET_PROFILE_MISSING';
    throw error;
  }
  const balances = Array.isArray(readiness.balances_json) ? readiness.balances_json : [];
  if (numberOrNull(readiness.native_balance) !== null
      && !balances.some((item) => String(item.symbol || '').toUpperCase() === chain.nativeSymbol)) {
    balances.push({ symbol: chain.nativeSymbol, balance: String(readiness.native_balance) });
  }
  return {
    wallet: { chain: chain.id, address: walletAddress, balances },
    readiness
  };
}

async function loadCachedContext(signal, options = {}) {
  const chain = requireChain(signal.chain_id);
  validateTokenAddress(chain.id, signal.contract_address);
  const snapshot = options.verificationSnapshot || signal.provider_verification_snapshot || {};
  const profile = await loadExecutionProfile(signal, chain, options);
  const wallet = profile.wallet;
  const token = tokenFromLocalSnapshot(signal, snapshot);
  const security = gmgnAdapter.normalizeSecurity(snapshot.security || {}, chain.id);
  const pool = gmgnAdapter.normalizePool(snapshot.pool || {});
  const gas = options.gasSnapshot || signal.gas_snapshot || {};
  const nativePrice = gmgnAdapter.walletNativePriceUsd(wallet, chain.nativeSymbol);
  const nativeToken = {
    raw: {}, address: chain.nativeToken, symbol: chain.nativeSymbol,
    decimals: chain.decimals, priceUsd: nativePrice
  };
  return {
    chain,
    wallet,
    token,
    security,
    pool,
    gas,
    nativeToken,
    cacheMeta: {
      wallet: localCacheMeta('chain_live_readiness'),
      token: localCacheMeta(snapshot.info ? 'verification_snapshot' : 'signal_snapshot'),
      security: localCacheMeta(snapshot.security ? 'verification_snapshot' : 'unknown'),
      pool: localCacheMeta(snapshot.pool ? 'verification_snapshot' : 'unknown'),
      gas: localCacheMeta(Object.keys(gas).length ? 'local_config' : 'swap_defaults'),
      nativeToken: localCacheMeta('chain_registry')
    }
  };
}

function requiredCacheKeys() {
  return [];
}

module.exports = { loadCachedContext, loadExecutionProfile, requiredCacheKeys, tokenFromLocalSnapshot };
