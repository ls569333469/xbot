const db = require('../../lib/db');
const { fetchKline } = require('../dynamic-signal/gmgn-market-source');
const { extractContent } = require('../dynamic-signal/content-extractor');
const { classifyIntent } = require('../dynamic-signal/intent-gate');
const { resolveContractChain } = require('../../lib/contract-chain-resolver');
const { analyzeActor } = require('./grok-analysis');

const SCREENING_CHAINS = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
const DEFAULT_MAX_RETURN_SAMPLES = 12;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const MIN_RETURN_SAMPLES = 3;
const RETRYABLE_RESEARCH_ERRORS = new Set([
  'RATE_LIMIT_EXCEEDED',
  'GMGN_RATE_LIMIT_COOLDOWN',
  'GMGN_RATE_DEADLINE_EXPIRED',
  'GMGN_REQUEST_TIMEOUT',
  'GMGN_NETWORK_ERROR'
]);
const BLOCKED_BACKTEST_INTENTS = new Set([
  'security_incident', 'negative_or_warning', 'sell_or_exit', 'historical_review',
  'comparison_or_list', 'quoted_only', 'unknown'
]);

function percentile(values, ratio) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function fetchHistoricalCandidates(chain, options = {}) {
  const source = options.gmgnSource;
  if (source?.fetchRank) return (await source.fetchRank({ chain, limit: 100 })).candidates;
  return [];
}

async function resolveHistorical(extraction, tweetTime, executor = db) {
  const terms = extraction.authorOwnedTerms.filter((term) => (
    ['ca', 'cashtag', 'hashtag', 'approved_name'].includes(term.type)
  ));
  if (!terms.length || !tweetTime) return { candidates: [], covered: false };
  const clauses = [];
  const params = [tweetTime];
  for (const term of terms) {
    params.push(term.normalized);
    if (term.type === 'ca') {
      clauses.push(`(idx.key_type = 'chain_ca' AND split_part(idx.normalized_key, ':', 2) = $${params.length})`);
    } else if (['cashtag', 'hashtag'].includes(term.type)) {
      clauses.push(`(idx.key_type = 'symbol' AND idx.normalized_key = $${params.length})`);
    } else {
      clauses.push(`(idx.key_type = 'name' AND idx.normalized_key = $${params.length})`);
    }
  }
  const result = await executor.query(
    `SELECT DISTINCT variant.id, variant.chain_id, variant.contract_address, variant.symbol,
            variant.name, idx.fetched_at
     FROM dynamic_candidate_index idx
     JOIN dynamic_asset_variants variant ON variant.id = idx.variant_id
     WHERE idx.fetched_at <= $1 AND (${clauses.join(' OR ')})
     ORDER BY idx.fetched_at DESC`, params
  );
  return { candidates: result.rows, covered: result.rows.length > 0 };
}

function explicitCaTerms(extraction = {}) {
  const values = new Map();
  for (const term of extraction.authorOwnedTerms || []) {
    if (term.type !== 'ca') continue;
    const key = `${term.addressType}:${term.normalized}`;
    if (!values.has(key)) values.set(key, term);
  }
  return [...values.values()];
}

function isBacktestEligible(extraction, intent) {
  const caTerms = explicitCaTerms(extraction);
  if (caTerms.length === 1) return !BLOCKED_BACKTEST_INTENTS.has(intent.intentClass);
  return Boolean(intent.canProceedToResolution);
}

async function resolveExplicitCa(extraction, options = {}) {
  const terms = explicitCaTerms(extraction);
  if (terms.length !== 1) {
    return { candidates: [], covered: false, ambiguous: terms.length > 1, chainResolution: null };
  }
  const term = terms[0];
  const cache = options.chainCache || new Map();
  if (!cache.has(term.normalized)) {
    const resolver = options.resolveContractChain || resolveContractChain;
    cache.set(term.normalized, await resolver(
      term.normalized,
      options.allowedChains || SCREENING_CHAINS,
      options.chainResolutionOptions || {}
    ));
  }
  const chainResolution = cache.get(term.normalized);
  if (chainResolution?.status !== 'resolved') {
    return { candidates: [], covered: false, ambiguous: false, chainResolution };
  }
  return {
    candidates: [{
      id: `tweet:${chainResolution.chainId}:${chainResolution.contractAddress}`,
      chain_id: chainResolution.chainId,
      contract_address: chainResolution.contractAddress,
      symbol: '',
      name: '',
      source: chainResolution.source || 'tweet_ca'
    }],
    covered: true,
    ambiguous: false,
    chainResolution
  };
}

