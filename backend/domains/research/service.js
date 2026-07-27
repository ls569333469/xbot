const crypto = require('crypto');
const db = require('../../lib/db');
const gmgnHttp = require('../../lib/gmgn-http');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const { cache, cacheTtls } = require('../../lib/gmgn-cache');
const { requireChain, validateTokenAddress } = require('../trade/chain-adapters');
const { X6551Client } = require('../../lib/x-client-6551');
const {
  XAI_MODEL,
  XAI_PROMPT_VERSION,
  discoverCandidates
} = require('./xai-client');
const { sanitizeCandidate, sanitizeTokenMetadata } = require('./sanitizers');

const REPORT_ANALYZER_VERSION = 'p16-v3';
const CONFIDENCE_RANK = new Map([
  ['unverified', 0], ['low', 1], ['medium', 2], ['high', 3], ['verified', 4]
]);

function normalizeRequest(chainId, addressValue) {
  const chain = requireChain(String(chainId || '').trim().toLowerCase());
  const rawAddress = String(addressValue || '').trim();
  const address = chain.id === 'sol' ? rawAddress : rawAddress.toLowerCase();
  validateTokenAddress(chain.id, address);
  return { chain, address };
}

async function getTokenMetadata(chainId, addressValue, options = {}) {
  const { chain, address } = normalizeRequest(chainId, addressValue);
  const entry = await cache.getOrLoad(
    `research:token:${chain.id}:${address}`,
    cacheTtls().token,
    () => gmgnHttp.getTokenInfo(chain.id, address, options)
  );
  return sanitizeTokenMetadata(chain.id, address, entry.value);
}

async function verifyOfficialCandidate(metadata) {
  if (!metadata.official_x_handle) return null;
  const base = sanitizeCandidate({
    handle: metadata.official_x_handle,
    role: 'official_project',
    confidence: 'high',
    source: 'gmgn',
    evidence: [{
      label: 'GMGN token metadata official X',
      source: 'gmgn'
    }]
  });
  const token = String(process.env.OPENNEWS_TOKEN || '').trim();
  if (!token) return base;
  try {
    const profile = await new X6551Client(token).getUserProfile(metadata.official_x_handle);
    return sanitizeCandidate({
      ...base,
      handle: profile.handle,
      display_name: profile.name,
      confidence: 'verified',
      verified: true,
      source: 'gmgn+6551',
      evidence: [
        ...base.evidence,
        { label: '6551 profile resolved', source: '6551' }
      ]
    });
  } catch {
    return base;
  }
}

function reportCacheKey(chainId, address, metadata) {
  return crypto.createHash('sha256').update(JSON.stringify({
    chain_id: chainId,
    contract_address: address,
    metadata_version: metadata?.fetched_at || 'unknown',
    metadata_source: metadata?.source || 'unknown',
    prompt_version: XAI_PROMPT_VERSION
  })).digest('hex');
}

function mergeCandidate(left, right) {
  if (!left) return right;
  if (!right) return left;
  const preferred = (CONFIDENCE_RANK.get(right.confidence) || 0)
    > (CONFIDENCE_RANK.get(left.confidence) || 0) ? right : left;
  const evidence = new Map();
  [...(left.evidence || []), ...(right.evidence || [])].forEach((item) => {
    evidence.set(JSON.stringify(item), item);
  });
  const officialRole = [left, right].find((item) => item.role === 'official_project')?.role;
  return {
    ...left,
    ...right,
    ...preferred,
    role: officialRole || preferred.role,
    display_name: right.display_name || left.display_name,
    organization: right.organization || left.organization,
    association: preferred.association || right.association || left.association,
    verified: left.verified === true || right.verified === true,
    source: [...new Set([left.source, right.source].filter(Boolean))].join('+'),
    evidence: [...evidence.values()].slice(0, 8)
  };
}

