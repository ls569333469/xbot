const db = require('../../lib/db');

const TRADE_SOURCE_SQL = `(
  source LIKE 'fixed_ca%'
  OR source LIKE 'p20_dynamic%'
  OR source LIKE 'p21_follow_discovery%'
  OR source LIKE 'trade_execution%'
  OR source LIKE 'trade_close%'
  OR source = 'trade_reconciliation'
)`;

const TRADE_EXECUTION_STAGES = Object.freeze([
  'security', 'gas', 'quote', 'token_info', 'swap', 'order_query'
]);
const TRADE_EXECUTION_STAGE_SQL = TRADE_EXECUTION_STAGES.map((stage) => `'${stage}'`).join(', ');

function boundedHours(value) {
  const hours = Number(value);
  return Number.isFinite(hours) ? Math.min(168, Math.max(1, hours)) : 24;
}

function boundedLimit(value) {
  const limit = Number(value);
  return Number.isInteger(limit) ? Math.min(1000, Math.max(1, limit)) : 100;
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function auditWindow(options = {}) {
  const until = validDate(options.until) || new Date();
  const since = validDate(options.since)
    || new Date(until.getTime() - boundedHours(options.hours) * 60 * 60_000);
  if (since > until) {
    const error = new Error('Provider audit start must be before its end');
    error.code = 'PROVIDER_AUDIT_WINDOW_INVALID';
    throw error;
  }
  return { since, until };
}

function eventStage(row = {}) {
  return String(row.stage || row.context_json?.stage || 'unknown').toLowerCase();
}

function classifyProviderEvent(row = {}) {
  const source = String(row.source || '').toLowerCase();
  const stage = eventStage(row);
  if (source.startsWith('fixed_ca') || source.startsWith('p20_dynamic')
      || source.startsWith('p21_follow_discovery') || source.startsWith('trade_execution')) {
    return 'buy';
  }
  if (source.startsWith('trade_close')) return 'close';
  if (source === 'trade_reconciliation' && stage.includes('strategy')) return 'strategy_sync';
  if (source === 'trade_reconciliation' || source.startsWith('trade_recovery')) {
    return 'order_recovery';
  }
  if (source.startsWith('research') || source.startsWith('research_market')
      || source.startsWith('actor_screening')) return 'research';
  if (source.startsWith('readiness')) return 'readiness';
  return 'unknown';
}

function attemptId(row = {}) {
  const value = row.context_json?.attempt_id;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function auditAllEvents(rows = [], options = {}) {
  const allowedSignalIds = new Set((options.allowedSignalIds || []).map(Number));
  const enforceAllowedSignals = Array.isArray(options.allowedSignalIds);
  const categoryCounts = new Map();
  const swapAttempts = new Map();
  const unknownRequests = [];
  const unauthorizedBuyRequests = [];
  const missingSwapAttempts = [];
  const invalidSwapSessions = [];
  let rateLimitedCount = 0;

  for (const row of rows) {
    const category = classifyProviderEvent(row);
    const stage = eventStage(row);
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    if (Number(row.http_status) === 429 || String(row.error_code || '').includes('RATE_LIMIT')) {
      rateLimitedCount += 1;
    }
    if (category === 'unknown') unknownRequests.push(row);
    if (category === 'buy' && enforceAllowedSignals
        && !allowedSignalIds.has(Number(row.signal_id))) unauthorizedBuyRequests.push(row);
    if (stage === 'swap' && ['buy', 'close'].includes(category)) {
      const id = attemptId(row);
      if (!id) {
        missingSwapAttempts.push(row);
        continue;
      }
      const key = `${category}:${id}`;
      swapAttempts.set(key, (swapAttempts.get(key) || 0) + 1);
      const session = String(row.context_json?.execution_session_id || '');
      const expectedSession = category === 'buy'
        ? `signal:${Number(row.signal_id)}`
        : `attempt:${id}`;
      if (session !== expectedSession) {
        invalidSwapSessions.push({ ...row, expected_session: expectedSession });
      }
    }
  }

  const duplicateSwapAttempts = [...swapAttempts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }));
  return {
    request_count: rows.length,
    audit_truncated: options.truncated === true,
    category_counts: Object.fromEntries(categoryCounts),
    rate_limited_count: rateLimitedCount,
    unknown_requests: unknownRequests,
    unauthorized_buy_requests: unauthorizedBuyRequests,
    missing_swap_attempts: missingSwapAttempts,
    invalid_swap_sessions: invalidSwapSessions,
    duplicate_swap_attempts: duplicateSwapAttempts
  };
}

