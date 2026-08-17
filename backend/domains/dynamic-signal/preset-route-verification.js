const {
  probeEvmContract,
  probeSolanaMint
} = require('../../lib/contract-chain-resolver');
const { hydrateRouteIds, routeError, routeFingerprint } = require('./preset-route-schema');

const VERIFY_CACHE_TTL_MS = 60_000;
const MAX_VERIFY_CACHE_ENTRIES = 256;
const verificationCache = new Map();

function pruneVerificationCache(cache, now, maxEntries = MAX_VERIFY_CACHE_ENTRIES) {
  for (const [key, entry] of cache) {
    if (!entry || entry.expires_at <= now) cache.delete(key);
  }
  while (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function verificationFailure(probe, route) {
  const details = { chain_id: route.chain_id, contract_address: route.contract_address, probe };
  if (probe.error === 'RPC_CHAIN_MISMATCH') {
    return routeError('DYNAMIC_ROUTE_RPC_CHAIN_MISMATCH', 'Selected chain RPC returned a different chain identity', details);
  }
  if (probe.error === 'CHAIN_RPC_MISSING' || probe.error === 'CHAIN_RPC_UNAVAILABLE'
      || probe.error === 'CHAIN_RPC_TIMEOUT' || probe.error === 'CHAIN_RPC_HTTP_ERROR'
      || probe.error === 'CHAIN_RPC_RESPONSE_INVALID') {
    return routeError('DYNAMIC_ROUTE_RPC_UNAVAILABLE', 'Selected chain RPC is unavailable', details);
  }
  if (route.chain_id === 'sol') {
    return routeError('DYNAMIC_ROUTE_SOL_MINT_INVALID', 'The selected Solana address is not a valid initialized token mint', details);
  }
  return routeError('DYNAMIC_ROUTE_CONTRACT_NOT_FOUND', 'No contract code exists at the selected chain address', details);
}

async function verifyPresetRoute(route, dependencies = {}) {
  const key = routeFingerprint(route);
  const now = dependencies.now ? dependencies.now() : Date.now();
  pruneVerificationCache(verificationCache, now);
  const cached = verificationCache.get(key);
  if (!dependencies.bypassCache && cached && cached.expires_at > now) {
    return structuredClone(cached.verification);
  }
  const probe = route.chain_id === 'sol'
    ? await (dependencies.probeSolanaMint || probeSolanaMint)(
      route.contract_address, dependencies.rpcOptions || {}
    )
    : await (dependencies.probeEvmContract || probeEvmContract)(
      route.chain_id, route.contract_address, dependencies.rpcOptions || {}
    );
  const verified = route.chain_id === 'sol'
    ? probe.ok && probe.mintFound
    : probe.ok && probe.contractFound;
  if (!verified) throw verificationFailure(probe, route);
  const verification = {
    status: 'verified',
    source: 'local_rpc',
    verified_at: new Date(now).toISOString(),
    error_code: null,
    snapshot: probe
  };
  verificationCache.set(key, { expires_at: now + VERIFY_CACHE_TTL_MS, verification });
  return structuredClone(verification);
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) },
    worker
  ));
  return results;
}

async function prepareVerifiedRoutes(routes, currentRoutes = [], dependencies = {}) {
  const hydrated = hydrateRouteIds(routes, currentRoutes);
  const currentById = new Map(currentRoutes.map((route) => [Number(route.route_id), route]));
  return mapConcurrent(hydrated, Number(dependencies.concurrency || 4), async (route) => {
    const current = route.route_id ? currentById.get(Number(route.route_id)) : null;
    if (current && routeFingerprint(current) === routeFingerprint(route)
        && current.verification?.status === 'verified' && current.variant_id) {
      return {
        ...route,
        variant_id: current.variant_id,
        asset_family_id: current.asset_family_id || null,
        verification: current.verification
      };
    }
    return { ...route, verification: await verifyPresetRoute(route, dependencies) };
  });
}

function clearVerificationCache() {
  verificationCache.clear();
}

module.exports = {
  MAX_VERIFY_CACHE_ENTRIES,
  VERIFY_CACHE_TTL_MS,
  clearVerificationCache,
  mapConcurrent,
  prepareVerifiedRoutes,
  pruneVerificationCache,
  verificationFailure,
  verifyPresetRoute
};
