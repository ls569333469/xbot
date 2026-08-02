const gmgnHttp = require('../../lib/gmgn-http');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const { requireChain, validateTokenAddress } = require('../trade/chain-adapters');

const INTERVALS = new Set(['1m', '5m', '1h', '6h', '24h']);
const TRENCH_TYPES = new Set(['new_creation', 'near_completion', 'completed']);
const HOLDER_ORDER_FIELDS = new Set([
  'amount_percentage', 'profit', 'unrealized_profit', 'buy_volume_cur', 'sell_volume_cur'
]);
const HOLDER_TAGS = new Set([
  'smart_degen', 'renowned', 'fresh_wallet', 'dev', 'sniper', 'rat_trader',
  'bundler', 'transfer_in', 'dex_bot', 'bluechip_owner'
]);

async function fetchKline(input = {}, dependencies = {}) {
  const chain = requireChain(input.chain).id;
  const address = validateTokenAddress(chain, input.address);
  const resolution = String(input.resolution || '1m');
  const from = Number(input.from);
  const to = Number(input.to);
  if (!/^\d+[smhd]$/.test(resolution) || !Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    const error = new Error('GMGN kline window is invalid');
    error.code = 'GMGN_MARKET_ARGUMENT_INVALID';
    throw error;
  }
  const http = dependencies.http || gmgnHttp;
  const data = await http.getTokenKline(chain, address, resolution, from, to, input.requestOptions || {});
  const rows = gmgnAdapter.normalizeKline(data);
  return { source: 'gmgn_token_kline', rows, coverage: { returned_count: rows.length, complete: rows.length > 0 } };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    const error = new Error(`Value must be an integer between ${minimum} and ${maximum}`);
    error.code = 'GMGN_MARKET_ARGUMENT_INVALID';
    throw error;
  }
  return parsed;
}

function validInterval(value, fallback = '24h') {
  const interval = String(value || fallback);
  if (!INTERVALS.has(interval)) {
    const error = new Error(`Unsupported GMGN market interval: ${value}`);
    error.code = 'GMGN_MARKET_ARGUMENT_INVALID';
    throw error;
  }
  return interval;
}

function sourceResult(source, normalized, extra = {}) {
  return {
    source,
    candidates: normalized.candidates.map((candidate) => ({
      ...candidate,
      sources: [source]
    })),
    coverage: {
      returned_count: normalized.returnedCount,
      accepted_count: normalized.candidates.length,
      rejected_schema_count: normalized.rejectedCount,
      complete: normalized.rejectedCount === 0
    },
    ...extra
  };
}

async function fetchRank(input = {}, dependencies = {}) {
  const chain = requireChain(input.chain).id;
  const interval = validInterval(input.interval, '24h');
  const limit = boundedInteger(input.limit, 100, 1, 100);
  const http = dependencies.http || gmgnHttp;
  const data = await http.getMarketRank(chain, interval, {
    limit,
    ...(input.orderBy ? { order_by: String(input.orderBy) } : {}),
    ...(input.direction ? { direction: String(input.direction) } : {}),
    ...(Array.isArray(input.filters) ? { filters: input.filters } : {}),
    ...(Array.isArray(input.platforms) ? { launchpad_platform: input.platforms } : {})
  }, input.requestOptions || {});
  return sourceResult('gmgn_rank', gmgnAdapter.normalizeMarketCollection(data, { chain }));
}

function normalizeHotParams(params) {
  if (!Array.isArray(params) || params.length === 0) {
    const error = new Error('GMGN hot searches requires at least one explicit chain parameter');
    error.code = 'GMGN_MARKET_ARGUMENT_INVALID';
    throw error;
  }
  return params.map((param) => {
    const chain = requireChain(param.chain).id;
    return {
      ...param,
      chain,
      interval: validInterval(param.interval, '24h'),
      limit: boundedInteger(param.limit, 100, 1, 500)
    };
  });
}

async function fetchHotSearches(input = {}, dependencies = {}) {
  const params = normalizeHotParams(input.params);
  const http = dependencies.http || gmgnHttp;
  const data = await http.getMarketHotSearches(params, input.requestOptions || {});
  return sourceResult('gmgn_hot', gmgnAdapter.normalizeMarketCollection(data));
}

function buildTrenchesBody(input = {}) {
  const types = (input.types?.length ? input.types : [...TRENCH_TYPES])
    .map(String);
  if (types.some((type) => !TRENCH_TYPES.has(type))) {
    const error = new Error('GMGN trenches type is invalid');
    error.code = 'GMGN_MARKET_ARGUMENT_INVALID';
    throw error;
  }
  const numericFilters = Object.fromEntries(Object.entries(
    input.filters && typeof input.filters === 'object' ? input.filters : {}
  ).filter(([key, value]) => (
    /^(?:min|max)_[a-z0-9_]+$/.test(key)
      && (typeof value === 'number' || typeof value === 'string')
  )));
  const section = {
    ...numericFilters,
    filters: ['offchain', 'onchain'],
    launchpad_platform_v2: true,
    limit: boundedInteger(input.limit, 80, 1, 80)
  };
  if (Array.isArray(input.platforms) && input.platforms.length > 0) {
    section.launchpad_platform = input.platforms.map(String);
  }
  return Object.fromEntries([
    ['version', 'v2'],
    ...types.map((type) => [type, { ...section }])
  ]);
}

async function fetchTrenches(input = {}, dependencies = {}) {
  const chain = requireChain(input.chain).id;
  const body = buildTrenchesBody(input);
  const http = dependencies.http || gmgnHttp;
  const data = await http.getMarketTrenches(chain, body, input.requestOptions || {});
  return sourceResult('gmgn_trenches', gmgnAdapter.normalizeMarketCollection(data, { chain }));
}

