const db = require('../../lib/db');

async function get(key) {
  const res = await db.query('SELECT value_json FROM config WHERE key = $1', [key]);
  return res.rows[0] ? res.rows[0].value_json : null;
}

async function set(key, value) {
  const res = await db.query(
    'INSERT INTO config (key, value_json) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW() RETURNING *',
    [key, JSON.stringify(value)]
  );
  return res.rows[0].value_json;
}

module.exports = { get, set };
