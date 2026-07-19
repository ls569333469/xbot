const db = require('../../lib/db');
const notifier = require('../../lib/notifier');

async function getSignals(filters) {
  let query = 'SELECT * FROM trade_signals WHERE 1=1';
  let params = [];
  let paramIndex = 1;

  if (filters.status) {
    query += ` AND status = $${paramIndex++}`;
    params.push(filters.status);
  }
  
  query += ' ORDER BY created_at DESC LIMIT 50';
  const res = await db.query(query, params);
  return res.rows;
}

async function createSignal(data) {
  const res = await db.query(
    `INSERT INTO trade_signals (activity_id, whitelist_id, kol_id, kol_handle, signal_type, match_detail, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'recorded')
     ON CONFLICT (activity_id, whitelist_id, signal_type) DO NOTHING RETURNING *`,
    [data.activity_id, data.whitelist_id, data.kol_id, data.kol_handle, data.signal_type, data.match_detail]
  );
  if (res.rows[0]) {
     notifier.signalMatched(res.rows[0]);
  }
  return res.rows[0];
}

async function getStats() {
  const res = await db.query('SELECT status, COUNT(*) as count FROM trade_signals GROUP BY status');
  return res.rows;
}

module.exports = { getSignals, createSignal, getStats };
