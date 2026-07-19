const db = require('../../lib/db');

async function getAll() {
  const res = await db.query('SELECT * FROM x_kol_accounts ORDER BY weight DESC');
  return res.rows;
}

async function getById(id) {
  const res = await db.query('SELECT * FROM x_kol_accounts WHERE id = $1', [id]);
  return res.rows[0];
}

async function create(data) {
  const res = await db.query(
    'INSERT INTO x_kol_accounts (x_user_id, x_handle, display_name, chain_ids, weight, enabled) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [data.x_user_id || data.x_handle, data.x_handle, data.display_name || data.x_handle, data.chain_ids || [], data.weight || 5, data.enabled !== false]
  );
  return res.rows[0];
}

async function update(id, data) {
  const res = await db.query(
    'UPDATE x_kol_accounts SET x_handle = COALESCE($1, x_handle), display_name = COALESCE($2, display_name), chain_ids = COALESCE($3, chain_ids), weight = COALESCE($4, weight), updated_at = NOW() WHERE id = $5 RETURNING *',
    [data.x_handle, data.display_name, data.chain_ids, data.weight, id]
  );
  return res.rows[0];
}

async function toggle(id) {
  const res = await db.query(
    'UPDATE x_kol_accounts SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1 RETURNING *',
    [id]
  );
  return res.rows[0];
}

async function remove(id) {
  await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [id]);
  return true;
}

async function getActivities(id, limit) {
  const res = await db.query('SELECT * FROM x_activities WHERE kol_id = $1 ORDER BY created_at DESC LIMIT $2', [id, limit || 20]);
  return res.rows;
}

module.exports = { getAll, getById, create, update, toggle, remove, getActivities };
