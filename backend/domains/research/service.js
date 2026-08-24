const crypto = require('crypto');
const db = require('../../lib/db');
const logger = require('../../lib/logger');
const researchAccess = require('../../lib/gmgn-access-service').accessFor('research');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const { cache, cacheTtls } = require('../../lib/gmgn-cache');
const { requireChain, validateTokenAddress } = require('../trade/chain-adapters');
const { X6551Client } = require('../../lib/x-client-6551');
const {
  XAI_MODEL,
  XAI_PROMPT_VERSION,
  runFirstResearch,
  runFormatRepair,
  runTargetedFollowup,
  structuredResultFromOutput
} = require('./xai-client');
const {
  MAX_GROK_REQUESTS,
  MAX_SEARCH_TOOL_CALLS,
  budgetError,
  ensureCheckpoint,
  getCheckpoint,
  recordResponse,
  reserveRequest,
  searchToolBudgetError,
  withSocialResolution
} = require('./checkpoint-repository');
const { sanitizeCandidate, sanitizeTokenMetadata } = require('./sanitizers');

const REPORT_ANALYZER_VERSION = 'p37-v1';
const CONFIDENCE_RANK = new Map([
  ['unverified', 0], ['low', 1], ['medium', 2], ['high', 3], ['verified', 4]
]);
const ACTIVE_CHECKPOINT_TTL_MS = 4 * 60 * 1000;

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
    () => researchAccess.getTokenInfo(chain.id, address, {
      ...options,
      requestContext: {
        source: 'research',
        stage: 'token_info',
        ...(options.requestContext || {})
      }
    })
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

function hasReliableOfficialCandidate(candidates, metadata = {}) {
  if (metadata.official_x_handle && candidates.some((candidate) => (
    candidate.handle === metadata.official_x_handle
  ))) return true;
  return candidates.some((candidate) => {
    if (candidate.role !== 'official_project' || !['verified', 'high'].includes(candidate.confidence)) {
      return false;
    }
    const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
    return Boolean(candidate.association)
      && evidence.some((item) => item.url || item.tweet_id);
  });
}

function hasResolvedOfficialIdentity(candidates, metadata, providerStatus) {
  if (metadata?.official_x_handle) return hasReliableOfficialCandidate(candidates, metadata);
  return providerStatus === 'resolved' && hasReliableOfficialCandidate(candidates, metadata);
}

function hasProviderConfirmedIdentity(candidates, metadata) {
  const officialHandle = metadata?.official_x_handle;
  if (!officialHandle) return false;
  return candidates.some((candidate) => (
    candidate.handle === officialHandle
      && candidate.role === 'official_project'
      && String(candidate.source || '').split('+').includes('gmgn')
  ));
}

function providerResolutionResult(checkpoint, metadata) {
  return {
    provider: 'gmgn',
    status: 'resolved',
    summary: `GMGN 已提供官方 X @${metadata.official_x_handle}，本次跳过 Grok 搜索。`,
    candidates: [],
    citations: checkpoint.citations || [],
    usage: null,
    searchToolCalls: 0,
    rawOutput: checkpoint.evidence_text || ''
  };
}

function reusableEvidence(error, checkpoint) {
  return String(error?.evidenceText || checkpoint?.evidence_text || '').trim();
}

function secondRequestReason(error, checkpoint) {
  const structureErrors = new Set([
    'XAI_STRUCTURE_OUTPUT_EMPTY',
    'XAI_STRUCTURE_JSON_INVALID',
    'XAI_STRUCTURE_SCHEMA_INVALID'
  ]);
  const errorCode = error?.code || checkpoint?.last_error_code;
  return structureErrors.has(errorCode) && reusableEvidence(error, checkpoint)
    ? 'format_repair'
    : 'targeted_followup';
}

function shouldStopWithoutSecondRequest(error) {
  return new Set([
    'XAI_KEY_MISSING',
    'XAI_BASE_URL_INVALID',
    'XAI_PROXY_URL_INVALID',
    'XAI_AUTH_INVALID',
    'XAI_CREDITS_EXHAUSTED',
    'XAI_PERMISSION_DENIED',
    'XAI_MODEL_UNAVAILABLE'
  ]).has(error?.code);
}

function checkpointRequestInProgress(checkpoint, now = Date.now()) {
  if (!['searching', 'format_repair', 'targeted_followup'].includes(checkpoint?.search_status)) {
    return false;
  }
  const updatedAt = Date.parse(checkpoint.updated_at || '');
  return Number.isFinite(updatedAt) && now - updatedAt < ACTIVE_CHECKPOINT_TTL_MS;
}

