const db = require('../../lib/db');
const { hydrateWhitelistRelations, hydrateWhitelistSummaries } = require('./relations');

async function getAll(filters, executor = db) {
  const baseWhere = filters.status === 'archived'
    ? " WHERE source NOT IN ('dynamic_keyword', 'follow_discovery')"
    : " WHERE status <> 'archived' AND source NOT IN ('dynamic_keyword', 'follow_discovery')";
  let query = `SELECT * FROM ca_whitelist${baseWhere}`;
  let countQuery = `SELECT COUNT(*) FROM ca_whitelist${baseWhere}`;
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

  const countRes = await executor.query(countQuery, countParams);
  const total = parseInt(countRes.rows[0].count, 10);

  const page = parseInt(filters.page) || 1;
  const pageSize = parseInt(filters.pageSize) || 20;
  const offset = (page - 1) * pageSize;

  query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
  params.push(pageSize, offset);

  const res = await executor.query(query, params);
  const hydrate = filters.summary ? hydrateWhitelistSummaries : hydrateWhitelistRelations;
  return { rows: await hydrate(res.rows, executor), total, page, pageSize };
}

async function getById(id, executor = db) {
  const res = await executor.query('SELECT * FROM ca_whitelist WHERE id = $1', [id]);
  const rows = await hydrateWhitelistRelations(res.rows, executor);
  return rows[0];
}

async function getActiveByContract(contractAddress, chainId, executor = db, options = {}) {
  const evmChain = ['bsc', 'base', 'eth', 'robinhood'].includes(String(chainId).toLowerCase());
  const addressMatch = evmChain
    ? 'lower(contract_address) = lower($1)'
    : 'contract_address = $1';
  const lock = options.forUpdate ? ' FOR UPDATE' : '';
  const res = await executor.query(
    `SELECT * FROM ca_whitelist
      WHERE ${addressMatch} AND chain_id = $2 AND status = 'active'
        AND source NOT IN ('dynamic_keyword', 'follow_discovery')
     ORDER BY id LIMIT 1${lock}`,
    [contractAddress, chainId]
  );
  const rows = await hydrateWhitelistRelations(res.rows, executor);
  return rows[0];
}

async function create(data, executor = db) {
  const res = await executor.query(
    `INSERT INTO ca_whitelist 
    (contract_address, chain_id, symbol, project_name, project_x_handles,
     budget_per_trade, total_budget, auto_tp_pct, auto_sl_pct, exit_strategy,
     exit_strategy_version, slippage, allow_repeat_buy, max_repeat_buys, status,
     source, expires_at, token_logo_url, token_official_x_handle,
     token_website_url, token_metadata_source, token_metadata_fetched_at,
     launch_rule_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING *`,
    [
      data.contract_address, data.chain_id, data.symbol, data.project_name, 
      data.project_x_handles || [], data.budget_per_trade, data.total_budget, 
      data.auto_tp_pct || 100, data.auto_sl_pct || 20, data.exit_strategy,
      data.exit_strategy_version || 1, data.slippage || 10,
      data.allow_repeat_buy || false, data.max_repeat_buys || 1, 
      data.status || 'active', data.source || 'manual', data.expires_at,
      data.token_logo_url || null, data.token_official_x_handle || null,
      data.token_website_url || null, data.token_metadata_source || null,
      data.token_metadata_fetched_at || null, data.launch_rule_id || null
    ]
  );
  return res.rows[0];
}

async function update(id, data, executor = db) {
  const res = await executor.query(
    `UPDATE ca_whitelist SET 
      symbol = COALESCE($1, symbol),
      project_name = COALESCE($2, project_name),
      project_x_handles = COALESCE($3, project_x_handles),
      budget_per_trade = COALESCE($4, budget_per_trade),
      total_budget = COALESCE($5, total_budget),
      auto_tp_pct = COALESCE($6, auto_tp_pct),
      auto_sl_pct = COALESCE($7, auto_sl_pct),
      exit_strategy = COALESCE($8, exit_strategy),
      exit_strategy_version = COALESCE($9, exit_strategy_version),
      slippage = COALESCE($10, slippage),
      allow_repeat_buy = COALESCE($11, allow_repeat_buy),
      max_repeat_buys = COALESCE($12, max_repeat_buys),
      expires_at = COALESCE($13, expires_at),
      token_logo_url = COALESCE($14, token_logo_url),
      token_official_x_handle = COALESCE($15, token_official_x_handle),
      token_website_url = COALESCE($16, token_website_url),
      token_metadata_source = COALESCE($17, token_metadata_source),
      token_metadata_fetched_at = COALESCE($18, token_metadata_fetched_at),
      updated_at = NOW()
    WHERE id = $19 RETURNING *`,
    [
      data.symbol, data.project_name, data.project_x_handles, data.budget_per_trade,
      data.total_budget, data.auto_tp_pct, data.auto_sl_pct, data.exit_strategy,
      data.exit_strategy_version, data.slippage, data.allow_repeat_buy,
      data.max_repeat_buys, data.expires_at, data.token_logo_url,
      data.token_official_x_handle, data.token_website_url,
      data.token_metadata_source, data.token_metadata_fetched_at, id
    ]
  );
  return res.rows[0];
}

async function updateStatus(id, status, executor = db) {
  const res = await executor.query(
    'UPDATE ca_whitelist SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [status, id]
  );
  return res.rows[0];
}

async function archive(id, executor = db) {
  const res = await executor.query(
    `UPDATE ca_whitelist
     SET status = 'archived', updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

module.exports = { archive, getAll, getById, getActiveByContract, create, update, updateStatus };
