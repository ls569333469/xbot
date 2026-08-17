const db = require('../../lib/db');
const { candidateKey, normalizeCandidate } = require('./candidate-index');

function familyKey(candidate) {
  return candidate.assetFamilyKey || `variant:${candidateKey(candidate)}`;
}

async function ensureVariant(value, sourceType, executor = db, options = {}) {
  const candidate = normalizeCandidate(value);
  if (!candidate) return null;
  const source = String(sourceType || 'unknown');
  const key = candidateKey(candidate);
  if (options.lock !== false) {
    await executor.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dynamic-asset:${key}`]);
  }

  const existingResult = options.skipExistingLookup === true ? { rows: [] } : await executor.query(
      `SELECT variant.*, family.identity_key AS asset_family_key
       FROM dynamic_asset_variants variant
       JOIN dynamic_asset_families family ON family.id = variant.asset_family_id
       WHERE variant.chain_id = $1 AND variant.contract_address = $2
       FOR UPDATE OF variant`,
      [candidate.chainId, candidate.contractAddress]
    );
  const fetchedAt = options.fetchedAt || candidate.fetchedAt || new Date();
  const expiresAt = Object.prototype.hasOwnProperty.call(options, 'expiresAt')
    ? options.expiresAt : candidate.expiresAt;
  const sources = [...new Set([...(candidate.sources || []), source])];
  const identityOnly = options.identityOnly === true;
  const market = {
    ...(identityOnly ? {} : {
      market_cap_usd: candidate.marketCapUsd ?? null,
      liquidity_usd: candidate.liquidityUsd ?? null,
      holder_count: candidate.holderCount ?? null
    }),
    ...(candidate.marketSnapshot || candidate.providerSnapshot?.market || {}),
    ...(candidate.marketCapUsd === undefined ? {} : { market_cap_usd: candidate.marketCapUsd }),
    ...(candidate.liquidityUsd === undefined ? {} : { liquidity_usd: candidate.liquidityUsd }),
    ...(candidate.holderCount === undefined ? {} : { holder_count: candidate.holderCount })
  };

  if (existingResult.rows[0]) {
    const result = await executor.query(
      `UPDATE dynamic_asset_variants SET
         name = COALESCE(NULLIF($3, ''), name),
         symbol = COALESCE(NULLIF($4, ''), symbol),
         launchpad = COALESCE(NULLIF($5, ''), launchpad),
         official_x_handles = ARRAY(SELECT DISTINCT unnest(official_x_handles || $6::text[])),
         source_types = ARRAY(SELECT DISTINCT unnest(source_types || $7::text[])),
         provider_status = CASE
           WHEN provider_status = 'verified' OR $8 = 'verified' THEN 'verified'
           ELSE $8 END,
         tradable_status = CASE WHEN $9 = 'unknown' THEN tradable_status ELSE $9 END,
         market_snapshot = market_snapshot || $10::jsonb,
         security_snapshot = security_snapshot || $11::jsonb,
         field_availability = field_availability || $12::jsonb,
         fetched_at = CASE WHEN $15 THEN fetched_at ELSE COALESCE($13, fetched_at) END,
         expires_at = CASE WHEN $15 THEN expires_at ELSE $14 END,
         updated_at = NOW()
       WHERE chain_id = $1 AND contract_address = $2
       RETURNING *`,
      [candidate.chainId, candidate.contractAddress, candidate.name || null,
        candidate.symbol || null, candidate.launchpad || null, candidate.xHandles || [], sources,
        candidate.providerStatus || 'unknown', candidate.tradableStatus || 'unknown',
        JSON.stringify(market),
        JSON.stringify(candidate.security || candidate.providerSnapshot?.security || {}),
        JSON.stringify(candidate.fieldAvailability || {}), fetchedAt, expiresAt || null,
        identityOnly]
    );
    return result.rows[0];
  }

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
    [identity, candidate.name || null, candidate.symbol || null, JSON.stringify({ sources })]
  );
  const result = await executor.query(
    `INSERT INTO dynamic_asset_variants
      (asset_family_id, chain_id, contract_address, name, symbol, launchpad,
       official_x_handles, source_types, provider_status, tradable_status,
       market_snapshot, security_snapshot, field_availability, fetched_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (chain_id, contract_address) DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name, ''), dynamic_asset_variants.name),
       symbol = COALESCE(NULLIF(EXCLUDED.symbol, ''), dynamic_asset_variants.symbol),
       launchpad = COALESCE(NULLIF(EXCLUDED.launchpad, ''), dynamic_asset_variants.launchpad),
       official_x_handles = ARRAY(SELECT DISTINCT unnest(
         dynamic_asset_variants.official_x_handles || EXCLUDED.official_x_handles)),
       source_types = ARRAY(SELECT DISTINCT unnest(dynamic_asset_variants.source_types || EXCLUDED.source_types)),
       provider_status = CASE
         WHEN dynamic_asset_variants.provider_status = 'verified' OR EXCLUDED.provider_status = 'verified'
           THEN 'verified' ELSE EXCLUDED.provider_status END,
       tradable_status = CASE WHEN EXCLUDED.tradable_status = 'unknown'
         THEN dynamic_asset_variants.tradable_status ELSE EXCLUDED.tradable_status END,
       market_snapshot = dynamic_asset_variants.market_snapshot || EXCLUDED.market_snapshot,
       security_snapshot = dynamic_asset_variants.security_snapshot || EXCLUDED.security_snapshot,
       field_availability = dynamic_asset_variants.field_availability || EXCLUDED.field_availability,
       fetched_at = CASE WHEN $16 THEN dynamic_asset_variants.fetched_at ELSE EXCLUDED.fetched_at END,
       expires_at = CASE WHEN $16 THEN dynamic_asset_variants.expires_at ELSE EXCLUDED.expires_at END,
       updated_at = NOW()
     RETURNING *`,
    [familyResult.rows[0].id, candidate.chainId, candidate.contractAddress,
      candidate.name || null, candidate.symbol || null, candidate.launchpad || null,
      candidate.xHandles || [], sources, candidate.providerStatus || 'unknown',
      candidate.tradableStatus || 'unknown', JSON.stringify(market),
      JSON.stringify(candidate.security || candidate.providerSnapshot?.security || {}),
      JSON.stringify(candidate.fieldAvailability || {}), fetchedAt, expiresAt || null,
      identityOnly]
  );
  return result.rows[0];
}

async function ensureVariants(values = [], sourceType, executor = db, options = {}) {
  const sorted = (values || []).map(normalizeCandidate).filter(Boolean)
    .sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
  const output = [];
  for (const value of sorted) {
    const variant = await ensureVariant(value, sourceType, executor, options);
    if (variant) output.push(variant);
  }
  return output;
}

module.exports = { ensureVariant, ensureVariants, familyKey };
