const db = require('../../lib/db');
const {
  CandidateIndex, boundedIndexText, candidateKey, normalizeCandidate
} = require('./candidate-index');
const { normalizeName, normalizeSymbol } = require('./content-extractor');

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

function familyKey(candidate) {
  return candidate.assetFamilyKey || `variant:${candidateKey(candidate)}`;
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
  const identity = familyKey(candidate);
  const familyResult = await executor.query(
    `INSERT INTO dynamic_asset_families
      (identity_key, canonical_name, canonical_symbol, evidence)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (identity_key) DO UPDATE SET
       canonical_name = COALESCE(NULLIF(EXCLUDED.canonical_name, ''), dynamic_asset_families.canonical_name),
       canonical_symbol = COALESCE(NULLIF(EXCLUDED.canonical_symbol, ''), dynamic_asset_families.canonical_symbol),
       evidence = dynamic_asset_families.evidence || EXCLUDED.evidence,
       updated_at = NOW()
     RETURNING id`,
    [identity, candidate.name || null, candidate.symbol || null,
      JSON.stringify({ sources: candidate.sources || [sourceType] })]
  );
  const market = {
    market_cap_usd: candidate.marketCapUsd ?? null,
    liquidity_usd: candidate.liquidityUsd ?? null,
    holder_count: candidate.holderCount ?? null
  };
  const variantResult = await executor.query(
    `INSERT INTO dynamic_asset_variants
      (asset_family_id, chain_id, contract_address, name, symbol, launchpad,
       official_x_handles, source_types, provider_status, tradable_status,
       market_snapshot, security_snapshot, field_availability, fetched_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (chain_id, contract_address) DO UPDATE SET
       asset_family_id = EXCLUDED.asset_family_id,
       name = COALESCE(NULLIF(EXCLUDED.name, ''), dynamic_asset_variants.name),
       symbol = COALESCE(NULLIF(EXCLUDED.symbol, ''), dynamic_asset_variants.symbol),
       launchpad = COALESCE(NULLIF(EXCLUDED.launchpad, ''), dynamic_asset_variants.launchpad),
       official_x_handles = ARRAY(SELECT DISTINCT unnest(
         dynamic_asset_variants.official_x_handles || EXCLUDED.official_x_handles)),
       source_types = ARRAY(SELECT DISTINCT unnest(
         dynamic_asset_variants.source_types || EXCLUDED.source_types)),
       provider_status = EXCLUDED.provider_status,
       tradable_status = EXCLUDED.tradable_status,
       market_snapshot = dynamic_asset_variants.market_snapshot || EXCLUDED.market_snapshot,
       security_snapshot = dynamic_asset_variants.security_snapshot || EXCLUDED.security_snapshot,
       field_availability = dynamic_asset_variants.field_availability || EXCLUDED.field_availability,
       fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at, updated_at = NOW()
     RETURNING *`,
    [familyResult.rows[0].id, candidate.chainId, candidate.contractAddress,
      candidate.name || null, candidate.symbol || null, candidate.launchpad || null,
      candidate.xHandles || [], [...new Set([...(candidate.sources || []), sourceType])],
      candidate.providerStatus || 'unknown', candidate.tradableStatus || 'unknown',
      JSON.stringify(market),
      JSON.stringify(candidate.security || candidate.providerSnapshot?.security || {}),
      JSON.stringify(candidate.fieldAvailability || {}),
      fetchedAt, expiresAt]
  );
  const variant = variantResult.rows[0];
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
  familyKey,
  loadIndex,
  upsertCandidate,
  upsertMany
};