function requestInProgressError() {
  const error = new Error('A Grok request is already in progress for this research report');
  error.code = 'XAI_GROK_REQUEST_IN_PROGRESS';
  error.status = 409;
  return error;
}

function mergeCitations(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].slice(0, 30);
}

function appendUsage(checkpoint, phase, usage) {
  const previous = Array.isArray(checkpoint?.search_usage?.requests)
    ? checkpoint.search_usage.requests
    : [];
  return {
    requests: [...previous, { phase, usage: usage || null }].slice(-MAX_GROK_REQUESTS)
  };
}

function summarizeUsage(searchUsage) {
  const summary = {};
  for (const request of Array.isArray(searchUsage?.requests) ? searchUsage.requests : []) {
    for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
      const value = Number(request?.usage?.[key]);
      if (Number.isFinite(value) && value >= 0) summary[key] = (summary[key] || 0) + value;
    }
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function researchInput(report, metadata) {
  return {
    chain: report.chain_id,
    address: report.contract_address,
    name: metadata.name,
    symbol: metadata.symbol,
    website_url: metadata.website_url,
    official_x_handle: metadata.official_x_handle
  };
}

function researchLogMeta(report, phase, options = {}, values = {}) {
  return {
    job_id: options.jobId ? String(options.jobId) : null,
    item_id: options.itemId ? String(options.itemId) : null,
    report_id: String(report.id),
    chain_id: report.chain_id,
    ca_hash: crypto.createHash('sha256').update(report.contract_address).digest('hex').slice(0, 12),
    prompt_version: XAI_PROMPT_VERSION,
    stage: phase,
    ...values
  };
}

async function executeGrokPhase(report, input, checkpoint, phase, reason, options = {}) {
  const phaseStartedAt = Date.now();
  const runner = phase === 'format_repair'
    ? runFormatRepair
    : phase === 'targeted_followup' ? runTargetedFollowup : runFirstResearch;
  const remainingSearchCalls = Math.max(0, MAX_SEARCH_TOOL_CALLS - Number(checkpoint.search_tool_calls || 0));
  if (phase !== 'format_repair' && remainingSearchCalls === 0) throw budgetError();
  let reserved = checkpoint;
  let requestReserved = false;
  const runnerOptions = {
    ...(options.xaiOptions || {}),
    maxToolCalls: Math.min(4, remainingSearchCalls || 4),
    evidenceText: checkpoint.evidence_text,
    citations: checkpoint.citations,
    beforeRequest: async () => {
      reserved = await reserveRequest(report.id, phase === 'first_search' ? 'searching' : phase, {
        reason: reason || null
      });
      requestReserved = true;
      const reservationMeta = researchLogMeta(report, phase, options, {
        grok_request_attempt: Number(reserved.grok_request_attempts),
        request_limit: MAX_GROK_REQUESTS,
        second_request_reason: reason || null,
        search_tool_calls: Number(reserved.search_tool_calls || 0)
      });
      logger.info(
        'project-research',
        Number(reserved.grok_request_attempts) === 2
          ? 'research-xai-second-request-started'
          : 'research-xai-first-request-started',
        reservationMeta
      );
    }
  };
  try {
    const result = await runner(input, runnerOptions);
    const updated = await recordResponse(report.id, {
      search_status: 'result_ready',
      evidence_text: result.rawOutput,
      citations: mergeCitations(reserved.citations, result.citations),
      search_usage: appendUsage(reserved, phase, result.usage),
      search_tool_calls: result.searchToolCalls,
      last_error_code: null
    });
    const completedEvent = phase === 'format_repair'
      ? 'research-xai-format-repair-completed'
      : phase === 'targeted_followup'
        ? 'research-xai-targeted-followup-completed'
        : 'research-xai-first-request-completed';
    logger.info('project-research', completedEvent, researchLogMeta(report, phase, options, {
      grok_request_attempt: Number(updated?.grok_request_attempts || reserved.grok_request_attempts),
      second_request_reason: reason || null,
      search_tool_calls: Number(updated?.search_tool_calls || 0),
      input_tokens: Number(result.usage?.input_tokens || 0),
      output_tokens: Number(result.usage?.output_tokens || 0),
      total_tokens: Number(result.usage?.total_tokens || 0),
      output_length: result.rawOutput.length,
      response_status: result.status,
      duration_ms: Date.now() - phaseStartedAt,
      candidate_count: result.candidates.length
    }));
    return { result, checkpoint: updated || reserved };
  } catch (error) {
    if (!requestReserved) {
      error.checkpoint = await getCheckpoint(report.id) || checkpoint;
      throw error;
    }
    const updated = await recordResponse(report.id, {
      search_status: 'failed',
      evidence_text: error.evidenceText,
      citations: mergeCitations(reserved.citations, error.citations),
      search_usage: appendUsage(reserved, phase, error.usage),
      search_tool_calls: error.searchToolCalls,
      last_error_code: String(error.code || 'XAI_RESEARCH_FAILED').slice(0, 80)
    });
    error.checkpoint = updated || reserved;
    throw error;
  }
}

async function createReport(input) {
  const { chain, address } = normalizeRequest(input.chain_id, input.contract_address);
  const metadata = await getTokenMetadata(chain.id, address);
  const [securityResult, poolResult, officialCandidate] = await Promise.all([
    researchAccess.getTokenSecurity(chain.id, address, {
      requestContext: { source: 'research', stage: 'security' }
    })
      .then((value) => gmgnAdapter.normalizeSecurity(value, chain.id))
      .catch((error) => ({ error: error.code || 'GMGN_SECURITY_UNAVAILABLE' })),
    researchAccess.getTokenPoolInfo(chain.id, address, {
      requestContext: { source: 'research', stage: 'pool' }
    })
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
  return withSocialResolution(result.rows[0], null);
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
  const report = result.rows[0] || null;
  if (!report) return null;
  const checkpoint = await getCheckpoint(report.id);
  return withSocialResolution(report, checkpoint);
}

async function expandReport(id, options = {}) {
  const reportResult = await db.query('SELECT * FROM token_research_reports WHERE id = $1', [id]);
  const report = reportResult.rows[0] || null;
  if (!report) throw new Error('Research report not found');
  const metadata = report.provider_snapshot?.metadata || {};
  const input = researchInput(report, metadata);
  const startedAt = Date.now();
  let checkpoint = await ensureCheckpoint({
    ...report,
    prompt_version: XAI_PROMPT_VERSION
  });
  if (checkpointRequestInProgress(checkpoint)) throw requestInProgressError();
  if (report.analysis_finished_at
      && !report.xai_error_code
      && report.analyzer_version === `${REPORT_ANALYZER_VERSION}+xai`
      && ['completed', 'insufficient'].includes(checkpoint.search_status)) {
    return withSocialResolution(report, checkpoint);
  }
  await db.query(
    `UPDATE token_research_reports
     SET analysis_started_at = NOW(), analysis_finished_at = NULL,
         prompt_version = $2, xai_error_code = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id, XAI_PROMPT_VERSION]
  );
  try {
    let expanded = null;
    let discoveredCandidates = [];
    let firstError = null;
    if (checkpoint.search_status === 'result_ready' && checkpoint.evidence_text) {
      try {
        expanded = structuredResultFromOutput(checkpoint.evidence_text, {
          citations: checkpoint.citations,
          searchToolCalls: checkpoint.search_tool_calls
        });
        discoveredCandidates = expanded.candidates;
      } catch {
        expanded = null;
      }
    }
    if (!expanded && hasProviderConfirmedIdentity(report.candidates || [], metadata)) {
      expanded = providerResolutionResult(checkpoint, metadata);
      logger.info('project-research', 'research-xai-skipped-provider-confirmed', researchLogMeta(
        report,
        'gmgn_confirmed',
        options,
        {
          official_handle: metadata.official_x_handle,
          grok_request_attempt: Number(checkpoint.grok_request_attempts || 0),
          search_tool_calls: Number(checkpoint.search_tool_calls || 0)
        }
      ));
    }
    if (!expanded && Number(checkpoint.grok_request_attempts) === 0) {
      try {
        const first = await executeGrokPhase(report, input, checkpoint, 'first_search', null, options);
        expanded = first.result;
        discoveredCandidates = first.result.candidates;
        checkpoint = first.checkpoint;
      } catch (error) {
        firstError = error;
        checkpoint = error.checkpoint || await getCheckpoint(report.id) || checkpoint;
      }
    }

    const mergedAfterFirst = expanded
      ? mergeCandidates(report.candidates || [], expanded.candidates)
      : report.candidates || [];
    const firstSucceeded = expanded
      && hasResolvedOfficialIdentity(mergedAfterFirst, metadata, expanded.status);
    if (!firstSucceeded) {
      if (firstError && shouldStopWithoutSecondRequest(firstError)) throw firstError;
      if (Number(checkpoint.search_tool_calls) >= MAX_SEARCH_TOOL_CALLS) {
        if (firstError) throw firstError;
        throw searchToolBudgetError();
      }
      if (Number(checkpoint.grok_request_attempts) >= MAX_GROK_REQUESTS) {
        if (firstError) throw firstError;
        throw budgetError();
      }
      let reason = checkpoint.second_request_reason;
      if (!reason) reason = expanded ? 'targeted_followup' : secondRequestReason(firstError, checkpoint);
      if (firstError?.code === 'XAI_RATE_LIMITED' && firstError.retryAfterMs) {
        const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        await sleep(firstError.retryAfterMs);
      }
      await options.onStage?.('grok');
      const second = await executeGrokPhase(report, input, checkpoint, reason, reason, options);
      expanded = second.result;
      discoveredCandidates = mergeCandidates(discoveredCandidates, second.result.candidates);
      checkpoint = second.checkpoint;
    }

    await options.onStage?.('verification');
    const candidates = await verifyCandidates(
      mergeCandidates(report.candidates || [], discoveredCandidates),
      metadata,
      { contract_address: report.contract_address }
    );
    const resolved = hasResolvedOfficialIdentity(candidates, metadata, expanded.status);
    const resolutionStatus = resolved ? 'completed' : 'insufficient';
    const durationMs = Date.now() - startedAt;
    const usedGrok = Number(checkpoint.grok_request_attempts || 0) > 0;
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
            status: resolutionStatus,
            model: usedGrok ? XAI_MODEL : null,
            prompt_version: XAI_PROMPT_VERSION,
            duration_ms: durationMs,
            summary: expanded.summary,
            citations: checkpoint.citations,
            usage: summarizeUsage(checkpoint.search_usage),
            grok_request_attempts: checkpoint.grok_request_attempts,
            search_tool_calls: checkpoint.search_tool_calls
          }
        },
        `${REPORT_ANALYZER_VERSION}+xai`,
        XAI_PROMPT_VERSION,
        usedGrok ? XAI_MODEL : null,
        durationMs,
        id
      ]
    );
    await Promise.all(candidates.map((candidate) => (
      upsertActorCandidate(candidate, report.chain_id)
    )));
    checkpoint = await recordResponse(report.id, {
      search_status: resolutionStatus,
      evidence_text: expanded.rawOutput,
      citations: checkpoint.citations,
      search_usage: checkpoint.search_usage,
      search_tool_calls: 0,
      last_error_code: null
    }) || checkpoint;
    return withSocialResolution(result.rows[0], checkpoint);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorCode = String(error.code || 'XAI_RESEARCH_FAILED').slice(0, 80);
    checkpoint = await getCheckpoint(report.id) || checkpoint;
    await recordResponse(report.id, {
      search_status: 'failed',
      evidence_text: checkpoint.evidence_text,
      citations: checkpoint.citations,
      search_usage: checkpoint.search_usage,
      search_tool_calls: 0,
      last_error_code: errorCode
    });
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
            usage: summarizeUsage(checkpoint.search_usage) || error.usage || null,
            grok_request_attempts: checkpoint.grok_request_attempts,
            search_tool_calls: checkpoint.search_tool_calls
          }
        },
        XAI_MODEL,
        XAI_PROMPT_VERSION,
        durationMs,
        errorCode,
        id
      ]
    );
    logger.warn('project-research', errorCode === 'XAI_GROK_REQUEST_BUDGET_EXHAUSTED'
      ? 'research-xai-budget-exhausted'
      : 'research-xai-failed', researchLogMeta(report, checkpoint.search_status, options, {
      error_code: errorCode,
      grok_request_attempt: Number(checkpoint.grok_request_attempts || 0),
      second_request_reason: checkpoint.second_request_reason || null,
      search_tool_calls: Number(checkpoint.search_tool_calls || 0),
      duration_ms: durationMs
    }));
    throw error;
  }
}

async function retrySocialResolution(id, options = {}) {
  const checkpoint = await getCheckpoint(id);
  if (checkpoint
      && Number(checkpoint.grok_request_attempts) >= MAX_GROK_REQUESTS
      && checkpoint.search_status !== 'result_ready') {
    throw budgetError();
  }
  return expandReport(id, options);
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
  retrySocialResolution,
  reportToWhitelistDraft,
  reportCacheKey,
  mergeCandidates,
  upsertActorCandidate,
  verifyCandidates,
  verifyOfficialCandidate,
  hasReliableOfficialCandidate,
  REPORT_ANALYZER_VERSION
};
