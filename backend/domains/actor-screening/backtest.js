const db = require('../../lib/db');
const { fetchKline } = require('../dynamic-signal/gmgn-market-source');
const { extractContent } = require('../dynamic-signal/content-extractor');
const { classifyIntent } = require('../dynamic-signal/intent-gate');

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
  const returns = [];
  let direct = 0; let resolved = 0; let ambiguous = 0; let coverage = 0;
  for (const tweet of tweets || []) {
    const extraction = extractContent({ text: tweet.text || tweet.tweet_text || '', eventType: 'tweet' });
    const intent = classifyIntent(extraction);
    if (['buy_direct', 'launch_direct', 'full_ca_solo'].includes(intent.intentClass)) direct += 1;
    const historical = await resolveHistorical(extraction, tweet.created_at, options.executor || db);
    if (historical.covered) coverage += 1;
    if (historical.candidates.length === 1) {
      resolved += 1;
      const candidate = historical.candidates[0];
      const from = Math.floor(new Date(tweet.created_at).getTime() / 1000);
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
      } catch {}
    }
    if (historical.candidates.length > 1) ambiguous += 1;
  }
  const total = Math.max(1, (tweets || []).length);
  const wins = returns.filter((item) => item.return_24h_pct > 0).length;
  return {
    x_handle: handle, sample_size: tweets.length,
    direct_intent_rate: direct / total, ca_resolution_rate: resolved / total,
    ambiguity_rate: ambiguous / total, historical_candidate_coverage_rate: coverage / total,
    provider_coverage_rate: coverage / total,
    false_positive_rate: null, executable_win_rate: returns.length ? wins / returns.length : null,
    return_snapshot: {
      kline_source: 'gmgn_token_kline', samples: returns,
      median_return_24h_pct: percentile(returns.map((item) => item.return_24h_pct), 0.5),
      median_max_gain_24h_pct: percentile(returns.map((item) => item.max_gain_24h_pct), 0.5)
    },
    metrics: { direct, resolved, ambiguous, coverage, tweets: tweets.length, return_samples: returns.length },
    recommendation: tweets.length >= 20 && resolved / total >= 0.3 && returns.length >= 5
      ? 'approve_for_record' : tweets.length >= 10 ? 'watch' : 'insufficient_data'
  };
}

async function persistResult(runId, summary, executor = db) {
  const result = await executor.query(
    `UPDATE x_actor_screening_results SET status = 'completed', sample_size = $3,
       direct_intent_rate = $4, ca_resolution_rate = $5,
       false_positive_rate = $6, executable_win_rate = $7,
       return_snapshot = $8, metrics = $9, recommendation = $10,
       provider_coverage_rate = $11, ambiguity_rate = $12,
       historical_candidate_coverage_rate = $13, completed_at = NOW(), updated_at = NOW()
     WHERE screening_run_id = $1 AND x_handle = $2 RETURNING *`,
    [runId, summary.x_handle, summary.sample_size, summary.direct_intent_rate,
      summary.ca_resolution_rate, summary.false_positive_rate, summary.executable_win_rate,
      summary.return_snapshot, summary.metrics, summary.recommendation,
      summary.provider_coverage_rate, summary.ambiguity_rate,
      summary.historical_candidate_coverage_rate]
  );
  return result.rows[0];
}

module.exports = { fetchHistoricalCandidates, percentile, persistResult, resolveHistorical, runActor };
