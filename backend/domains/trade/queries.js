const db = require('../../lib/db');
const { projectPosition } = require('./contract-projector');

const POSITION_SELECT = `
  p.id, p.signal_id, p.whitelist_id, p.contract_address, p.chain_id,
  p.symbol, p.amount_in, p.amount_out, p.entry_price,
  p.buy_tx_hash, p.buy_order_id, p.sell_tx_hash,
  p.tp_pct, p.sl_pct, p.tp_order_id, p.sl_order_id, p.tpsl_status,
  p.exit_price, p.pnl, p.pnl_pct, p.sim_peaks, p.execution_mode, p.status,
  p.opened_at, p.closed_at, p.created_at, p.updated_at, p.asset_snapshot,
  wl.project_name, wl.symbol AS whitelist_symbol,
  ts.strategy_type, ts.actor_policy_id, ts.follow_discovery_policy_id,
  ts.kol_handle, ts.signal_type, ts.kol_weight, ts.risk_check,
  trade_flow.trade_intent_id, trade_flow.trade_intent_status,
  trade_flow.trade_attempt_id, trade_flow.attempt_no,
  trade_flow.trade_attempt_status, trade_flow.failure_class,
  trade_flow.trade_error_code, trade_flow.order_id, trade_flow.tx_hash`;

const POSITION_FROM = `
  FROM positions p
  LEFT JOIN ca_whitelist wl ON wl.id = p.whitelist_id
  LEFT JOIN trade_signals ts ON ts.id = p.signal_id
  LEFT JOIN LATERAL (
    SELECT intent.id AS trade_intent_id, intent.status AS trade_intent_status,
           attempt.id AS trade_attempt_id, attempt.attempt_no,
           attempt.status AS trade_attempt_status,
           attempt.failure_class, attempt.error_code AS trade_error_code,
           orders.id AS order_id, orders.tx_hash
    FROM trade_intents intent
    LEFT JOIN LATERAL (
      SELECT attempt_row.id, attempt_row.attempt_no, attempt_row.status,
             attempt_row.failure_class, attempt_row.error_code
      FROM trade_attempts attempt_row
      WHERE attempt_row.intent_id = intent.id ORDER BY attempt_row.attempt_no DESC LIMIT 1
    ) attempt ON true
    LEFT JOIN LATERAL (
      SELECT order_row.id, order_row.tx_hash
      FROM trade_orders order_row
      WHERE order_row.attempt_id = attempt.id ORDER BY order_row.id DESC LIMIT 1
    ) orders ON true
    WHERE intent.position_id = p.id OR intent.signal_id = p.signal_id
    ORDER BY intent.id DESC LIMIT 1
  ) trade_flow ON true`;

async function getPositions(filters = {}) {
  let query = `SELECT ${POSITION_SELECT} ${POSITION_FROM} WHERE 1=1`;
  const params = [];
  if (filters.statuses) {
    params.push(filters.statuses);
    query += ` AND p.status = ANY($${params.length}::text[])`;
  } else if (filters.status) {
    params.push(filters.status);
    query += ` AND p.status = $${params.length}`;
  }
  if (filters.chain_id) {
    params.push(filters.chain_id);
    query += ` AND p.chain_id = $${params.length}`;
  }
  query += ' ORDER BY p.opened_at DESC NULLS LAST, p.id DESC';
  const result = await db.query(query, params);
  return result.rows.map((row) => projectPosition({
    ...row,
    symbol: row.asset_snapshot?.symbol ?? row.symbol ?? row.whitelist_symbol
  }));
}

async function getHistory(filters = {}) {
  let query = `SELECT ${POSITION_SELECT} ${POSITION_FROM}
    WHERE p.status IN ('closed','tp_hit','sl_hit','manual_close','failed')`;
  const params = [];
  if (filters.chain_id) {
    params.push(filters.chain_id);
    query += ` AND p.chain_id = $${params.length}`;
  }
  query += ' ORDER BY p.closed_at DESC NULLS LAST, p.id DESC LIMIT 100';
  const result = await db.query(query, params);
  return result.rows.map((row) => projectPosition({
    ...row,
    symbol: row.asset_snapshot?.symbol ?? row.symbol ?? row.whitelist_symbol
  }));
}

module.exports = { POSITION_FROM, POSITION_SELECT, getHistory, getPositions };
