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
  const existing = await db.query(
    `SELECT id FROM x_kol_accounts
     WHERE lower(regexp_replace(x_handle, '^@+', '')) = lower(regexp_replace($1, '^@+', ''))
     ORDER BY enabled DESC, id
     LIMIT 1`,
    [data.x_handle]
  );
  if (existing.rows[0]) {
    const updated = await db.query(
      `UPDATE x_kol_accounts
       SET x_user_id = $1, x_handle = $2, display_name = $3,
           chain_ids = $4, weight = $5, enabled = $6, updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        data.x_user_id || data.x_handle,
        data.x_handle,
        data.display_name || data.x_handle,
        data.chain_ids || [],
        data.weight || 5,
        data.enabled !== false,
        existing.rows[0].id
      ]
    );
    return updated.rows[0];
  }

  const res = await db.query(
    'INSERT INTO x_kol_accounts (x_user_id, x_handle, display_name, chain_ids, weight, enabled) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [data.x_user_id || data.x_handle, data.x_handle, data.display_name || data.x_handle, data.chain_ids || [], data.weight || 5, data.enabled !== false]
  );
  return res.rows[0];
}

async function update(id, data) {
  const res = await db.query(
    `UPDATE x_kol_accounts SET
       x_user_id = COALESCE($1, x_user_id),
       x_handle = COALESCE($2, x_handle),
       display_name = COALESCE($3, display_name),
       chain_ids = COALESCE($4, chain_ids),
       weight = COALESCE($5, weight),
       updated_at = NOW()
     WHERE id = $6
     RETURNING *`,
    [data.x_user_id, data.x_handle, data.display_name, data.chain_ids, data.weight, id]
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
