const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');
const { runMigrations } = require('../lib/migrations');

test('P17 migrations install activation and observable compact arm persistence contracts', async () => {
  await runMigrations();
  const migration = await db.query(
    "SELECT 1 FROM schema_migrations WHERE name = '025_p17_arm_failure_observability.sql'"
  );
  assert.equal(migration.rows.length, 1);

  const columns = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ca_whitelist'
       AND column_name = ANY($1::text[])`,
    [[
      'live_activation_state', 'activation_version', 'activation_context_hash',
      'activation_error_code', 'activation_error_detail', 'activation_checked_at', 'activated_at'
    ]]
  );
  assert.equal(columns.rows.length, 7);

  const tables = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [['whitelist_activation_outbox', 'arm_preparations']]
  );
  assert.equal(tables.rows.length, 2);

  const armColumns = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'arm_preparations'
       AND column_name = ANY($1::text[])`,
    [['failed_at', 'failure_code', 'failure_detail']]
  );
  assert.equal(armColumns.rows.length, 3);

  const signalColumn = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'trade_signals'
       AND column_name = 'activation_wait_version'`
  );
  assert.equal(signalColumn.rows.length, 1);
});

test.after(async () => {
  await db.pool.end();
});
