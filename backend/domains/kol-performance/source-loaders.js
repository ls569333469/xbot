const db = require('../../lib/db');
const { X6551Client } = require('../../lib/x-client-6551');
const { normalizeXHandle } = require('../../lib/x-handles');
const { resolveContractChain } = require('../../lib/contract-chain-resolver');
const { extractContent } = require('../dynamic-signal/content-extractor');
const { classifyIntent } = require('../dynamic-signal/intent-gate');
const { providerWait, resolveFollowEvent } = require('../follow-discovery/resolver');
const { addressKey, CHAIN_IDS } = require('./constants');
const { researchPostBatch } = require('./post-ca-research');

const MAX_POST_GROK_POSTS = 10;
const POST_GROK_BATCH_SIZE = 10;
const SOURCE_PAGE_SIZE = 100;
const SOURCE_SEGMENT_DAYS = 7;
const SOURCE_MIN_SEGMENT_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCE_REQUESTS = 16;
const SOURCE_REQUEST_INTERVAL_MS = 2_500;
const MAX_FOLLOW_SOURCE_EVENTS = 100;
const MAX_FOLLOW_RESEARCH_EVENTS = 20;
const FOLLOW_RESEARCH_INTERVAL_MS = 2_500;
const BLOCKED_POST_INTENTS = new Set([
  'security_incident', 'negative_or_warning', 'sell_or_exit', 'historical_review',
  'comparison_or_list', 'quoted_only', 'unknown'
]);

function explicitCaTerms(extraction = {}) {
  const values = new Map();
  for (const term of extraction.authorOwnedTerms || []) {
    if (term.type !== 'ca') continue;
    const key = `${term.addressType}:${term.normalized}`;
    if (!values.has(key)) values.set(key, term);
  }
  return [...values.values()];
}

function postSourceType(tweet = {}) {
  if (tweet.is_reply) return 'reply';
  if (tweet.is_quote) return 'quote';
  return 'tweet';
}

function normalizeTweet(tweet = {}) {
  const id = String(tweet.id || '').trim();
  const text = String(tweet.text || tweet.tweet_text || '').trim().slice(0, 8_000);
  const createdAt = tweet.created_at || tweet.createdAt || null;
  if (!id || !text || !createdAt || !Number.isFinite(new Date(createdAt).getTime())) return null;
  return {
    id, text, created_at: new Date(createdAt).toISOString(), is_reply: Boolean(tweet.is_reply),
    is_retweet: Boolean(tweet.is_retweet), is_quote: Boolean(tweet.is_quote)
  };
}

function sourceUrl(handle, tweetId) {
  return `https://x.com/${normalizeXHandle(handle)}/status/${encodeURIComponent(String(tweetId))}`;
}

function directEvidence(tweet, handle) {
  return { type: 'post_text', url: sourceUrl(handle, tweet.id), excerpt: tweet.text.slice(0, 1_600) };
}

function strongCall(tweet, intent) {
  if (BLOCKED_POST_INTENTS.has(intent.intentClass)) return false;
  return intent.canProceedToResolution || /\b(?:buy|ape|launch|contract|ca)\b|(?:买入|上车|上线|发币|合约)/iu.test(tweet.text);
}

function unresolvedEvent(tweet, handle, status, details = {}) {
  return {
    source_type: postSourceType(tweet), source_id: tweet.id, source_url: sourceUrl(handle, tweet.id),
    source_occurred_at: tweet.created_at, content_snapshot: { text: tweet.text },
    extraction_status: status, evidence_json: { ...details, post: directEvidence(tweet, handle) }
  };
}