async function mapWithConcurrency(values, limit, worker) {
  const output = new Array(values.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return output;
}

function mergeCandidates(...groups) {
  const merged = new Map();
  groups.flat().filter(Boolean).forEach((candidate) => {
    merged.set(candidate.handle, mergeCandidate(merged.get(candidate.handle), candidate));
  });
  return [...merged.values()];
}

async function verifyCandidates(candidates, metadata, options = {}) {
  const token = String(process.env.OPENNEWS_TOKEN || '').trim();
  if ((!token && !options.client) || candidates.length === 0) return candidates;
  const client = options.client || new X6551Client(token);
  const contractAddress = String(options.contract_address || metadata.address || '').trim();
  return mapWithConcurrency(candidates, 3, async (candidate) => {
    try {
      const profile = await client.getUserProfile(candidate.handle);
      const isOfficial = candidate.handle === metadata.official_x_handle;
      let caEvidence = null;
      let evidenceError = null;
      if (contractAddress) {
        try {
          const tweets = await client.searchTweets({
            keywords: contractAddress,
            fromUser: candidate.handle,
            maxResults: 10,
            product: 'Latest'
          });
          const exact = tweets.find((tweet) => (
            String(tweet.text || '').toLowerCase().includes(contractAddress.toLowerCase())
          ));
          if (exact) {
            caEvidence = {
              label: '6551 exact CA post resolved',
              url: /^\d+$/.test(exact.id)
                ? `https://x.com/${profile.handle}/status/${exact.id}`
                : null,
              tweet_id: exact.id,
              source: '6551'
            };
          }
        } catch (error) {
          evidenceError = String(error.code || 'X6551_SEARCH_UNAVAILABLE').slice(0, 80);
        }
      }
      return {
        ...candidate,
        display_name: profile.name || candidate.display_name,
        confidence: isOfficial ? 'verified' : candidate.confidence,
        verified: isOfficial || candidate.verified === true,
        profile_resolved: true,
        follower_count: profile.followers_count,
        source: [...new Set([candidate.source, '6551'].filter(Boolean))].join('+'),
        evidence: mergeCandidate(candidate, {
          ...candidate,
          evidence: [
            { label: '6551 profile resolved', source: '6551' },
            caEvidence
          ].filter(Boolean)
        }).evidence,
        evidence_verification_error: evidenceError
      };
    } catch (error) {
      return {
        ...candidate,
        profile_resolved: false,
        verification_error: String(error.code || 'X6551_PROFILE_UNAVAILABLE').slice(0, 80)
      };
    }
  });
}

async function upsertActorCandidate(candidate, chainId, executor = db) {
  if (!candidate) return;
  await executor.query(
    `INSERT INTO x_actor_directory
      (handle, display_name, role_types, organization, chain_ids, source_types,
       evidence, confidence, status, is_verified, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'candidate', $9,
       CASE WHEN $9 THEN NOW() ELSE NULL END)
     ON CONFLICT (lower(handle)) DO UPDATE SET
       display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), x_actor_directory.display_name),
       role_types = ARRAY(SELECT DISTINCT value FROM unnest(
         x_actor_directory.role_types || EXCLUDED.role_types) AS value ORDER BY value),
       organization = COALESCE(NULLIF(EXCLUDED.organization, ''), x_actor_directory.organization),
       chain_ids = ARRAY(SELECT DISTINCT value FROM unnest(
         x_actor_directory.chain_ids || EXCLUDED.chain_ids) AS value ORDER BY value),
       source_types = ARRAY(SELECT DISTINCT value FROM unnest(
         x_actor_directory.source_types || EXCLUDED.source_types) AS value ORDER BY value),
       evidence = (
         SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
         FROM (
           SELECT DISTINCT item
           FROM jsonb_array_elements(
             x_actor_directory.evidence || EXCLUDED.evidence
           ) AS evidence_item(item)
           ORDER BY item
           LIMIT 32
         ) AS merged_evidence
       ),
       confidence = CASE
         WHEN array_position(
           ARRAY['unverified','low','medium','high','verified']::text[],
           EXCLUDED.confidence
         ) >= array_position(
           ARRAY['unverified','low','medium','high','verified']::text[],
           x_actor_directory.confidence
         ) THEN EXCLUDED.confidence
         ELSE x_actor_directory.confidence
       END,
       is_verified = x_actor_directory.is_verified OR EXCLUDED.is_verified,
       last_verified_at = CASE WHEN EXCLUDED.is_verified THEN NOW()
         ELSE x_actor_directory.last_verified_at END,
       updated_at = NOW()`,
    [
      candidate.handle,
      candidate.display_name,
      [candidate.role],
      candidate.organization || null,
      [chainId],
      [candidate.source],
      JSON.stringify(candidate.evidence || []),
      candidate.verified === true ? 'verified' : candidate.confidence,
      candidate.verified === true
    ]
  );
}

async function createReport(input) {
  const { chain, address } = normalizeRequest(input.chain_id, input.contract_address);
  const metadata = await getTokenMetadata(chain.id, address);
  const [securityResult, poolResult, officialCandidate] = await Promise.all([
    gmgnHttp.getTokenSecurity(chain.id, address)
      .then((value) => gmgnAdapter.normalizeSecurity(value, chain.id))
      .catch((error) => ({ error: error.code || 'GMGN_SECURITY_UNAVAILABLE' })),
    gmgnHttp.getTokenPoolInfo(chain.id, address)
      .then((value) => gmgnAdapter.normalizePool(value))
      .catch((error) => ({ error: error.code || 'GMGN_POOL_UNAVAILABLE' })),
    verifyOfficialCandidate(metadata)
  ]);
  const candidates = officialCandidate ? [officialCandidate] : [];
  const providerSnapshot = {
    metadata,
    security: securityResult.error ? { error: securityResult.error } : {
      is_honeypot: securityResult.isHoneypot,
      buy_tax: securityResult.buyTax,
      sell_tax: securityResult.sellTax,
      rug_ratio: securityResult.rugRatio,
      top_10_holder_rate: securityResult.top10HolderRate
    },
    pool: poolResult.error ? { error: poolResult.error } : {
      liquidity_usd: poolResult.liquidityUsd
    },
    sources: ['gmgn', ...(officialCandidate?.source.includes('6551') ? ['6551'] : [])]
  };
  const status = securityResult.error || poolResult.error ? 'partial' : 'completed';
  const cacheKey = reportCacheKey(chain.id, address, metadata);
  const result = await db.query(
    `INSERT INTO token_research_reports
      (chain_id, contract_address, status, provider_snapshot, candidates,
       analyzer_version, prompt_version, cache_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '1 hour')
     RETURNING *`,
    [
      chain.id,
      address,
      status,
      providerSnapshot,
      JSON.stringify(candidates),
      REPORT_ANALYZER_VERSION,
      XAI_PROMPT_VERSION,
      cacheKey
    ]
  );
  await Promise.all(candidates.map((candidate) => upsertActorCandidate(candidate, chain.id)));
  return result.rows[0];
}

async function findReusableReport(chainId, addressValue) {
  const { chain, address } = normalizeRequest(chainId, addressValue);
  const result = await db.query(
    `SELECT * FROM token_research_reports
     WHERE chain_id = $1 AND contract_address = $2
       AND prompt_version = $3
       AND analyzer_version = $4
       AND xai_error_code IS NULL
       AND analysis_finished_at IS NOT NULL
       AND expires_at > NOW()
     ORDER BY analysis_finished_at DESC, id DESC
     LIMIT 1`,
    [chain.id, address, XAI_PROMPT_VERSION, `${REPORT_ANALYZER_VERSION}+xai`]
  );
  return result.rows[0] || null;
}

async function getReport(id) {
  const result = await db.query('SELECT * FROM token_research_reports WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function expandReport(id, options = {}) {
  const report = await getReport(id);
  if (!report) throw new Error('Research report not found');
  const metadata = report.provider_snapshot?.metadata || {};
  const startedAt = Date.now();
  await db.query(
    `UPDATE token_research_reports
     SET analysis_started_at = NOW(), analysis_finished_at = NULL,
         xai_error_code = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
  try {
    const expanded = await discoverCandidates({
      chain: report.chain_id,
      address: report.contract_address,
      name: metadata.name,
      symbol: metadata.symbol,
      website_url: metadata.website_url,
      official_x_handle: metadata.official_x_handle
    });
    await options.onStage?.('verification');
    const candidates = await verifyCandidates(
      mergeCandidates(report.candidates || [], expanded.candidates),
      metadata,
      { contract_address: report.contract_address }
    );
    const durationMs = Date.now() - startedAt;
    const result = await db.query(
      `UPDATE token_research_reports
       SET candidates = $1,
           provider_snapshot = provider_snapshot || $2::jsonb,
           analyzer_version = $3, prompt_version = $4, model_name = $5,
           xai_duration_ms = $6, xai_error_code = NULL,
           analysis_finished_at = NOW(), updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [
        JSON.stringify(candidates),
        {
          xai: {
            status: 'completed',
            model: XAI_MODEL,
            prompt_version: XAI_PROMPT_VERSION,
            duration_ms: durationMs,
            summary: expanded.summary,
            citations: expanded.citations,
            usage: expanded.usage
          }
        },
        `${REPORT_ANALYZER_VERSION}+xai`,
        XAI_PROMPT_VERSION,
        XAI_MODEL,
        durationMs,
        id
      ]
    );
    await Promise.all(candidates.map((candidate) => (
      upsertActorCandidate(candidate, report.chain_id)
    )));
    return result.rows[0];
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorCode = String(error.code || 'XAI_RESEARCH_FAILED').slice(0, 80);
    await db.query(
      `UPDATE token_research_reports
       SET provider_snapshot = provider_snapshot || $1::jsonb,
           model_name = $2, prompt_version = $3,
           xai_duration_ms = $4, xai_error_code = $5,
           analysis_finished_at = NOW(), updated_at = NOW()
       WHERE id = $6`,
      [
        {
          xai: {
            status: 'failed',
            model: XAI_MODEL,
            prompt_version: XAI_PROMPT_VERSION,
            duration_ms: durationMs,
            error_code: errorCode,
            usage: error.usage || null
          }
        },
        XAI_MODEL,
        XAI_PROMPT_VERSION,
        durationMs,
        errorCode,
        id
      ]
    );
    throw error;
  }
}

function candidateEvidenceSnapshot(candidate) {
  return {
    source: candidate.source,
    display_name: candidate.display_name,
    role: candidate.role,
    organization: candidate.organization,
    association: candidate.association || '',
    confidence: candidate.confidence,
    verified: candidate.verified === true,
    evidence: candidate.evidence || []
  };
}

async function reportToWhitelistDraft(id) {
  const report = await getReport(id);
  if (!report) throw new Error('Research report not found');
  const metadata = report.provider_snapshot?.metadata || {};
  const templateResult = await db.query(
    `SELECT * FROM whitelist_templates
     WHERE chain_id = $1
     ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
    [report.chain_id]
  );
  const template = templateResult.rows[0] || null;
  const candidates = (report.candidates || []).map((candidate) => ({
    ...candidate,
    selected: ['verified', 'high'].includes(candidate.confidence)
  }));
  const selectedProject = candidates.filter((candidate) => candidate.selected);
  return {
    chain_id: report.chain_id,
    contract_address: report.contract_address,
    symbol: metadata.symbol || '',
    project_name: metadata.name || '',
    token_logo_url: metadata.logo_url || null,
    token_official_x_handle: metadata.official_x_handle || null,
    token_website_url: metadata.website_url || null,
    token_metadata_source: metadata.source || 'gmgn',
    token_metadata_fetched_at: metadata.fetched_at || null,
    ...(template?.template_snapshot || {}),
    template_id: template?.id || null,
    candidates,
    direct_sources: [],
    project_accounts: selectedProject.map((candidate) => ({
      handle: candidate.handle,
      role: candidate.role,
      usage: 'identity',
      evidence_snapshot: candidateEvidenceSnapshot(candidate)
    })),
    relations: []
  };
}

async function listActors(filters = {}) {
  const search = String(filters.search || '').trim();
  const chain = String(filters.chain_id || '').trim().toLowerCase();
  const parsedPage = Number(filters.page ?? 1);
  const parsedPageSize = Number(filters.page_size ?? 20);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const pageSize = Number.isSafeInteger(parsedPageSize) && parsedPageSize > 0
    ? Math.min(100, parsedPageSize)
    : 20;
  const result = await db.query(
    `SELECT * FROM x_actor_directory
     WHERE ($1 = '' OR handle ILIKE '%' || $1 || '%'
       OR display_name ILIKE '%' || $1 || '%'
       OR organization ILIKE '%' || $1 || '%'
       OR $1 = ANY(role_types))
       AND ($2 = '' OR $2 = ANY(chain_ids))
     ORDER BY is_favorite DESC, use_count DESC, updated_at DESC
     LIMIT $3 OFFSET $4`,
    [search, chain, pageSize, (page - 1) * pageSize]
  );
  return result.rows;
}

module.exports = {
  candidateEvidenceSnapshot,
  createReport,
  expandReport,
  findReusableReport,
  getReport,
  getTokenMetadata,
  listActors,
  normalizeRequest,
  reportToWhitelistDraft,
  reportCacheKey,
  mergeCandidates,
  upsertActorCandidate,
  verifyCandidates,
  verifyOfficialCandidate,
  REPORT_ANALYZER_VERSION
};
