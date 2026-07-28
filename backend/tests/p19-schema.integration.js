const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');
const { runMigrations } = require('../lib/migrations');

test('P19 migration installs trace and reconciliation claim contracts', async () => {
  await runMigrations();
  const migration = await db.query(
    "SELECT 1 FROM schema_migrations WHERE name = '027_p19_low_latency_execution.sql'"
  );
  assert.equal(migration.rows.length, 1);

  const expected = {
    x_provider_events: [
      'trace_id', 'timing_json', 'swap_submitted_at', 'receive_to_submitted_ms'
    ],
    x_activities: ['trace_id'],
    trade_signals: ['trace_id'],
    trade_attempts: ['trace_id', 'timing_json'],
    trade_orders: [
      'reconciliation_claim_token', 'reconciliation_claimed_at', 'receipt_available_at'
    ]
  };
  for (const [table, columns] of Object.entries(expected)) {
    const result = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
         AND column_name = ANY($2::text[])`,
      [table, columns]
    );
    assert.equal(result.rows.length, columns.length, `${table} P19 columns`);
  }
});

test.after(async () => {
  await db.pool.end();
});
