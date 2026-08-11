const db = require('../../lib/db');

const TRADE_SOURCE_SQL = `(
  source LIKE 'fixed_ca%'
  OR source LIKE 'p20_dynamic%'
  OR source LIKE 'p21_follow_discovery%'
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
  return Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 100;
}

async function getAuditSummary(options = {}) {
  const executor = options.db || db;
  const hours = boundedHours(options.hours);
  const limit = boundedLimit(options.limit);
  const params = [hours, limit];
  const [stageResult, missingResult, duplicateResult, unexpectedResult] = await Promise.all([
    executor.query(
      `SELECT COALESCE(context_json->>'stage', 'unknown') AS stage,
              COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE http_status = 429)::int AS rate_limited
       FROM provider_rate_events
       WHERE provider = 'gmgn'
         AND created_at >= NOW() - ($1::double precision * INTERVAL '1 hour')
         AND ${TRADE_SOURCE_SQL}
       GROUP BY COALESCE(context_json->>'stage', 'unknown')
       ORDER BY count DESC`,
      [hours]
    ),
    executor.query(
      `SELECT id, endpoint, source,
              COALESCE(context_json->>'stage', 'unknown') AS stage,
              signal_id,
              context_json->>'trace_id' AS trace_id,
              context_json->>'execution_session_id' AS execution_session_id,
              context_json->>'rate_scope' AS rate_scope,
              created_at
       FROM provider_rate_events
       WHERE provider = 'gmgn'
         AND created_at >= NOW() - ($1::double precision * INTERVAL '1 hour')
         AND ${TRADE_SOURCE_SQL}
         AND COALESCE(context_json->>'stage', '') IN (${TRADE_EXECUTION_STAGE_SQL})
         AND (
           signal_id IS NULL
           OR NULLIF(context_json->>'trace_id', '') IS NULL
           OR NULLIF(context_json->>'execution_session_id', '') IS NULL
           OR NULLIF(context_json->>'rate_scope', '') IS NULL
         )
       ORDER BY created_at DESC
       LIMIT $2`,
      params
    ),
    executor.query(
      `SELECT signal_id,
              COUNT(DISTINCT context_json->>'execution_session_id')::int AS session_count,
              ARRAY_AGG(DISTINCT context_json->>'execution_session_id') AS execution_sessions
       FROM provider_rate_events
       WHERE provider = 'gmgn'
         AND created_at >= NOW() - ($1::double precision * INTERVAL '1 hour')
         AND ${TRADE_SOURCE_SQL}
         AND COALESCE(context_json->>'stage', '') IN (${TRADE_EXECUTION_STAGE_SQL})
         AND signal_id IS NOT NULL
       GROUP BY signal_id
       HAVING COUNT(DISTINCT context_json->>'execution_session_id') > 1
       ORDER BY session_count DESC
       LIMIT $2`,
      params
    ),
    executor.query(
      `SELECT id, endpoint, source,
              COALESCE(context_json->>'stage', 'unknown') AS stage,
              signal_id,
              context_json->>'trace_id' AS trace_id,
              context_json->>'execution_session_id' AS execution_session_id,
              created_at
       FROM provider_rate_events
       WHERE provider = 'gmgn'
         AND created_at >= NOW() - ($1::double precision * INTERVAL '1 hour')
         AND (source LIKE 'fixed_ca%' OR source LIKE 'p20_dynamic%' OR source LIKE 'p21_follow_discovery%')
         AND COALESCE(context_json->>'stage', '') NOT IN (${TRADE_EXECUTION_STAGE_SQL})
       ORDER BY created_at DESC
       LIMIT $2`,
      params
    )
  ]);

  return {
    window_hours: hours,
    limit,
    trade_request_count: stageResult.rows.reduce((total, row) => total + Number(row.count || 0), 0),
    stage_counts: stageResult.rows,
    missing_provenance: missingResult.rows,
    duplicate_execution_sessions: duplicateResult.rows,
    unexpected_strategy_provider_stages: unexpectedResult.rows,
    healthy: missingResult.rows.length === 0
      && duplicateResult.rows.length === 0
      && unexpectedResult.rows.length === 0
  };
}

module.exports = {
  TRADE_EXECUTION_STAGES,
  boundedHours,
  boundedLimit,
  getAuditSummary
};