async function fetchTopHolders(input = {}, dependencies = {}) {
  const chain = requireChain(input.chain).id;
  const address = validateTokenAddress(chain, input.address);
  const http = dependencies.http || gmgnHttp;
  const orderBy = String(input.orderBy || 'amount_percentage');
  const direction = String(input.direction || 'desc').toLowerCase();
  const tag = input.tag ? String(input.tag) : null;
  if (!HOLDER_ORDER_FIELDS.has(orderBy) || !['asc', 'desc'].includes(direction)
      || (tag && !HOLDER_TAGS.has(tag))) {
    const error = new Error('GMGN holder sort or tag is invalid');
    error.code = 'GMGN_MARKET_ARGUMENT_INVALID';
    throw error;
  }
  const data = await http.getTokenTopHolders(chain, address, {
    limit: boundedInteger(input.limit, 20, 1, 100),
    order_by: orderBy,
    direction,
    ...(tag ? { tag } : {})
  }, input.requestOptions || {});
  const holders = gmgnAdapter.normalizeHolderCollection(data);
  return {
    source: 'gmgn_top_holders',
    holders,
    coverage: {
      returned_count: Array.isArray(data?.list) ? data.list.length : Array.isArray(data) ? data.length : 0,
      accepted_count: holders.length,
      complete: Array.isArray(data?.list) || Array.isArray(data)
    }
  };
}

function settledValue(result, normalizer) {
  if (result.status !== 'fulfilled') return { value: null, error: result.reason };
  try {
    return { value: normalizer(result.value), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

async function verifyCandidate(candidate, options = {}) {
  const chain = requireChain(candidate.chainId ?? candidate.chain_id ?? candidate.chain).id;
  const address = validateTokenAddress(
    chain,
    candidate.contractAddress ?? candidate.contract_address ?? candidate.address
  );
  const http = options.http || gmgnHttp;
  const [infoResult, securityResult, poolResult] = await Promise.allSettled([
    http.getTokenInfo(chain, address, options.requestOptions || {}),
    http.getTokenSecurity(chain, address, options.requestOptions || {}),
    http.getTokenPoolInfo(chain, address, options.requestOptions || {})
  ]);
  const info = settledValue(infoResult, gmgnAdapter.normalizeTokenInfo);
  if (info.error) throw info.error;
  const security = settledValue(securityResult, (value) => gmgnAdapter.normalizeSecurity(value, chain));
  const pool = settledValue(poolResult, gmgnAdapter.normalizePool);
  const providerAddress = String(info.value.address || '').trim();
  const normalizedProviderAddress = chain === 'sol' ? providerAddress : providerAddress.toLowerCase();
  if (!normalizedProviderAddress) {
    const error = new Error('GMGN token info did not return the verified address');
    error.code = 'GMGN_SCHEMA_INVALID';
    throw error;
  }
  if (normalizedProviderAddress !== address) {
    const error = new Error('GMGN token info address does not match the requested candidate');
    error.code = 'GMGN_ADDRESS_MISMATCH';
    throw error;
  }

  let tradableStatus = 'unknown';
  if (security.value?.isHoneypot === true || security.value?.isSellable === false
      || security.value?.isBlacklisted === true || pool.value?.liquidityUsd === 0) {
    tradableStatus = 'untradable';
  } else if (!security.error && !pool.error && pool.value?.liquidityUsd !== null) {
    tradableStatus = pool.value.liquidityUsd > 0 ? 'tradable' : 'untradable';
  }

  return {
    ...candidate,
    chainId: chain,
    contractAddress: address,
    providerAddress: normalizedProviderAddress,
    name: info.value.name || candidate.name || '',
    symbol: info.value.symbol || candidate.symbol || '',
    launchpad: info.value.launchpad || candidate.launchpad || '',
    xHandles: [...new Set([
      ...(candidate.xHandles || []),
      info.value.officialXHandle
    ].filter(Boolean))],
    marketCapUsd: info.value.marketCapUsd ?? candidate.marketCapUsd ?? null,
    liquidityUsd: pool.value?.liquidityUsd ?? info.value.liquidityUsd ?? candidate.liquidityUsd ?? null,
    holderCount: info.value.holderCount ?? candidate.holderCount ?? null,
    renownedWallets: info.value.renownedWallets ?? candidate.renownedWallets ?? null,
    smartWallets: info.value.smartWallets ?? candidate.smartWallets ?? null,
    providerStatus: 'verified',
    tradableStatus,
    security: security.value || {},
    fieldAvailability: {
      ...info.value.fieldAvailability,
      security: security.error ? 'unknown' : 'known',
      pool: pool.error ? 'unknown' : 'known',
      pool_liquidity: pool.value?.liquidityUsd === null || pool.value?.liquidityUsd === undefined
        ? 'unknown'
        : 'known'
    },
    providerSnapshot: {
      info: info.value,
      security: security.value || { error: String(security.error?.code || 'GMGN_SECURITY_UNKNOWN') },
      pool: pool.value || { error: String(pool.error?.code || 'GMGN_POOL_UNKNOWN') }
    }
  };
}

module.exports = {
  INTERVALS,
  HOLDER_ORDER_FIELDS,
  HOLDER_TAGS,
  TRENCH_TYPES,
  buildTrenchesBody,
  fetchHotSearches,
  fetchKline,
  fetchRank,
  fetchTopHolders,
  fetchTrenches,
  normalizeHotParams,
  verifyCandidate
};
