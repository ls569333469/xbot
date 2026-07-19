const db = require('../../lib/db');

async function getAll(filters) {
  let query = 'SELECT * FROM ca_whitelist WHERE 1=1';
  let countQuery = 'SELECT COUNT(*) FROM ca_whitelist WHERE 1=1';
  let params = [];
  let countParams = [];
  let paramIndex = 1;

  if (filters.chain_id) {
    const clause = ` AND chain_id = $${paramIndex++}`;
    query += clause;
    countQuery += clause;
    params.push(filters.chain_id);
    countParams.push(filters.chain_id);
  }
  if (filters.status) {
    const clause = ` AND status = $${paramIndex++}`;
    query += clause;
    countQuery += clause;
    params.push(filters.status);
    countParams.push(filters.status);
  }
  if (filters.search) {
    const clause = ` AND (contract_address ILIKE $${paramIndex} OR symbol ILIKE $${paramIndex} OR project_name ILIKE $${paramIndex})`;
    query += clause;
    countQuery += clause;
    params.push(`%${filters.search}%`);
    countParams.push(`%${filters.search}%`);
    paramIndex++;
  }

  const countRes = await db.query(countQuery, countParams);
  const total = parseInt(countRes.rows[0].count, 10);

  const page = parseInt(filters.page) || 1;
  const pageSize = parseInt(filters.pageSize) || 20;
  const offset = (page - 1) * pageSize;

  query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
  params.push(pageSize, offset);

  const res = await db.query(query, params);
  return { rows: res.rows, total, page, pageSize };
}

async function getById(id) {
  const res = await db.query('SELECT * FROM ca_whitelist WHERE id = $1', [id]);
  return res.rows[0];
}

async function create(data) {
  const res = await db.query(
    `INSERT INTO ca_whitelist 
    (contract_address, chain_id, symbol, project_name, project_x_handles, budget_per_trade, total_budget, auto_tp_pct, auto_sl_pct, slippage, allow_repeat_buy, max_repeat_buys, status, source, expires_at) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
    [
      data.contract_address, data.chain_id, data.symbol, data.project_name, 
      data.project_x_handles || [], data.budget_per_trade, data.total_budget, 
      data.auto_tp_pct || 100, data.auto_sl_pct || 20, data.slippage || 10, 
      data.allow_repeat_buy || false, data.max_repeat_buys || 1, 
      data.status || 'active', data.source || 'manual', data.expires_at
    ]
  );
  return res.rows[0];
}

async function update(id, data) {
  const res = await db.query(
    `UPDATE ca_whitelist SET 
      symbol = COALESCE($1, symbol),
      project_name = COALESCE($2, project_name),
      project_x_handles = COALESCE($3, project_x_handles),
      budget_per_trade = COALESCE($4, budget_per_trade),
      total_budget = COALESCE($5, total_budget),
      auto_tp_pct = COALESCE($6, auto_tp_pct),
      auto_sl_pct = COALESCE($7, auto_sl_pct),
      slippage = COALESCE($8, slippage),
      allow_repeat_buy = COALESCE($9, allow_repeat_buy),
      max_repeat_buys = COALESCE($10, max_repeat_buys),
      expires_at = COALESCE($11, expires_at),
      updated_at = NOW()
    WHERE id = $12 RETURNING *`,
    [
      data.symbol, data.project_name, data.project_x_handles, data.budget_per_trade,
      data.total_budget, data.auto_tp_pct, data.auto_sl_pct, data.slippage,
      data.allow_repeat_buy, data.max_repeat_buys, data.expires_at, id
    ]
  );
  return res.rows[0];
}

async function updateStatus(id, status) {
  const res = await db.query(
    'UPDATE ca_whitelist SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [status, id]
  );
  return res.rows[0];
}

async function remove(id) {
  await db.query('DELETE FROM ca_whitelist WHERE id = $1', [id]);
  return true;
}

module.exports = { getAll, getById, create, update, updateStatus, remove };