function resolvedEvent(tweet, handle, candidate, evidence) {
  return {
    source_type: postSourceType(tweet), source_id: tweet.id, source_url: sourceUrl(handle, tweet.id),
    source_occurred_at: tweet.created_at, content_snapshot: { text: tweet.text },
    extraction_status: 'resolved', chain_id: candidate.chain_id,
    contract_address: candidate.contract_address,
    contract_address_key: addressKey(candidate.chain_id, candidate.contract_address),
    token_name: candidate.token_name || null, token_symbol: candidate.token_symbol || null,
    evidence_json: evidence
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? Math.min(maximum, parsed) : fallback;
}

function timestamp(value) {
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function utcDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function sourceCounts(tweets) {
  return tweets.reduce((counts, tweet) => {
    const type = postSourceType(tweet);
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, { tweet: 0, quote: 0, reply: 0 });
}

function splitSegment(segment) {
  if (segment.to - segment.from <= SOURCE_MIN_SEGMENT_MS) return null;
  const midpoint = segment.from + Math.floor((segment.to - segment.from) / 2);
  const date = new Date(midpoint);
  const boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return boundary > segment.from && boundary < segment.to ? boundary : null;
}

function sourceErrorMeta(error) {
  return {
    code: error?.code || 'X6551_SOURCE_FAILED',
    detail: error?.message || '6551 source request failed',
    retry_after_ms: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null
  };
}

async function loadWindowedTweets(handle, options = {}) {
  const client = options.xClient || new X6551Client(process.env.OPENNEWS_TOKEN);
  const startedAt = timestamp(options.sampleStartedAt);
  const endedAt = timestamp(options.sampleEndedAt || options.asOfAt) ?? Date.now();
  const limit = boundedInteger(options.limit, SOURCE_PAGE_SIZE, 1, SOURCE_PAGE_SIZE);
  if (!startedAt || startedAt >= endedAt || typeof client.searchTweets !== 'function') {
    const fetched = await client.getUserTweets(handle, {
      maxResults: limit, includeReplies: true, includeRetweets: false
    });
    const rows = Array.isArray(fetched) ? fetched : [];
    const tweets = rows.map(normalizeTweet).filter((tweet) => {
      if (!tweet || tweet.is_retweet) return false;
      const created = timestamp(tweet.created_at);
      return created && (!startedAt || created >= startedAt) && created <= endedAt;
    });
    const times = tweets.map((tweet) => timestamp(tweet.created_at)).filter(Number.isFinite);
    return {
      tweets,
      meta: {
        source_request_count: 1,
        source_primary_request_count: 0,
        source_successful_request_count: 1,
        source_coverage_complete: false,
        source_saturated_segment_count: rows.length >= limit ? 1 : 0,
        source_unprocessed_segment_count: 0,
        source_window_started_at: startedAt ? new Date(startedAt).toISOString() : null,
        source_window_ended_at: new Date(endedAt).toISOString(),
        source_earliest_at: times.length ? new Date(Math.min(...times)).toISOString() : null,
        source_latest_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
        source_type_counts: sourceCounts(tweets),
        source_coverage_reason: startedAt ? 'X_SEARCH_WINDOW_UNAVAILABLE' : 'X_WINDOW_UNBOUNDED_RECENT_ONLY',
        source_error_code: null,
        source_error_detail: null,
        source_retry_after_ms: null,
        reply_sample_request_count: 1,
        reply_sample_count: sourceCounts(tweets).reply,
        reply_sample_complete: rows.length < limit,
        reply_sample_error_code: null,
        reply_sample_error_detail: null
      }
    };
  }

  const segmentMs = boundedInteger(
    options.sourceSegmentDays ?? process.env.KOL_PERFORMANCE_X_SEGMENT_DAYS,
    SOURCE_SEGMENT_DAYS, 1, 30
  ) * SOURCE_MIN_SEGMENT_MS;
  const maxRequests = boundedInteger(
    options.maxSourceRequests ?? process.env.KOL_PERFORMANCE_X_MAX_REQUESTS,
    MAX_SOURCE_REQUESTS, 1, 100
  );
  const sleep = options.sourceSleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const requestIntervalMs = boundedInteger(
    options.sourceRequestIntervalMs ?? process.env.KOL_PERFORMANCE_X_REQUEST_INTERVAL_MS,
    SOURCE_REQUEST_INTERVAL_MS, 0, 30_000
  );
  const queue = [];
  for (let cursor = startedAt; cursor < endedAt; cursor += segmentMs) {
    queue.push({ from: cursor, to: Math.min(endedAt, cursor + segmentMs) });
  }
  const collected = new Map();
  let requestCount = 0;
  let primaryRequestCount = 0;
  let successfulPrimaryRequests = 0;
  let saturatedSegments = 0;
  let coverageComplete = true;
  let sourceError = null;
  while (queue.length > 0 && requestCount < maxRequests) {
    const segment = queue.shift();
    requestCount += 1;
    primaryRequestCount += 1;
    let fetched;
    try {
      fetched = await client.searchTweets({
        fromUser: handle,
        maxResults: limit,
        product: 'Latest',
        excludeReplies: true,
        excludeRetweets: true,
        sinceDate: utcDate(segment.from),
        untilDate: utcDate(segment.to)
      }, { maxAttempts: 1 });
      successfulPrimaryRequests += 1;
    } catch (error) {
      sourceError = sourceErrorMeta(error);
      coverageComplete = false;
      break;
    }
    const rows = (Array.isArray(fetched) ? fetched : []).map(normalizeTweet).filter(Boolean);
    for (const tweet of rows) {
      const created = timestamp(tweet.created_at);
      if (!created || created < segment.from || created >= segment.to
        || tweet.is_retweet || tweet.is_reply) continue;
      collected.set(tweet.id, tweet);
    }
    const midpoint = rows.length >= limit ? splitSegment(segment) : null;
    if (midpoint) {
      queue.unshift({ from: midpoint, to: segment.to });
      queue.unshift({ from: segment.from, to: midpoint });
    } else if (rows.length >= limit) {
      saturatedSegments += 1;
      coverageComplete = false;
    }
    if (requestIntervalMs > 0 && queue.length > 0) await sleep(requestIntervalMs);
  }
  if (queue.length > 0) coverageComplete = false;

  let replySampleRequestCount = 0;
  let replySampleCount = 0;
  let replySampleComplete = false;
  let replySampleError = null;
  if (!sourceError && typeof client.getUserTweets === 'function' && requestCount < maxRequests) {
    if (requestIntervalMs > 0 && primaryRequestCount > 0) await sleep(requestIntervalMs);
    requestCount += 1;
    replySampleRequestCount = 1;
    try {
      const fetched = await client.getUserTweets(handle, {
        maxResults: limit, includeReplies: true, includeRetweets: false
      }, { maxAttempts: 1 });
      const rows = Array.isArray(fetched) ? fetched : [];
      replySampleComplete = rows.length < limit;
      for (const tweet of rows.map(normalizeTweet).filter(Boolean)) {
        const created = timestamp(tweet.created_at);
        if (!created || created < startedAt || created > endedAt
          || tweet.is_retweet || !tweet.is_reply) continue;
        collected.set(tweet.id, tweet);
        replySampleCount += 1;
      }
    } catch (error) {
      replySampleError = sourceErrorMeta(error);
    }
  }
  const tweets = [...collected.values()].sort(
    (left, right) => timestamp(left.created_at) - timestamp(right.created_at)
  );
  const times = tweets.map((tweet) => timestamp(tweet.created_at)).filter(Number.isFinite);
  return {
    tweets,
    meta: {
      source_request_count: requestCount,
      source_primary_request_count: primaryRequestCount,
      source_successful_request_count: successfulPrimaryRequests,
      source_coverage_complete: coverageComplete,
      source_saturated_segment_count: saturatedSegments,
      source_unprocessed_segment_count: queue.length,
      source_window_started_at: new Date(startedAt).toISOString(),
      source_window_ended_at: new Date(endedAt).toISOString(),
      source_earliest_at: times.length ? new Date(Math.min(...times)).toISOString() : null,
      source_latest_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
      source_type_counts: sourceCounts(tweets),
      source_coverage_reason: sourceError?.code || (coverageComplete ? null : 'X_WINDOW_PARTIAL'),
      source_error_code: sourceError?.code || null,
      source_error_detail: sourceError?.detail || null,
      source_retry_after_ms: sourceError?.retry_after_ms || null,
      reply_sample_request_count: replySampleRequestCount,
      reply_sample_count: replySampleCount,
      reply_sample_complete: replySampleComplete,
      reply_sample_error_code: replySampleError?.code || null,
      reply_sample_error_detail: replySampleError?.detail || null
    }
  };
}

function grokCandidateScore(tweet, extraction, intent) {
  let score = 0;
  score += Math.min(20, (extraction.assetTerms || []).length * 5);
  if (intent.canProceedToResolution) score += 12;
  if (strongCall(tweet, intent)) score += 10;
  if (/\b(?:token|coin|ticker|launch|mint|meme|airdrop|contract|ca|bnb|solana|base|ethereum)\b|(?:代币|发币|上线|开盘|喊单|买入|上车|合约|市值|币安|新币|项目|土狗|打新)/iu.test(tweet.text)) score += 8;
  if (score === 0) return 0;
  return score + (tweet.is_reply ? 0 : tweet.is_quote ? 6 : 8);
}

function selectGrokPosts(prepared, requestedLimit) {
  const limit = boundedInteger(requestedLimit, MAX_POST_GROK_POSTS, 1, 60);
  const ranked = prepared.map((item) => ({
    ...item,
    score: grokCandidateScore(item.tweet, item.extraction, item.intent)
  })).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score
      || timestamp(right.tweet.created_at) - timestamp(left.tweet.created_at));
  const replyQuota = Math.min(10, Math.ceil(limit / 3));
  const selected = [
    ...ranked.filter((item) => !item.tweet.is_reply).slice(0, limit - replyQuota),
    ...ranked.filter((item) => item.tweet.is_reply).slice(0, replyQuota)
  ];
  return selected.slice(0, limit);
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

async function loadPostEvents(handle, options = {}) {
  const loaded = await loadWindowedTweets(handle, options);
  const events = [];
  const prepared = [];
  let directCaCount = 0;
  for (const tweet of loaded.tweets) {
    const extraction = extractContent({ text: tweet.text, eventType: postSourceType(tweet) });
    const intent = classifyIntent(extraction);
    const directTerms = explicitCaTerms(extraction);
    let resolved = 0;
    let chainResolutionError = null;
    if (!BLOCKED_POST_INTENTS.has(intent.intentClass) && directTerms.length > 0) {
      for (const term of directTerms) {
        try {
          const resolution = await (options.resolveContractChain || resolveContractChain)(
            term.normalized, options.allowedChains || CHAIN_IDS, options.chainResolutionOptions || {}
          );
          if (resolution?.status === 'resolved') {
            events.push(resolvedEvent(tweet, handle, {
              chain_id: resolution.chainId, contract_address: resolution.contractAddress
            }, { ...directEvidence(tweet, handle), chain_resolution: resolution.source || 'local_rpc' }));
            resolved += 1;
            directCaCount += 1;
          }
        } catch (error) {
          chainResolutionError = error;
        }
      }
    }
    if (resolved === 0) prepared.push({ tweet, extraction, intent, directTerms, chainResolutionError });
  }

  const selected = selectGrokPosts(
    prepared,
    options.maxGrokPosts ?? process.env.KOL_PERFORMANCE_GROK_MAX_POSTS
  );
  const selectedIds = new Set(selected.map((item) => item.tweet.id));
  const batchSize = boundedInteger(options.grokBatchSize, POST_GROK_BATCH_SIZE, 1, 10);
  let grokBatchCount = 0;
  let grokPostCount = 0;
  let grokRequestCount = 0;
  let grokSearchToolCalls = 0;
  let providerFailedCount = 0;
  for (const batch of chunks(selected, batchSize)) {
    grokBatchCount += 1;
    grokPostCount += batch.length;
    const posts = batch.map(({ tweet }) => ({
      source_id: tweet.id,
      source_url: sourceUrl(handle, tweet.id),
      created_at: tweet.created_at,
      source_type: postSourceType(tweet),
      text: tweet.text
    }));
    try {
      let result;
      if (options.researchPostBatch) {
        result = await options.researchPostBatch({ handle, posts });
      } else if (options.researchPostCa) {
        const items = [];
        for (const post of posts) {
          const single = await options.researchPostCa({
            handle, text: post.text, source_url: post.source_url, created_at: post.created_at
          });
          items.push({ source_id: post.source_id, status: single.status, candidates: single.candidates || [] });
        }
        result = {
          items,
          citations: [],
          prompt_version: 'single-post-test-adapter',
          search_tool_calls: posts.length
        };
      } else {
        result = await researchPostBatch({ handle, posts });
      }
      grokRequestCount += Number(result.provider_request_count || 0);
      grokSearchToolCalls += Number(result.search_tool_calls || 0);
      const byId = new Map((result.items || []).map((item) => [String(item.source_id), item]));
      for (const item of batch) {
        const researched = byId.get(item.tweet.id);
        if (researched?.status === 'resolved' && researched.candidates?.length > 0) {
          for (const candidate of researched.candidates) {
            events.push(resolvedEvent(item.tweet, handle, candidate, {
              type: 'grok_post_search', url: candidate.evidence_url, excerpt: candidate.evidence_excerpt,
              citations: result.citations || [], prompt_version: result.prompt_version,
              search_tool_calls: result.search_tool_calls
            }));
          }
        } else {
          events.push(unresolvedEvent(item.tweet, handle, 'no_match', {
            code: item.chainResolutionError ? 'POST_CA_CHAIN_RESOLUTION_FAILED' : 'POST_CA_NO_MATCH',
            chain_resolution_error: item.chainResolutionError
              ? (item.chainResolutionError.code || item.chainResolutionError.message || 'CHAIN_RESOLUTION_FAILED') : null,
            prompt_version: result.prompt_version,
            citations: result.citations || []
          }));
        }
      }
    } catch (error) {
      providerFailedCount += batch.length;
      for (const { tweet } of batch) {
        events.push(unresolvedEvent(tweet, handle, 'provider_failed', {
          code: error.code || 'POST_CA_RESEARCH_FAILED', message: error.message
        }));
      }
    }
  }

  for (const item of prepared) {
    if (selectedIds.has(item.tweet.id)) continue;
    events.push(unresolvedEvent(item.tweet, handle, 'no_match', {
      code: item.directTerms.length > 0
        ? (item.chainResolutionError ? 'POST_CA_CHAIN_RESOLUTION_FAILED' : 'POST_CA_CHAIN_UNRESOLVED')
        : 'POST_CA_NOT_SELECTED',
      chain_resolution_error: item.chainResolutionError
        ? (item.chainResolutionError.code || item.chainResolutionError.message || 'CHAIN_RESOLUTION_FAILED') : null
    }));
  }

  return {
    events,
    source_event_count: loaded.tweets.length,
    grok_lookup_count: grokBatchCount,
    grok_batch_count: grokBatchCount,
    grok_post_count: grokPostCount,
    grok_request_count: grokRequestCount,
    grok_search_tool_calls: grokSearchToolCalls,
    direct_ca_count: directCaCount,
    provider_failed_count: providerFailedCount,
    candidate_post_count: selected.length,
    ...loaded.meta
  };
}

function followSource(row) {
  const targetHandle = normalizeXHandle(row.target_handle);
  return {
    source_type: 'follow',
    source_id: String(row.activity_id),
    source_url: targetHandle ? `https://x.com/${targetHandle}` : null,
    target_handle: targetHandle,
    source_occurred_at: row.provider_created_at,
    content_snapshot: {
      provider: row.provider || null,
      strategy_event_id: row.strategy_event_id ? String(row.strategy_event_id) : null,
      strategy_event_status: row.strategy_status || null
    },
    evidence_json: {
      follow_activity_id: String(row.activity_id),
      strategy_event_id: row.strategy_event_id ? String(row.strategy_event_id) : null
    }
  };
}

function cachedFollowResult(row) {
  const source = followSource(row);
  const contractAddress = String(row.contract_address || '').trim();
  if (row.strategy_status !== 'resolved' || !row.chain_id || !contractAddress) return null;
  const normalizedAddress = row.chain_id === 'sol' ? contractAddress : contractAddress.toLowerCase();
  return {
    ...source,
    extraction_status: 'resolved',
    chain_id: row.chain_id,
    contract_address: normalizedAddress,
    contract_address_key: addressKey(row.chain_id, normalizedAddress),
    token_name: row.token_name || null,
    token_symbol: row.token_symbol || null,
    evidence_json: {
      ...source.evidence_json,
      resolution_source: 'follow_discovery_event',
      follow_evidence: row.evidence || [],
      profile_snapshot: row.profile_snapshot || {}
    }
  };
}

function researchedFollowResult(row, resolution) {
  const source = followSource(row);
  const chainId = String(resolution?.selected?.chainId || '').trim().toLowerCase();
  const rawAddress = String(resolution?.selected?.contractAddress || '').trim();
  if (!CHAIN_IDS.includes(chainId) || !rawAddress) return null;
  const contractAddress = chainId === 'sol' ? rawAddress : rawAddress.toLowerCase();
  return {
    ...source,
    extraction_status: 'resolved',
    chain_id: chainId,
    contract_address: contractAddress,
    contract_address_key: addressKey(chainId, contractAddress),
    token_name: resolution?.profile?.project_name || null,
    token_symbol: null,
    evidence_json: {
      ...source.evidence_json,
      resolution_source: 'grok_follow_research',
      selected: resolution.selected,
      evidence: resolution.evidence || [],
      research: resolution.research || null
    }
  };
}

function unresolvedFollowResult(row, error, status = 'no_match') {
  const source = followSource(row);
  return {
    ...source,
    extraction_status: status,
    evidence_json: {
      ...source.evidence_json,
      code: error?.code || 'FOLLOW_CA_NOT_RESOLVED',
      detail: error?.message || 'No verified contract address was found for this followed account'
    }
  };
}

async function loadFollowEvents(handle, options = {}) {
  const executor = options.executor || db;
  const sourceLimit = boundedInteger(
    options.maxFollowSourceEvents ?? process.env.KOL_PERFORMANCE_FOLLOW_MAX_SOURCE_EVENTS,
    MAX_FOLLOW_SOURCE_EVENTS, 1, MAX_FOLLOW_SOURCE_EVENTS
  );
  const researchLimit = boundedInteger(
    options.maxFollowResearchEvents ?? process.env.KOL_PERFORMANCE_FOLLOW_MAX_RESEARCH_EVENTS,
    MAX_FOLLOW_RESEARCH_EVENTS, 1, MAX_FOLLOW_SOURCE_EVENTS
  );
  const researchIntervalMs = boundedInteger(
    options.followResearchIntervalMs ?? process.env.KOL_PERFORMANCE_FOLLOW_XAI_INTERVAL_MS,
    FOLLOW_RESEARCH_INTERVAL_MS, 0, 60_000
  );
  const onProgress = options.onProgress || (async () => {});
  const sleep = options.followResearchSleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const resolveFollow = options.resolveFollowEvent || resolveFollowEvent;
  const result = await executor.query(
    `SELECT activity.id AS activity_id,
            COALESCE(activity.target_x_handle, activity.target_x_handles[1]) AS target_handle,
            COALESCE(activity.source_created_at, activity.created_at) AS provider_created_at,
            activity.provider,
            event.id AS strategy_event_id, event.target_user_id, event.status AS strategy_status,
            event.chain_id, event.contract_address, event.failure_code, event.evidence,
            event.profile_snapshot,
            COALESCE(variant.name, metadata.name) AS token_name,
            COALESCE(variant.symbol, metadata.symbol) AS token_symbol
     FROM x_activities AS activity
     LEFT JOIN LATERAL (
       SELECT candidate.* FROM follow_discovery_events AS candidate
       WHERE candidate.x_activity_id = activity.id
       ORDER BY (candidate.status = 'resolved') DESC, candidate.updated_at DESC, candidate.id DESC
       LIMIT 1
     ) AS event ON true
     LEFT JOIN dynamic_asset_variants AS variant ON variant.id = event.variant_id
     LEFT JOIN asset_metadata AS metadata ON metadata.chain_id = event.chain_id
       AND metadata.contract_address_key = CASE WHEN event.chain_id = 'sol'
         THEN event.contract_address ELSE lower(event.contract_address) END
       AND metadata.status = 'completed'
     WHERE LOWER(REGEXP_REPLACE(activity.kol_handle, '^@+', '')) = $1
       AND activity.activity_type = 'follow'
       AND COALESCE(activity.target_x_handle, activity.target_x_handles[1]) IS NOT NULL
       AND ($2::timestamptz IS NULL OR COALESCE(activity.source_created_at, activity.created_at) >= $2)
       AND ($3::timestamptz IS NULL OR COALESCE(activity.source_created_at, activity.created_at) <= $3)
     ORDER BY COALESCE(activity.source_created_at, activity.created_at) DESC, activity.id DESC
     LIMIT $4`,
    [normalizeXHandle(handle), options.sampleStartedAt || null,
      options.sampleEndedAt || options.asOfAt || null, sourceLimit]
  );
  const rows = [...result.rows].reverse();
  const events = [];
  let grokLookupCount = 0;
  let providerFailedCount = 0;
  let directCaCount = 0;
  let sourceComplete = result.rows.length < sourceLimit;
  let sourceError = null;
  let stopped = false;
  const progress = (details = {}) => ({
    stage: 'follow_research', source_event_count: rows.length,
    total_follow_events: rows.length, processed_follow_events: 0,
    resolved_follow_events: events.filter((event) => event.extraction_status === 'resolved').length,
    failed_follow_events: events.filter((event) => event.extraction_status === 'provider_failed').length,
    current_follow_index: null, current_target_handle: null,
    ...details
  });
  await onProgress(progress());

  for (const [index, row] of rows.entries()) {
    const cached = cachedFollowResult(row);
    if (cached) {
      events.push(cached);
      directCaCount += 1;
    } else if (stopped) {
      events.push(unresolvedFollowResult(row, {
        code: 'FOLLOW_RESEARCH_SKIPPED_AFTER_PROVIDER_ERROR',
        message: 'Research stopped after the external provider became unavailable'
      }, 'provider_failed'));
    } else if (grokLookupCount >= researchLimit) {
      sourceComplete = false;
      events.push(unresolvedFollowResult(row, {
        code: 'FOLLOW_RESEARCH_LIMIT_REACHED',
        message: `The batch research limit of ${researchLimit} followed accounts was reached`
      }));
    } else {
      grokLookupCount += 1;
      await onProgress(progress({
        processed_follow_events: index,
        current_follow_index: index + 1,
        current_target_handle: normalizeXHandle(row.target_handle),
        current_started_at: new Date().toISOString()
      }));
      try {
        const resolution = await resolveFollow({
          target_handle: normalizeXHandle(row.target_handle),
          target_user_id: row.target_user_id || normalizeXHandle(row.target_handle),
          provider_created_at: row.provider_created_at,
          allowed_chain_ids: options.allowedChains || CHAIN_IDS
        }, options.followResolutionOptions || {});
        const researched = researchedFollowResult(row, resolution);
        events.push(researched || unresolvedFollowResult(row, {
          code: 'FOLLOW_RESEARCH_RESULT_INVALID', message: 'Research returned no verified chain and contract pair'
        }));
      } catch (error) {
        const providerFailed = providerWait(error);
        if (providerFailed) {
          providerFailedCount += 1;
          sourceComplete = false;
          sourceError = sourceError || error;
          stopped = true;
        }
        events.push(unresolvedFollowResult(row, error,
          providerFailed ? 'provider_failed' : String(error?.code || '').includes('AMBIGUOUS') ? 'ambiguous' : 'no_match'));
      }
      if (!stopped && researchIntervalMs > 0 && index < rows.length - 1) await sleep(researchIntervalMs);
    }
    await onProgress(progress({
      processed_follow_events: index + 1,
      current_follow_index: null, current_target_handle: null, current_started_at: null
    }));
  }

  const unprocessedCount = events.filter((event) => (
    event.evidence_json?.code === 'FOLLOW_RESEARCH_LIMIT_REACHED'
    || event.evidence_json?.code === 'FOLLOW_RESEARCH_SKIPPED_AFTER_PROVIDER_ERROR'
  )).length;
  return {
    events,
    source_event_count: rows.length,
    grok_lookup_count: grokLookupCount,
    grok_batch_count: grokLookupCount,
    grok_post_count: 0,
    grok_request_count: grokLookupCount,
    direct_ca_count: directCaCount,
    provider_failed_count: providerFailedCount,
    source_request_count: 0,
    source_primary_request_count: 0,
    source_successful_request_count: 0,
    source_coverage_complete: sourceComplete && !stopped,
    source_unprocessed_segment_count: unprocessedCount,
    source_window_started_at: options.sampleStartedAt || null,
    source_window_ended_at: options.sampleEndedAt || options.asOfAt || null,
    source_earliest_at: rows[0]?.provider_created_at || null,
    source_latest_at: rows.at(-1)?.provider_created_at || null,
    source_error_code: sourceError?.code || (unprocessedCount ? 'FOLLOW_RESEARCH_PARTIAL' : null),
    source_error_detail: sourceError?.message || (unprocessedCount
      ? `${unprocessedCount} followed accounts were not researched in this batch` : null),
    source_type_counts: { follow: rows.length }
  };
}

module.exports = {
  MAX_POST_GROK_POSTS,
  MAX_FOLLOW_RESEARCH_EVENTS,
  MAX_FOLLOW_SOURCE_EVENTS,
  MAX_SOURCE_REQUESTS,
  POST_GROK_BATCH_SIZE,
  SOURCE_SEGMENT_DAYS,
  grokCandidateScore,
  loadFollowEvents,
  loadPostEvents,
  loadWindowedTweets,
  normalizeTweet,
  postSourceType,
  selectGrokPosts,
  sourceUrl,
  strongCall
};