async function getAuditSummary(options = {}) {
  const executor = options.db || db;
  const hours = boundedHours(options.hours);
  const limit = boundedLimit(options.limit);
  const window = auditWindow(options);
  const params = [window.since, window.until, limit];
  const [stageResult, missingResult, sessionResult, unexpectedResult, allResult] = await Promise.all([
    executor.query(
      `SELECT COALESCE(context_json->>'stage', 'unknown') AS stage,
              COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE http_status = 429)::int AS rate_limited
       FROM provider_rate_events
       WHERE provider = 'gmgn' AND created_at >= $1 AND created_at <= $2
         AND ${TRADE_SOURCE_SQL}
       GROUP BY COALESCE(context_json->>'stage', 'unknown')
       ORDER BY count DESC`,
      params.slice(0, 2)
    ),
    executor.query(
      `SELECT id, endpoint, source, COALESCE(context_json->>'stage', 'unknown') AS stage,
              signal_id, context_json, created_at
       FROM provider_rate_events
       WHERE provider = 'gmgn' AND created_at >= $1 AND created_at <= $2
         AND ${TRADE_SOURCE_SQL}
         AND COALESCE(context_json->>'stage', '') IN (${TRADE_EXECUTION_STAGE_SQL})
         AND (NULLIF(context_json->>'trace_id', '') IS NULL
           OR NULLIF(context_json->>'execution_session_id', '') IS NULL
           OR NULLIF(context_json->>'rate_scope', '') IS NULL)
       ORDER BY created_at DESC LIMIT $3`,
      params
    ),
    executor.query(
      `SELECT signal_id,
              COUNT(DISTINCT context_json->>'execution_session_id')::int AS session_count,
              ARRAY_AGG(DISTINCT context_json->>'execution_session_id') AS execution_sessions
       FROM provider_rate_events
       WHERE provider = 'gmgn' AND created_at >= $1 AND created_at <= $2
         AND (source LIKE 'fixed_ca%' OR source LIKE 'p20_dynamic%'
           OR source LIKE 'p21_follow_discovery%' OR source LIKE 'trade_execution%')
         AND COALESCE(context_json->>'stage', '') = 'swap' AND signal_id IS NOT NULL
       GROUP BY signal_id
       HAVING COUNT(DISTINCT context_json->>'execution_session_id') > 1
       ORDER BY session_count DESC LIMIT $3`,
      params
    ),
    executor.query(
      `SELECT id, endpoint, source, COALESCE(context_json->>'stage', 'unknown') AS stage,
              signal_id, context_json, created_at
       FROM provider_rate_events
       WHERE provider = 'gmgn' AND created_at >= $1 AND created_at <= $2
         AND (source LIKE 'fixed_ca%' OR source LIKE 'p20_dynamic%'
           OR source LIKE 'p21_follow_discovery%' OR source LIKE 'trade_execution%')
         AND COALESCE(context_json->>'stage', '') NOT IN (${TRADE_EXECUTION_STAGE_SQL})
       ORDER BY created_at DESC LIMIT $3`,
      params
    ),
    executor.query(
      `SELECT id, endpoint, method, http_status, error_code, source, signal_id,
              context_json, COALESCE(context_json->>'stage', 'unknown') AS stage, created_at
       FROM provider_rate_events
       WHERE provider = 'gmgn' AND created_at >= $1 AND created_at <= $2
       ORDER BY created_at ASC LIMIT $3`,
      params
    )
  ]);

  const global = auditAllEvents(allResult.rows, {
    allowedSignalIds: options.allowedSignalIds,
    truncated: allResult.rows.length >= limit
  });
  const healthy = missingResult.rows.length === 0
    && sessionResult.rows.length === 0
    && unexpectedResult.rows.length === 0
    && global.rate_limited_count === 0
    && !global.audit_truncated
    && global.unknown_requests.length === 0
    && global.unauthorized_buy_requests.length === 0
    && global.missing_swap_attempts.length === 0
    && global.invalid_swap_sessions.length === 0
    && global.duplicate_swap_attempts.length === 0;
  return {
    window_hours: hours,
    window: { since: window.since, until: window.until },
    limit,
    trade_request_count: stageResult.rows.reduce((total, row) => total + Number(row.count || 0), 0),
    stage_counts: stageResult.rows,
    missing_provenance: missingResult.rows,
    duplicate_execution_sessions: sessionResult.rows,
    unexpected_strategy_provider_stages: unexpectedResult.rows,
    ...global,
    healthy
  };
}

module.exports = {
  TRADE_EXECUTION_STAGES,
  auditAllEvents,
  auditWindow,
  boundedHours,
  boundedLimit,
  classifyProviderEvent,
  getAuditSummary
};
