const gmgnHttp = require('../../lib/gmgn-http');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const { cache, cacheTtls } = require('../../lib/gmgn-cache');
const { requireChain, validateTokenAddress } = require('./chain-adapters');

async function loadCachedContext(signal, options = {}) {
  const chain = requireChain(signal.chain_id);
  validateTokenAddress(chain.id, signal.contract_address);
  const ttl = cacheTtls();
  const load = async (key, ttlMs, loader) => {
    if (!options.fresh) return cache.getOrLoad(key, ttlMs, loader);
    const value = await loader();
    return { value, version: `fresh-${Date.now()}`, ageMs: 0, cacheHit: false };
  };
  const [userEntry, tokenEntry, securityEntry, poolEntry, gasEntry, nativeTokenEntry] = await Promise.all([
    load('user:wallets', ttl.wallet, () => gmgnHttp.getUserInfo()),
    load(`token:${chain.id}:${signal.contract_address}`, ttl.token,
      () => gmgnHttp.getTokenInfo(chain.id, signal.contract_address)),
    load(`security:${chain.id}:${signal.contract_address}`, ttl.security,
      () => gmgnHttp.getTokenSecurity(chain.id, signal.contract_address)),
    load(`pool:${chain.id}:${signal.contract_address}`, ttl.pool,
      () => gmgnHttp.getTokenPoolInfo(chain.id, signal.contract_address)),
    load(`gas:${chain.id}`, ttl.gas, () => gmgnHttp.getGasPrice(chain.id)),
    load(`native-token:${chain.id}`, ttl.token,
      () => gmgnHttp.getTokenInfo(chain.id, chain.nativeToken))
  ]);
  const wallet = gmgnAdapter.selectWallet(userEntry.value, chain.id);
  return {
    chain,
    wallet,
    token: gmgnAdapter.normalizeTokenInfo(tokenEntry.value),
    security: gmgnAdapter.normalizeSecurity(securityEntry.value, chain.id),
    pool: gmgnAdapter.normalizePool(poolEntry.value),
    gas: gasEntry.value,
    nativeToken: gmgnAdapter.normalizeTokenInfo(nativeTokenEntry.value),
    cacheMeta: {
      wallet: { version: userEntry.version, age_ms: userEntry.ageMs, hit: userEntry.cacheHit },
      token: { version: tokenEntry.version, age_ms: tokenEntry.ageMs, hit: tokenEntry.cacheHit },
      security: { version: securityEntry.version, age_ms: securityEntry.ageMs, hit: securityEntry.cacheHit },
      pool: { version: poolEntry.version, age_ms: poolEntry.ageMs, hit: poolEntry.cacheHit },
      gas: { version: gasEntry.version, age_ms: gasEntry.ageMs, hit: gasEntry.cacheHit },
      nativeToken: {
        version: nativeTokenEntry.version,
        age_ms: nativeTokenEntry.ageMs,
        hit: nativeTokenEntry.cacheHit
      }
    }
  };
}

function requiredCacheKeys(whitelists) {
  if (!Array.isArray(whitelists) || whitelists.length === 0) return [];
  const keys = new Set(['user:wallets']);
  for (const whitelist of whitelists) {
    const chain = String(whitelist.chain_id).toLowerCase();
    const token = whitelist.contract_address;
    keys.add(`token:${chain}:${token}`);
    keys.add(`security:${chain}:${token}`);
    keys.add(`pool:${chain}:${token}`);
    keys.add(`gas:${chain}`);
    keys.add(`native-token:${chain}`);
  }
  return [...keys];
}

module.exports = { loadCachedContext, requiredCacheKeys };
