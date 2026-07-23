// D:\AI_Projects\xbot\backend\domains\trade\queries.js
const db = require('../../lib/db');

async function getPositions(filters) {
  let query = `
    SELECT p.*, 
           wl.symbol, wl.project_name, wl.contract_address as whitelist_ca,
           ts.kol_handle, ts.signal_type, ts.kol_weight, ts.risk_check
    FROM positions p
    LEFT JOIN ca_whitelist wl ON p.whitelist_id = wl.id
    LEFT JOIN trade_signals ts ON p.signal_id = ts.id
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
           ts.kol_handle, ts.signal_type
    FROM positions p
    LEFT JOIN ca_whitelist wl ON p.whitelist_id = wl.id
    LEFT JOIN trade_signals ts ON p.signal_id = ts.id
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
