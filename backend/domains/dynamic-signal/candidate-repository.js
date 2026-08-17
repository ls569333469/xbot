const db = require('../../lib/db');
const {
  CandidateIndex, boundedIndexText, candidateKey, normalizeCandidate
} = require('./candidate-index');
const { normalizeName, normalizeSymbol } = require('./content-extractor');
const assetRegistry = require('./asset-registry');

const DEFAULT_GMGN_CANDIDATE_TTL_MS = 5 * 60_000;
const MIN_GMGN_CANDIDATE_TTL_MS = 60_000;
const MAX_GMGN_CANDIDATE_TTL_MS = 60 * 60_000;

function boundedGmgnCandidateTtlMs(value = process.env.P20_GMGN_CANDIDATE_TTL_MS) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_GMGN_CANDIDATE_TTL_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_GMGN_CANDIDATE_TTL_MS;
  return Math.min(MAX_GMGN_CANDIDATE_TTL_MS,
    Math.max(MIN_GMGN_CANDIDATE_TTL_MS, parsed));
}

async function loadIndex(options = {}, executor = db) {
  const chains = Array.isArray(options.allowedChains) ? options.allowedChains : [];
  const params = [];
  let chainClause = '';
  if (chains.length > 0) {
    params.push(chains);
    chainClause = `AND variant.chain_id = ANY($${params.length}::text[])`;
  }
  const result = await executor.query(
    `SELECT variant.*, family.identity_key AS asset_family_key,
            family.canonical_name, family.canonical_symbol,
            COALESCE(json_agg(json_build_object(
              'key_type', idx.key_type, 'normalized_key', idx.normalized_key,
              'source_type', idx.source_type, 'source_ref', idx.source_ref,
              'fetched_at', idx.fetched_at, 'expires_at', idx.expires_at
            )) FILTER (WHERE idx.id IS NOT NULL), '[]') AS index_entries
     FROM dynamic_asset_variants AS variant
     JOIN dynamic_asset_families AS family ON family.id = variant.asset_family_id
     LEFT JOIN dynamic_candidate_index AS idx ON idx.variant_id = variant.id
       AND (idx.expires_at IS NULL OR idx.expires_at > NOW())
     WHERE (variant.expires_at IS NULL OR variant.expires_at > NOW()) ${chainClause}
     GROUP BY variant.id, family.id`, params
  );
  const candidates = result.rows.map((row) => normalizeCandidate({
    ...row,
    xHandles: row.official_x_handles,
    sources: row.source_types,
    marketCapUsd: row.market_snapshot?.market_cap_usd,
    liquidityUsd: row.market_snapshot?.liquidity_usd,
    providerStatus: row.provider_status,
    tradableStatus: row.tradable_status,
    providerSnapshot: { market: row.market_snapshot, security: row.security_snapshot },
    sourcePostIds: row.index_entries
      .filter((entry) => entry.key_type === 'source_post_id').map((entry) => entry.normalized_key)
  })).filter(Boolean);
  return new CandidateIndex(candidates);
}

async function upsertCandidate(value, sourceType, executor = db, options = {}) {
  const candidate = normalizeCandidate(value);
  if (!candidate) return null;
  const fetchedAt = options.fetchedAt || candidate.fetchedAt || new Date();
  const explicitExpiry = Object.prototype.hasOwnProperty.call(options, 'expiresAt')
    ? options.expiresAt : candidate.expiresAt;
  const verifiedTtlMs = boundedGmgnCandidateTtlMs();
  const expiresAt = explicitExpiry || (sourceType === 'gmgn_info'
    ? new Date(new Date(fetchedAt).getTime() + verifiedTtlMs) : null);
  const variant = await assetRegistry.ensureVariant(candidate, sourceType, executor, {
    fetchedAt,
    expiresAt,
    lock: false,
    skipExistingLookup: true
  });
  const sourceRef = boundedIndexText(options.sourceRef) || null;
  const keys = [
    ['chain_ca', `${candidate.chainId}:${candidate.contractAddress}`],
    ['symbol', normalizeSymbol(candidate.symbol)],
    ['name', normalizeName(candidate.name)],
    ['launchpad', normalizeName(candidate.launchpad)],
    ...(candidate.xHandles || []).map((value) => ['x_handle', value]),
    ...(candidate.sourcePostIds || []).map((value) => ['source_post_id', String(value)])
  ].filter(([, key]) => key);
  for (const [keyType, key] of keys) {
    await executor.query(
      `INSERT INTO dynamic_candidate_index
        (variant_id, key_type, normalized_key, source_type, source_ref, fetched_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (variant_id, key_type, normalized_key, source_type, (COALESCE(source_ref, '')))
       DO UPDATE SET field_available = true, fetched_at = EXCLUDED.fetched_at,
         expires_at = EXCLUDED.expires_at`,
      [variant.id, keyType, key, sourceType, sourceRef, fetchedAt, expiresAt]
    );
  }
  return variant;
}

async function upsertMany(values, sourceType, executor = db, options = {}) {
  const output = [];
  for (const value of values || []) {
    const row = await upsertCandidate(value, sourceType, executor, options);
    if (row) output.push(row);
  }
  return output;
}

module.exports = {
  boundedGmgnCandidateTtlMs,
  familyKey: assetRegistry.familyKey,
  loadIndex,
  upsertCandidate,
  upsertMany
};
