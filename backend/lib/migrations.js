const fs = require('fs');
const path = require('path');
const db = require('./db');
const logger = require('./logger');

const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');
const MIGRATION_LOCK = 'xbot:schema:migrations';

async function runMigrations() {
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    if (!fs.existsSync(MIGRATIONS_DIR)) return [];

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const applied = [];

    for (const name of files) {
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (exists.rows.length > 0) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        applied.push(name);
        logger.info('migrations', `Applied migration ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

module.exports = { MIGRATION_LOCK, runMigrations };