function boundedReturnSampleLimit(value) {
  const parsed = Number(value ?? DEFAULT_MAX_RETURN_SAMPLES);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(30, parsed) : DEFAULT_MAX_RETURN_SAMPLES;
}

function selectedGrokSamples(prepared) {
  const ranked = [...prepared].sort((left, right) => {
    const caDifference = explicitCaTerms(right.extraction).length - explicitCaTerms(left.extraction).length;
    if (caDifference !== 0) return caDifference;
    const termDifference = right.extraction.assetTerms.length - left.extraction.assetTerms.length;
    if (termDifference !== 0) return termDifference;
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
  return ranked.filter((item) => item.extraction.assetTerms.length > 0).slice(0, 40)
    .map((item) => ({
      id: item.id,
      created_at: item.createdAt,
      intent: item.intent.intentClass,
      text: item.text
    }));
}

function recommendationFor(summary) {
  if (summary.resolved === 0 || summary.returns.length < 3) return 'insufficient_data';
  if (summary.resolutionRate >= 0.3 && summary.returns.length >= 5) return 'approve_for_record';
  return 'watch';
}

function errorCode(error, fallback) {
  return String(error?.code || fallback);
}

function isRetryableResearchError(error) {
  const code = errorCode(error, '').toUpperCase();
  return error?.status === 429 || RETRYABLE_RESEARCH_ERRORS.has(code) || code.includes('RATE_LIMIT');
}

function retryAtForErrors(errors, now = Date.now(), fallbackMs = DEFAULT_RETRY_DELAY_MS) {
  const candidates = errors.filter(isRetryableResearchError).map((error) => {
    const resetAt = Number(error?.resetAt);
    if (Number.isFinite(resetAt) && resetAt > now) return resetAt;
    const retryAfterSeconds = Number(error?.retryAfterSeconds);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return now + retryAfterSeconds * 1000;
    }
    return now + fallbackMs;
  });
  return candidates.length ? new Date(Math.max(...candidates)).toISOString() : null;
}

async function runActor(handle, options = {}) {
  const client = options.xClient;
  if (!client || typeof client.getUserTweets !== 'function') {
    const error = new Error('6551 client is required for actor screening');
    error.code = 'ACTOR_SCREENING_PROVIDER_UNAVAILABLE';
    throw error;
  }
  const tweets = await client.getUserTweets(handle, {
    maxResults: Math.min(100, Number(options.limit || 100)), includeReplies: false, includeRetweets: false
  });
  const sampleStartedAt = options.sampleStartedAt ? new Date(options.sampleStartedAt).getTime() : null;
  const sampleEndedAt = options.sampleEndedAt ? new Date(options.sampleEndedAt).getTime() : null;
  const prepared = (tweets || []).map((tweet) => {
    const text = tweet.text || tweet.tweet_text || '';
    const createdAt = tweet.created_at || tweet.createdAt || null;
    const extraction = extractContent({ text, eventType: 'tweet' });
    return {
      id: String(tweet.id || ''), text, createdAt, extraction,
      intent: classifyIntent(extraction)
    };
  }).filter((tweet) => {
    const timestamp = new Date(tweet.createdAt).getTime();
    if (!Number.isFinite(timestamp)) return false;
    if (Number.isFinite(sampleStartedAt) && timestamp < sampleStartedAt) return false;
    if (Number.isFinite(sampleEndedAt) && timestamp > sampleEndedAt) return false;
    return true;
  });
  const analyzer = options.analyzeActor || analyzeActor;
  const previousMetrics = options.previousMetrics && typeof options.previousMetrics === 'object'
    ? options.previousMetrics : {};
  const previousGrok = previousMetrics.grok && typeof previousMetrics.grok === 'object'
    ? previousMetrics.grok : null;
  const grokOutcomePromise = previousGrok
    ? Promise.resolve({ value: previousGrok, error: null })
    : Promise.resolve()
      .then(() => analyzer({ handle, samples: selectedGrokSamples(prepared) }))
      .then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error })
      );
  const returns = [];
  const chainCache = new Map();
  const klineErrors = {};
  const klineErrorDetails = [];
  const chainResolutionCounts = {};
  const returnSampleLimit = boundedReturnSampleLimit(options.maxReturnSamples);
  const previousAttemptCount = Math.max(0, Number(previousMetrics.attempt_count || 0));
  const attemptCount = previousAttemptCount + 1;
  const configuredMaxAttempts = Number(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const maxAttempts = Number.isInteger(configuredMaxAttempts) && configuredMaxAttempts > 0
    ? Math.min(10, configuredMaxAttempts) : DEFAULT_MAX_ATTEMPTS;
  let direct = 0; let resolved = 0; let ambiguous = 0; let coverage = 0;
  let explicitCaPosts = 0; let eligiblePosts = 0; let klineAttempts = 0; let klineSkipped = 0;
  for (const tweet of prepared) {
    const { extraction, intent } = tweet;
    if (['buy_direct', 'launch_direct', 'full_ca_solo'].includes(intent.intentClass)) direct += 1;
    if (explicitCaTerms(extraction).length > 0) explicitCaPosts += 1;
    const eligible = isBacktestEligible(extraction, intent);
    if (eligible) eligiblePosts += 1;
    let historical = { candidates: [], covered: false, ambiguous: false, chainResolution: null };
    if (eligible && explicitCaTerms(extraction).length > 0) {
      historical = await resolveExplicitCa(extraction, {
        chainCache,
        allowedChains: options.allowedChains,
        resolveContractChain: options.resolveContractChain,
        chainResolutionOptions: options.chainResolutionOptions
      });
      const chainStatus = historical.chainResolution?.status;
      if (chainStatus) chainResolutionCounts[chainStatus] = (chainResolutionCounts[chainStatus] || 0) + 1;
    } else if (eligible) {
      historical = await resolveHistorical(extraction, tweet.createdAt, options.executor || db);
    }
    if (historical.covered) coverage += 1;
    if (historical.candidates.length === 1) {
      resolved += 1;
      const candidate = historical.candidates[0];
      const from = Math.floor(new Date(tweet.createdAt).getTime() / 1000);
      if (klineAttempts >= returnSampleLimit) {
        klineSkipped += 1;
        continue;
      }
      klineAttempts += 1;
      try {
        const kline = await (options.fetchKline || fetchKline)({
          chain: candidate.chain_id, address: candidate.contract_address,
          resolution: '5m', from, to: from + 24 * 60 * 60
        });
        const entry = kline.rows[0]?.open;
        const highest = Math.max(...kline.rows.map((row) => row.high).filter(Number.isFinite));
        const close = kline.rows.at(-1)?.close;
        if (Number.isFinite(entry) && entry > 0 && Number.isFinite(close)) {
          returns.push({
            tweet_id: tweet.id, chain: candidate.chain_id, contract_address: candidate.contract_address,
            return_24h_pct: (close / entry - 1) * 100,
            max_gain_24h_pct: Number.isFinite(highest) ? (highest / entry - 1) * 100 : null
          });
        }
      } catch (error) {
        const code = errorCode(error, 'GMGN_KLINE_FAILED');
        klineErrors[code] = (klineErrors[code] || 0) + 1;
        klineErrorDetails.push(error);
      }
    }
    if (historical.ambiguous || historical.candidates.length > 1) ambiguous += 1;
  }
  const grokOutcome = await grokOutcomePromise;
  const grok = grokOutcome.value;
  const grokError = grokOutcome.error;
  const total = Math.max(1, prepared.length);
  const wins = returns.filter((item) => item.return_24h_pct > 0).length;
  const reasonCodes = [];
  if (explicitCaPosts === 0) reasonCodes.push('ACTOR_EXPLICIT_CA_SAMPLE_EMPTY');
  if (resolved === 0) reasonCodes.push('ACTOR_CA_RESOLUTION_EMPTY');
  if (returns.length === 0) reasonCodes.push('ACTOR_KLINE_SAMPLE_EMPTY');
  if (klineSkipped > 0) reasonCodes.push('ACTOR_KLINE_SAMPLE_LIMIT_REACHED');
  if (grokError) reasonCodes.push(errorCode(grokError, 'XAI_ACTOR_RESEARCH_FAILED'));
  const resolutionRate = resolved / total;
  const retryAt = retryAtForErrors(
    klineErrorDetails,
    Number(options.now?.() ?? Date.now()),
    Number(options.retryDelayMs || DEFAULT_RETRY_DELAY_MS)
  );
  const shouldDefer = Boolean(retryAt) && returns.length < MIN_RETURN_SAMPLES
    && attemptCount < maxAttempts;
  const retriesExhausted = Boolean(retryAt) && returns.length < MIN_RETURN_SAMPLES
    && attemptCount >= maxAttempts;
  if (shouldDefer) reasonCodes.push('ACTOR_GMGN_CAPACITY_WAIT');
  if (retriesExhausted) reasonCodes.push('ACTOR_GMGN_RETRY_EXHAUSTED');
  const partial = !shouldDefer && (Boolean(grokError) || (resolved > 0 && returns.length < MIN_RETURN_SAMPLES
    && Object.keys(klineErrors).length > 0));
  const primaryError = grokError || ((partial || shouldDefer)
    ? Object.assign(new Error('GMGN did not return a usable K-line sample'), {
      code: Object.keys(klineErrors)[0] || 'GMGN_KLINE_FAILED'
    }) : null);
  return {
    x_handle: handle, status: shouldDefer ? 'pending' : partial ? 'partial' : 'completed',
    sample_size: prepared.length,
    direct_intent_rate: direct / total, ca_resolution_rate: resolutionRate,
    ambiguity_rate: ambiguous / total, historical_candidate_coverage_rate: coverage / total,
    provider_coverage_rate: coverage / total,
    false_positive_rate: null, executable_win_rate: returns.length ? wins / returns.length : null,
    return_snapshot: {
      kline_source: 'gmgn_token_kline', samples: returns,
      median_return_24h_pct: percentile(returns.map((item) => item.return_24h_pct), 0.5),
      median_max_gain_24h_pct: percentile(returns.map((item) => item.max_gain_24h_pct), 0.5)
    },
    metrics: {
      direct, resolved, ambiguous, coverage, tweets: prepared.length,
      asset_posts: prepared.filter((item) => item.extraction.assetTerms.length > 0).length,
      eligible_posts: eligiblePosts,
      explicit_ca_posts: explicitCaPosts,
      return_samples: returns.length,
      return_sample_limit: returnSampleLimit,
      kline_attempts: klineAttempts,
      kline_skipped: klineSkipped,
      kline_errors: klineErrors,
      chain_resolution: chainResolutionCounts,
      grok,
      grok_reused: Boolean(previousGrok),
      attempt_count: attemptCount,
      max_attempts: maxAttempts,
      retry_at: shouldDefer ? retryAt : null
    },
    recommendation: recommendationFor({ resolved, returns, resolutionRate }),
    reason_codes: [...new Set(reasonCodes)],
    error_code: primaryError ? errorCode(primaryError, 'ACTOR_SCREENING_PARTIAL') : null,
    last_error: primaryError?.message || null
  };
}

