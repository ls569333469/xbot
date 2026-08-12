const db = require('../../lib/db');
const livePolicy = require('./live-policy');
const { projectCurrentAuthorization } = require('./authorization-projection');
const { projectSignal } = require('../trade/contract-projector');

const SIGNAL_SELECT = `
  ts.id, ts.activity_id, ts.whitelist_id, ts.kol_id, ts.kol_handle,
  ts.signal_type, ts.match_detail, ts.canonical_key, ts.matched_project_handles,
  ts.matched_whitelist_ids, ts.matched_relation_ids, ts.matched_source_rule_ids,
  ts.kol_weight, ts.risk_check, ts.execution_mode, ts.status, ts.reject_reason,
  ts.created_at, ts.updated_at, ts.activation_wait_version, ts.trace_id,
  ts.matched_dynamic_resolution_id, ts.dynamic_target_id, ts.actor_policy_id,
  ts.actor_policy_revision, ts.dynamic_policy_context_hash,
  ts.follow_discovery_policy_id, ts.follow_discovery_event_id,
  ts.follow_discovery_policy_revision, ts.follow_discovery_context_hash,
  ts.strategy_type, ts.asset_snapshot, ts.authorization_snapshot,
  metadata.name AS gmgn_asset_name, metadata.symbol AS gmgn_asset_symbol,
  metadata.logo_url AS gmgn_asset_logo_url, metadata.decimals AS gmgn_asset_decimals,
  metadata.status AS gmgn_asset_metadata_status,
  ca.chain_id, ca.contract_address,
  xa.activity_type, xa.provider, xa.source_created_at,
  xa.observation_started_at, xa.observation_ended_at,
  trade_flow.trade_intent_id, trade_flow.trade_intent_status,
  trade_flow.retry_count, trade_flow.max_retries,
  trade_flow.trade_attempt_id, trade_flow.attempt_no,
  trade_flow.trade_attempt_status, trade_flow.failure_class,
  trade_flow.trade_error_code, trade_flow.order_id, trade_flow.tx_hash,
  trade_flow.output_decimals`;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

async function listSignals(filters = {}, executor = db) {
  const page = boundedInteger(filters.page, 1, 1, 100_000);
  const pageSize = boundedInteger(filters.pageSize, 20, 1, 200);
  const params = [];
  let where = 'WHERE 1=1';
  if (filters.chain_id) {
    params.push(String(filters.chain_id));
    where += ` AND ca.chain_id = $${params.length}`;
  }
  if (filters.signal_type) {
    params.push(String(filters.signal_type));
    where += ` AND ts.signal_type = $${params.length}`;
  }
  if (filters.status) {
    params.push(String(filters.status));
    where += ` AND ts.status = $${params.length}`;
  }
  const from = `FROM trade_signals ts
    JOIN ca_whitelist ca ON ca.id = ts.whitelist_id
    LEFT JOIN asset_metadata metadata
      ON metadata.chain_id = lower(ca.chain_id)
     AND metadata.contract_address_key = CASE WHEN lower(ca.chain_id) = 'sol'
       THEN ca.contract_address ELSE lower(ca.contract_address) END
     AND metadata.status = 'completed'
    LEFT JOIN x_activities xa ON xa.id = ts.activity_id
    LEFT JOIN LATERAL (
      SELECT intent.id AS trade_intent_id, intent.status AS trade_intent_status,
             intent.retry_count, intent.max_retries,
             attempt.id AS trade_attempt_id, attempt.attempt_no,
             attempt.status AS trade_attempt_status,
             attempt.failure_class, attempt.error_code AS trade_error_code,
             orders.id AS order_id, orders.tx_hash, orders.output_decimals
      FROM trade_intents intent
      LEFT JOIN LATERAL (
        SELECT attempt_row.id, attempt_row.attempt_no, attempt_row.status,
               attempt_row.failure_class, attempt_row.error_code
        FROM trade_attempts attempt_row
        WHERE attempt_row.intent_id = intent.id ORDER BY attempt_row.attempt_no DESC LIMIT 1
      ) attempt ON true
      LEFT JOIN LATERAL (
        SELECT order_row.id, order_row.tx_hash, order_row.output_decimals
        FROM trade_orders order_row
        WHERE order_row.attempt_id = attempt.id ORDER BY order_row.id DESC LIMIT 1
      ) orders ON true
      WHERE intent.signal_id = ts.id ORDER BY intent.id DESC LIMIT 1
    ) trade_flow ON true ${where}`;
  const count = await executor.query(`SELECT COUNT(*)::int AS count ${from}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const result = await executor.query(
    `SELECT ${SIGNAL_SELECT} ${from}
     ORDER BY ts.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const [policy, chainResult] = await Promise.all([
    livePolicy.getPolicy(),
    executor.query('SELECT chain, implemented, contract_tested, live_enabled FROM chain_live_readiness')
      .catch(() => ({ rows: [] }))
  ]);
  const projections = await projectCurrentAuthorization(result.rows, policy, chainResult.rows, executor);
  return {
    data: result.rows.map((row) => projectSignal(
      row, projections.get(String(row.id)) || { status: 'unknown', blockers: [] }
    )),
    total: Number(count.rows[0]?.count || 0),
    page,
    pageSize
  };
}

module.exports = { SIGNAL_SELECT, boundedInteger, listSignals };
