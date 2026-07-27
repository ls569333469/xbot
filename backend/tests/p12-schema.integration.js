const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');
const { runMigrations } = require('../lib/migrations');
const intentRepository = require('../domains/trade/trade-intent-repository');
const { createTradeIntent } = require('./p12-fixtures');

const createdIntentIds = [];

test('P12 additive migration is applied only to the dedicated test database', async () => {
  await runMigrations();
  const migration = await db.query(
    "SELECT 1 FROM schema_migrations WHERE name = '013_p12_trade_intents_retry.sql'"
  );
  assert.equal(migration.rows.length, 1);
  const tables = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [[
      'trade_intents', 'trade_intent_sources', 'trade_failure_evidence',
      'trade_retry_decisions', 'trade_reconciliation_incidents',
      'wallet_write_lanes', 'chain_trade_circuits'
    ]]
  );
  assert.equal(tables.rows.length, 7);
  const attemptColumns = await db.query(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'trade_attempts'
       AND column_name = ANY($1::text[])`,
    [['intent_id', 'attempt_no', 'pre_submit_snapshot_json', 'funds_write_started_at']]
  );
  assert.equal(attemptColumns.rows.length, 4);
  assert.equal(attemptColumns.rows.find(row => row.column_name === 'intent_id').is_nullable, 'NO');
});

test('two retry workers claim different due intents with SKIP LOCKED', async () => {
  const first = await createTradeIntent(db, {
    suffix: `worker-a-${Date.now()}`,
    status: 'retry_scheduled',
    maxRetries: 2,
    expiresAt: new Date(Date.now() + 60000)
  });
  const second = await createTradeIntent(db, {
    suffix: `worker-b-${Date.now()}`,
    status: 'retry_scheduled',
    maxRetries: 2,
    expiresAt: new Date(Date.now() + 60000)
  });
  createdIntentIds.push(first.id, second.id);
  await db.query(
    'UPDATE trade_intents SET next_retry_at = NOW() WHERE id = ANY($1::bigint[])',
    [[first.id, second.id]]
  );
  const [left, right] = await Promise.all([
    intentRepository.claimDueRetries(1, db),
    intentRepository.claimDueRetries(1, db)
  ]);
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
  assert.notEqual(String(left[0].id), String(right[0].id));
  assert.deepEqual(
    new Set([String(left[0].id), String(right[0].id)]),
    new Set([String(first.id), String(second.id)])
  );
});

test.after(async () => {
  if (createdIntentIds.length > 0) {
    await db.query('DELETE FROM trade_intents WHERE id = ANY($1::bigint[])', [createdIntentIds]);
  }
  await db.pool.end();
});
