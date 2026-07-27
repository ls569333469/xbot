const db = require('../../lib/db');

async function hydrate(rows, executor = db) {
  if (!rows.length) return rows;
  const ids = rows.map((row) => Number(row.id));
  const [sourcesResult, relationsResult, discoveriesResult] = await Promise.all([
    executor.query(
      `SELECT source.*, actor.x_handle AS actor_handle,
              actor.display_name AS actor_display_name
       FROM project_launch_sources AS source
       JOIN x_kol_accounts AS actor ON actor.id = source.actor_id
       WHERE source.launch_rule_id = ANY($1::bigint[])
       ORDER BY source.launch_rule_id, lower(actor.x_handle)`,
      [ids]
    ),
    executor.query(
      `SELECT relation.*, actor.x_handle AS actor_handle,
              actor.display_name AS actor_display_name
       FROM project_launch_relations AS relation
       JOIN x_kol_accounts AS actor ON actor.id = relation.actor_id
       WHERE relation.launch_rule_id = ANY($1::bigint[])
       ORDER BY relation.launch_rule_id, lower(actor.x_handle), relation.target_x_handle`,
      [ids]
    ),
    executor.query(
      `SELECT discovery.*
       FROM project_launch_discoveries AS discovery
       WHERE discovery.launch_rule_id = ANY($1::bigint[])
       ORDER BY discovery.launch_rule_id, discovery.created_at DESC`,
      [ids]
    )
  ]);
  const group = (items, key) => {
    const grouped = new Map();
    for (const item of items) {
      const id = Number(item[key]);
      const current = grouped.get(id) || [];
      current.push(item);
      grouped.set(id, current);
    }
    return grouped;
  };
  const sources = group(sourcesResult.rows, 'launch_rule_id');
  const relations = group(relationsResult.rows, 'launch_rule_id');
  const discoveries = group(discoveriesResult.rows, 'launch_rule_id');
  return rows.map((row) => ({
    ...row,
    sources: sources.get(Number(row.id)) || [],
    relations: relations.get(Number(row.id)) || [],
    discoveries: discoveries.get(Number(row.id)) || []
  }));
}

async function list(filters = {}, executor = db) {
  const clauses = [];
  const params = [];
  if (filters.chain_id) {
    params.push(String(filters.chain_id).toLowerCase());
    clauses.push(`chain_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(String(filters.status).toLowerCase());
    clauses.push(`status = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${String(filters.search).trim()}%`);
    clauses.push(`(project_name ILIKE $${params.length} OR EXISTS (
      SELECT 1 FROM project_launch_sources AS source
      JOIN x_kol_accounts AS actor ON actor.id = source.actor_id
      WHERE source.launch_rule_id = project_launch_rules.id
        AND actor.x_handle ILIKE $${params.length}
    ))`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize) || 20));
  const countResult = await executor.query(
    `SELECT COUNT(*) FROM project_launch_rules ${where}`,
    params
  );
  params.push(pageSize, (page - 1) * pageSize);
  const result = await executor.query(
    `SELECT * FROM project_launch_rules ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    rows: await hydrate(result.rows, executor),
    total: Number(countResult.rows[0].count),
    page,
    pageSize
  };
}

async function getById(id, executor = db, options = {}) {
  const lock = options.forUpdate ? ' FOR UPDATE' : '';
  const result = await executor.query(
    `SELECT * FROM project_launch_rules WHERE id = $1${lock}`,
    [id]
  );
  const rows = options.forUpdate ? result.rows : await hydrate(result.rows, executor);
  return rows[0] || null;
}

async function create(data, executor = db) {
  const result = await executor.query(
    `INSERT INTO project_launch_rules(
       chain_id, project_name, budget_per_trade, total_budget, slippage,
       allow_repeat_buy, max_repeat_buys, exit_strategy, exit_strategy_version,
       status, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      data.chain_id, data.project_name || null, data.budget_per_trade,
      data.total_budget, data.slippage, data.allow_repeat_buy,
      data.max_repeat_buys, data.exit_strategy, data.exit_strategy_version,
      data.status || 'active', data.expires_at || null
    ]
  );
  return result.rows[0];
}

async function update(id, data, executor = db) {
  const result = await executor.query(
    `UPDATE project_launch_rules
     SET project_name = $1, budget_per_trade = $2, total_budget = $3,
         slippage = $4, allow_repeat_buy = $5, max_repeat_buys = $6,
         exit_strategy = $7, exit_strategy_version = $8, expires_at = $9,
         updated_at = NOW()
     WHERE id = $10 RETURNING *`,
    [
      data.project_name || null, data.budget_per_trade, data.total_budget,
      data.slippage, data.allow_repeat_buy, data.max_repeat_buys,
      data.exit_strategy, data.exit_strategy_version, data.expires_at || null, id
    ]
  );
  return result.rows[0] || null;
}

async function updateStatus(id, status, executor = db) {
  const result = await executor.query(
    `UPDATE project_launch_rules
     SET status = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, status]
  );
  return result.rows[0] || null;
}

async function remove(id, executor = db) {
  const result = await executor.query(
    `DELETE FROM project_launch_rules
     WHERE id = $1 AND status IN('active','paused','expired')
     RETURNING id`,
    [id]
  );
  return result.rows.length > 0;
}

module.exports = { create, getById, hydrate, list, remove, update, updateStatus };
