const db = require('../../lib/db');

async function getPositions(filters) {
  let query = `
    SELECT p.*, 
           wl.symbol, wl.project_name, wl.contract_address as whitelist_ca,
           ts.kol_handle, ts.signal_type, ts.kol_weight, ts.risk_check,
           trade_flow.trade_intent_id, trade_flow.trade_intent_status,
           trade_flow.trade_attempt_id, trade_flow.attempt_no,
           trade_flow.trade_attempt_status, trade_flow.failure_class,
           trade_flow.trade_error_code
    FROM positions p
    LEFT JOIN ca_whitelist wl ON p.whitelist_id = wl.id
    LEFT JOIN trade_signals ts ON p.signal_id = ts.id
    LEFT JOIN LATERAL (
      SELECT intent.id AS trade_intent_id, intent.status AS trade_intent_status,
             attempt.id AS trade_attempt_id, attempt.attempt_no,
             attempt.status AS trade_attempt_status,
             attempt.failure_class, attempt.error_code AS trade_error_code
      FROM trade_intents AS intent
      LEFT JOIN LATERAL (
        SELECT * FROM trade_attempts
        WHERE intent_id = intent.id ORDER BY attempt_no DESC LIMIT 1
      ) AS attempt ON true
      WHERE intent.position_id = p.id OR intent.signal_id = p.signal_id
      ORDER BY intent.id DESC LIMIT 1
    ) AS trade_flow ON true
    WHERE 1=1
  `;
  const params = [];
  let paramIndex = 1;

  if (filters.statuses) {
    query += ` AND p.status = ANY($${paramIndex++}::text[])`;
    params.push(filters.statuses);
  } else if (filters.status) {
    query += ` AND p.status = $${paramIndex++}`;
    params.push(filters.status);
  }
  if (filters.chain_id) {
    query += ` AND p.chain_id = $${paramIndex++}`;
    params.push(filters.chain_id);
  }

  query += ' ORDER BY p.opened_at DESC';
  const res = await db.query(query, params);
  return res.rows;
}

async function getHistory(filters) {
  let query = `
    SELECT p.*, 
           wl.symbol, wl.project_name,
           ts.kol_handle, ts.signal_type,
           trade_flow.trade_intent_id, trade_flow.trade_intent_status,
           trade_flow.trade_attempt_id, trade_flow.attempt_no,
           trade_flow.trade_attempt_status, trade_flow.failure_class,
           trade_flow.trade_error_code
    FROM positions p
    LEFT JOIN ca_whitelist wl ON p.whitelist_id = wl.id
    LEFT JOIN trade_signals ts ON p.signal_id = ts.id
    LEFT JOIN LATERAL (
      SELECT intent.id AS trade_intent_id, intent.status AS trade_intent_status,
             attempt.id AS trade_attempt_id, attempt.attempt_no,
             attempt.status AS trade_attempt_status,
             attempt.failure_class, attempt.error_code AS trade_error_code
      FROM trade_intents AS intent
      LEFT JOIN LATERAL (
        SELECT * FROM trade_attempts
        WHERE intent_id = intent.id ORDER BY attempt_no DESC LIMIT 1
      ) AS attempt ON true
      WHERE intent.position_id = p.id OR intent.signal_id = p.signal_id
      ORDER BY intent.id DESC LIMIT 1
    ) AS trade_flow ON true
    WHERE p.status IN ('closed', 'tp_hit', 'sl_hit', 'manual_close', 'failed')
  `;
  const params = [];
  let paramIndex = 1;

  if (filters.chain_id) {
    query += ` AND p.chain_id = $${paramIndex++}`;
    params.push(filters.chain_id);
  }

  query += ' ORDER BY p.closed_at DESC LIMIT 100';
  const res = await db.query(query, params);
  return res.rows;
}

module.exports = {
  getPositions,
  getHistory
};