async function persistResult(runId, summary, executor = db) {
  const result = await executor.query(
    `UPDATE x_actor_screening_results SET status = $3, sample_size = $4,
       direct_intent_rate = $5, ca_resolution_rate = $6,
       false_positive_rate = $7, executable_win_rate = $8,
       return_snapshot = $9, metrics = $10, recommendation = $11,
       provider_coverage_rate = $12, ambiguity_rate = $13,
       historical_candidate_coverage_rate = $14, reason_codes = $15,
       error_code = $16, last_error = $17,
       completed_at = CASE WHEN $3 IN ('completed','partial','failed') THEN NOW() ELSE NULL END,
       updated_at = NOW()
     WHERE screening_run_id = $1 AND x_handle = $2 RETURNING *`,
    [runId, summary.x_handle, summary.status || 'completed', summary.sample_size, summary.direct_intent_rate,
      summary.ca_resolution_rate, summary.false_positive_rate, summary.executable_win_rate,
      summary.return_snapshot, summary.metrics, summary.recommendation,
      summary.provider_coverage_rate, summary.ambiguity_rate,
      summary.historical_candidate_coverage_rate, summary.reason_codes || [],
      summary.error_code || null, summary.last_error || null]
  );
  return result.rows[0];
}

module.exports = {
  BLOCKED_BACKTEST_INTENTS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_RETURN_SAMPLES,
  DEFAULT_RETRY_DELAY_MS,
  MIN_RETURN_SAMPLES,
  RETRYABLE_RESEARCH_ERRORS,
  SCREENING_CHAINS,
  boundedReturnSampleLimit,
  explicitCaTerms,
  fetchHistoricalCandidates,
  isBacktestEligible,
  isRetryableResearchError,
  percentile,
  persistResult,
  recommendationFor,
  retryAtForErrors,
  resolveExplicitCa,
  resolveHistorical,
  runActor,
  selectedGrokSamples
};
