const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const logger = require('./logger');

const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');
const MIGRATION_LOCK = 'xbot:schema:migrations';
const MANIFEST_MIGRATION = '044_p27_migration_manifest.sql';
const LEGACY_LAST_MIGRATION = '043_p26_local_rpc_provider_status.sql';

class MigrationBaselineRequiredError extends Error {
  constructor(applied = []) {
    super('P27 migration baseline must be explicitly imported before migrations 045+ can run');
    this.name = 'MigrationBaselineRequiredError';
    this.code = 'MIGRATION_BASELINE_REQUIRED';
    this.applied = applied;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function migrationFiles(directory = MIGRATIONS_DIR) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(directory, name), 'utf8');
      return { name, sql, checksum: sha256(Buffer.from(sql, 'utf8')) };
    });
}

async function migrationColumns(client) {
  const result = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`
  );
  return new Set(result.rows.map((row) => row.column_name));
}

async function verifyChecksums(client, files) {
  const rows = await client.query(
    `SELECT name, checksum_sha256, migration_manifest_id
     FROM schema_migrations ORDER BY name`
  );
  const byName = new Map(files.map((file) => [file.name, file]));
  for (const row of rows.rows) {
    const file = byName.get(row.name);
    if (!file) {
      const error = new Error(`Applied migration file is missing: ${row.name}`);
      error.code = 'MIGRATION_FILE_MISSING';
      throw error;
    }
    if (!row.checksum_sha256) {
      throw new MigrationBaselineRequiredError([]);
    }
    if (row.checksum_sha256 !== file.checksum) {
      const error = new Error(`Applied migration checksum drift: ${row.name}`);
      error.code = 'MIGRATION_CHECKSUM_MISMATCH';
      error.migration = row.name;
      throw error;
    }
    if (row.name <= LEGACY_LAST_MIGRATION && !row.migration_manifest_id) {
      throw new MigrationBaselineRequiredError([]);
    }
  }
}

async function insertMigrationRecord(client, file) {
  if (file.name < MANIFEST_MIGRATION) {
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file.name]);
    return;
  }
  await client.query(
    `INSERT INTO schema_migrations (name, checksum_sha256, release_sha)
     VALUES ($1, $2, NULLIF($3, ''))`,
    [file.name, file.checksum, String(process.env.XBOT_RELEASE_SHA || process.env.XBOT_CODE_VERSION || '')]
  );
}

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

    const files = migrationFiles();
    const applied = [];
    let columns = await migrationColumns(client);

    for (const file of files) {
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file.name]);
      if (exists.rows.length > 0) continue;

      if (file.name > MANIFEST_MIGRATION && !columns.has('checksum_sha256')) {
        throw new MigrationBaselineRequiredError(applied);
      }
      if (file.name > MANIFEST_MIGRATION) {
        await verifyChecksums(client, files);
      }

      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        if (file.name === MANIFEST_MIGRATION) columns = await migrationColumns(client);
        await insertMigrationRecord(client, file);
        await client.query('COMMIT');
        applied.push(file.name);
        logger.info('migrations', `Applied migration ${file.name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }

      if (file.name === MANIFEST_MIGRATION) {
        throw new MigrationBaselineRequiredError(applied);
      }
    }

    if (columns.has('checksum_sha256')) await verifyChecksums(client, files);
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

module.exports = {
  LEGACY_LAST_MIGRATION,
  MANIFEST_MIGRATION,
  MIGRATION_LOCK,
  MIGRATIONS_DIR,
  MigrationBaselineRequiredError,
  migrationFiles,
  runMigrations,
  sha256,
  verifyChecksums
};
