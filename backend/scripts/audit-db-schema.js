const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const database = String(process.env.DB_NAME || '').trim();
const testDatabase = String(process.env.XBOT_TEST_DB_NAME || '').trim();
const productionDatabase = String(process.env.XBOT_PRODUCTION_DB_NAME || '').trim();

if (!database || !testDatabase || database !== testDatabase || !/test/i.test(database)
    || (productionDatabase && database === productionDatabase)) {
  throw new Error('Schema audit requires DB_NAME and XBOT_TEST_DB_NAME to name the same dedicated test database');
}

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || '',
  database
});

async function requireColumns(table, expected) {
  const result = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
       AND column_name = ANY($2::text[])`,
    [table, expected]
  );
  const found = new Set(result.rows.map((row) => row.column_name));
  const missing = expected.filter((column) => !found.has(column));
  if (missing.length > 0) throw new Error(`${table} is missing columns: ${missing.join(', ')}`);
}

async function main() {
  await client.connect();
  const migration = await client.query(
    "SELECT name FROM schema_migrations WHERE name = '025_p17_arm_failure_observability.sql'"
  );
  if (migration.rows.length !== 1) throw new Error('Migration 025 is not applied');

  await requireColumns('ca_whitelist', [
    'live_activation_state', 'activation_version', 'activation_context_hash',
    'activation_error_code', 'activation_error_detail', 'activation_checked_at', 'activated_at'
  ]);
  await requireColumns('trade_signals', ['activation_wait_version']);
  await requireColumns('arm_preparations', [
    'token_hash', 'configuration_fingerprint', 'policy_fingerprint',
    'activation_versions', 'compact_summary', 'status', 'expires_at', 'consumed_at',
    'failed_at', 'failure_code', 'failure_detail'
  ]);
  await requireColumns('whitelist_activation_outbox', [
    'whitelist_id', 'desired_version', 'status', 'attempt_count', 'locked_at'
  ]);

  const invalidActivation = await client.query(
    `SELECT COUNT(*)::int AS count FROM ca_whitelist
     WHERE activation_version < 1
        OR live_activation_state NOT IN ('syncing','live_ready','sync_failed')`
  );
  if (invalidActivation.rows[0].count !== 0) throw new Error('Invalid whitelist activation rows found');

  process.stdout.write(`SCHEMA_AUDIT_OK=${database}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end().catch(() => {});
  });
