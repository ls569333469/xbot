const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const testDatabase = String(process.env.XBOT_TEST_DB_NAME || '').trim();
const productionDatabase = String(process.env.DB_NAME || '').trim();

if (!testDatabase || !/test/i.test(testDatabase) || testDatabase === productionDatabase) {
  throw new Error('P12 migration rehearsal requires a dedicated XBOT_TEST_DB_NAME');
}

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: testDatabase,
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || ''
});

const dbDirectory = path.resolve(__dirname, '../db');
const migrationsDirectory = path.join(dbDirectory, 'migrations');

async function applyMigration(name) {
  const sql = fs.readFileSync(path.join(migrationsDirectory, name), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function getColumns(table) {
  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return result.rows.map((row) => row.column_name);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function getRow(table, id, columns) {
  const projection = columns.map(quoteIdentifier).join(', ');
  const result = await client.query(
    `SELECT to_jsonb(snapshot) AS value
     FROM (SELECT ${projection} FROM ${quoteIdentifier(table)} WHERE id = $1) AS snapshot`,
    [id]
  );
  assert.equal(result.rows.length, 1, `missing ${table} fixture row`);
  return result.rows[0].value;
}

async function getCount(table) {
  const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(table)}`);
  return result.rows[0].count;
}

async function createHistoricalFixture() {
  await client.query('BEGIN');
  try {
    const kol = await client.query(
      `INSERT INTO x_kol_accounts(x_user_id, x_handle, enabled)
       VALUES ('p12-migration-kol', 'p12migrationkol', true) RETURNING id`
    );
    const whitelist = await client.query(
      `INSERT INTO ca_whitelist(
         contract_address, chain_id, symbol, project_name,
         budget_per_trade, total_budget, spent_budget, slippage, status
       ) VALUES (
         'P12_TEST_TOKEN', 'eth', 'P12M',
         'P12 Migration Fixture', 0.005, 0.05, 0.005, 10, 'active'
       ) RETURNING id`
    );
    const activity = await client.query(
      `INSERT INTO x_activities(
         kol_id, kol_handle, activity_type, target_x_handle,
         provider_event_id, provider, processed
       ) VALUES ($1, 'p12migrationkol', 'reply', 'p12migrationproject',
         'p12-migration-event', '6551', true) RETURNING id`,
      [kol.rows[0].id]
    );
    const signal = await client.query(
      `INSERT INTO trade_signals(
         activity_id, whitelist_id, kol_id, kol_handle, signal_type,
         canonical_key, execution_mode, status, matched_relation_ids
       ) VALUES ($1, $2, $3, 'p12migrationkol', 'handle_match',
         'p12-migration-signal', 'live', 'executed', ARRAY[1]::bigint[])
       RETURNING id`,
      [activity.rows[0].id, whitelist.rows[0].id, kol.rows[0].id]
    );
    const position = await client.query(
      `INSERT INTO positions(
         signal_id, whitelist_id, contract_address, chain_id, symbol,
         amount_in, amount_out, buy_tx_hash, buy_order_id, execution_mode,
         status, opened_at
       ) VALUES ($1, $2, 'P12_TEST_TOKEN',
         'eth', 'P12M', 0.005, 1000, 'P12_TEST_TX',
         'p12-migration-order', 'live', 'open_protected', NOW()) RETURNING id`,
      [signal.rows[0].id, whitelist.rows[0].id]
    );
    const attempt = await client.query(
      `INSERT INTO trade_attempts(
         signal_id, whitelist_id, position_id, side, idempotency_key, chain,
         wallet_address, input_token, output_token, input_amount_raw,
         input_amount_display, output_amount_raw, output_amount_display,
         status, request_fingerprint, metadata, submitted_at, confirmed_at
       ) VALUES ($1, $2, $3, 'buy', 'p12-migration-attempt', 'eth',
         'P12_TEST_WALLET', 'P12_TEST_NATIVE', 'P12_TEST_TOKEN',
         '5000000000000000', 0.005, '1000000000000000000000', 1000,
         'confirmed', 'p12-migration-fingerprint', '{"fixture":true}', NOW(), NOW())
       RETURNING id`,
      [signal.rows[0].id, whitelist.rows[0].id, position.rows[0].id]
    );
    const order = await client.query(
      `INSERT INTO trade_orders(
         attempt_id, provider_order_id, tx_hash, provider_status,
         normalized_status, input_token, output_token, input_amount_raw,
         output_amount_raw, input_amount_display, output_amount_display,
         gas_native, submitted_at, confirmed_at
       ) VALUES ($1, 'p12-migration-order', 'P12_TEST_TX', 'success',
         'confirmed', 'P12_TEST_NATIVE', 'P12_TEST_TOKEN',
         '5000000000000000', '1000000000000000000000', 0.005, 1000,
         0.0002, NOW(), NOW()) RETURNING id`,
      [attempt.rows[0].id]
    );
    const lot = await client.query(
      `INSERT INTO position_lots(
         position_id, buy_order_id, chain, wallet_address, token_address,
         token_decimals, opened_amount_raw, remaining_amount_raw,
         cost_native, fee_native
       ) VALUES ($1, $2, 'eth', 'P12_TEST_WALLET', 'P12_TEST_TOKEN', 18,
         '1000000000000000000000', '1000000000000000000000', 0.005, 0.0002)
       RETURNING id`,
      [position.rows[0].id, order.rows[0].id]
    );
    const receipt = await client.query(
      `INSERT INTO chain_receipts(
         order_id, chain, tx_hash, block_ref, receipt_status,
         confirmations, transfer_json, raw_receipt_json, verified_at
       ) VALUES ($1, 'eth', 'P12_TEST_TX', '22000000', 'confirmed',
         12, '[]', '{"status":1}', NOW()) RETURNING id`,
      [order.rows[0].id]
    );
    const strategy = await client.query(
      `INSERT INTO strategy_groups(
         position_id, attempt_id, provider_order_id, total_amount_raw,
         status, requested_params, provider_params
       ) VALUES ($1, $2, 'p12-migration-strategy',
         '1000000000000000000000', 'running', '{"tp":100}', '{}') RETURNING id`,
      [position.rows[0].id, attempt.rows[0].id]
    );
    const leg = await client.query(
      `INSERT INTO strategy_legs(
         group_id, provider_order_id, leg_index, order_type, amount_raw,
         trigger_value, status
       ) VALUES ($1, 'p12-migration-strategy-leg', 0, 'take_profit',
         '1000000000000000000000', '100', 'running') RETURNING id`,
      [strategy.rows[0].id]
    );
    const reservation = await client.query(
      `INSERT INTO budget_reservations(
         attempt_id, whitelist_id, chain, native_symbol, amount_native,
         fee_native, amount_usd_snapshot, status, committed_at
       ) VALUES ($1, $2, 'eth', 'ETH', 0.005, 0.0002, 20, 'committed', NOW())
       RETURNING id`,
      [attempt.rows[0].id, whitelist.rows[0].id]
    );
    const ledger = await client.query(
      `INSERT INTO budget_ledger(
         reservation_id, attempt_id, whitelist_id, chain, entry_type,
         amount_native, fee_native, amount_usd_snapshot, reason
       ) VALUES ($1, $2, $3, 'eth', 'commit', 0.005, 0.0002, 20,
         'p12 migration fixture') RETURNING id`,
      [reservation.rows[0].id, attempt.rows[0].id, whitelist.rows[0].id]
    );
    const event = await client.query(
      `INSERT INTO trade_attempt_events(attempt_id, to_status, reason, actor, summary)
       VALUES ($1, 'confirmed', 'p12 migration fixture', 'test', '{"fixture":true}')
       RETURNING id`,
      [attempt.rows[0].id]
    );
    const outbox = await client.query(
      `INSERT INTO notification_outbox(topic, aggregate_type, aggregate_id, payload)
       VALUES ('p12_fixture', 'trade_attempt', $1, '{"fixture":true}') RETURNING id`,
      [String(attempt.rows[0].id)]
    );
    await client.query('COMMIT');
    return {
      ca_whitelist: whitelist.rows[0].id,
      trade_signals: signal.rows[0].id,
      positions: position.rows[0].id,
      trade_attempts: attempt.rows[0].id,
      trade_orders: order.rows[0].id,
      position_lots: lot.rows[0].id,
      chain_receipts: receipt.rows[0].id,
      strategy_groups: strategy.rows[0].id,
      strategy_legs: leg.rows[0].id,
      budget_reservations: reservation.rows[0].id,
      budget_ledger: ledger.rows[0].id,
      trade_attempt_events: event.rows[0].id,
      notification_outbox: outbox.rows[0].id
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  await client.connect();
  const existing = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  if (existing.rows[0].count !== 0) {
    throw new Error(`P12 migration rehearsal database must be empty: ${testDatabase}`);
  }

  await client.query(fs.readFileSync(path.join(dbDirectory, 'init.sql'), 'utf8'));
  await client.query(fs.readFileSync(path.join(dbDirectory, 'seed.sql'), 'utf8'));
  await client.query(`
    CREATE TABLE schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  const migrationNames = fs.readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of migrationNames.filter((name) => name < '013_')) {
    await applyMigration(name);
  }

  const fixtureIds = await createHistoricalFixture();
  const tables = Object.keys(fixtureIds);
  const columnsByTable = {};
  const rowsBefore = {};
  const countsBefore = {};
  for (const table of tables) {
    columnsByTable[table] = await getColumns(table);
    rowsBefore[table] = await getRow(table, fixtureIds[table], columnsByTable[table]);
    countsBefore[table] = await getCount(table);
  }
  const readinessBefore = await getCount('chain_live_readiness');

  await applyMigration('013_p12_trade_intents_retry.sql');

  for (const table of tables) {
    assert.deepEqual(
      await getRow(table, fixtureIds[table], columnsByTable[table]),
      rowsBefore[table],
      `${table} legacy columns changed during migration`
    );
    assert.equal(await getCount(table), countsBefore[table], `${table} row count changed`);
  }

  const attempt = await client.query(
    `SELECT attempt.intent_id, attempt.attempt_no, intent.source_key,
            intent.status, intent.signal_id, intent.position_id
     FROM trade_attempts AS attempt
     JOIN trade_intents AS intent ON intent.id = attempt.intent_id
     WHERE attempt.id = $1`,
    [fixtureIds.trade_attempts]
  );
  assert.equal(attempt.rows.length, 1);
  assert.equal(attempt.rows[0].attempt_no, 1);
  assert.equal(attempt.rows[0].source_key, `buy:signal:${fixtureIds.trade_signals}`);
  assert.equal(attempt.rows[0].status, 'confirmed');
  assert.equal(attempt.rows[0].signal_id, fixtureIds.trade_signals);
  assert.equal(attempt.rows[0].position_id, fixtureIds.positions);

  const reservation = await client.query(
    'SELECT intent_id FROM budget_reservations WHERE id = $1',
    [fixtureIds.budget_reservations]
  );
  const ledger = await client.query(
    'SELECT intent_id FROM budget_ledger WHERE id = $1',
    [fixtureIds.budget_ledger]
  );
  assert.equal(String(reservation.rows[0].intent_id), String(attempt.rows[0].intent_id));
  assert.equal(String(ledger.rows[0].intent_id), String(attempt.rows[0].intent_id));
  assert.equal(await getCount('chain_live_readiness'), readinessBefore + 1);

  const constraints = await client.query(
    `SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conname = ANY($1::text[])`,
    [[
      'trade_attempts_chain_check', 'position_lots_chain_check',
      'chain_receipts_chain_check', 'budget_reservations_chain_check',
      'budget_ledger_chain_check', 'chain_live_readiness_chain_check',
      'shadow_trade_evaluations_chain_check', 'chain_readiness_evidence_chain_check'
    ]]
  );
  assert.equal(constraints.rows.length, 8);
  for (const constraint of constraints.rows) {
    assert.match(constraint.definition, /robinhood/);
  }

  await applyMigration('014_p13_remove_legacy_monitor_config.sql');
  await applyMigration('015_p13_relation_events_and_watch_outbox.sql');
  await applyMigration('016_p14_chain_approval_and_acceptance_scope.sql');

  const p13Schema = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'x_watch_sync_outbox'`
  );
  assert.equal(p13Schema.rows.length, 1);
  const relationColumns = await getColumns('x_signal_relations');
  assert.ok(relationColumns.includes('event_types'));
  const legacyConfig = await client.query(
    "SELECT 1 FROM config WHERE key = 'x_monitor_config'"
  );
  assert.equal(legacyConfig.rows.length, 0);

  const p14ScopeTable = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'live_acceptance_scopes'`
  );
  assert.equal(p14ScopeTable.rows.length, 1);
  const evidenceColumns = await getColumns('chain_readiness_evidence');
  assert.ok(evidenceColumns.includes('context_hash'));
  assert.ok(evidenceColumns.includes('valid_until'));
  const robinhoodReadiness = await client.query(
    `SELECT implemented, contract_tested, live_enabled
     FROM chain_live_readiness WHERE chain = 'robinhood'`
  );
  assert.deepEqual(robinhoodReadiness.rows[0], {
    implemented: true,
    contract_tested: false,
    live_enabled: false
  });

  const migration = await client.query(
    "SELECT applied_at FROM schema_migrations WHERE name = '013_p12_trade_intents_retry.sql'"
  );
  assert.equal(migration.rows.length, 1);

  process.stdout.write(`${JSON.stringify({
    database: testDatabase,
    migrations: [
      '013_p12_trade_intents_retry.sql',
      '014_p13_remove_legacy_monitor_config.sql',
      '015_p13_relation_events_and_watch_outbox.sql',
      '016_p14_chain_approval_and_acceptance_scope.sql'
    ],
    historicalAttempts: 1,
    historicalIntents: 1,
    unchangedTables: tables.length,
    robinhoodChainChecks: constraints.rows.length,
    watchOutbox: true,
    p14AcceptanceScope: true,
    outboxRowsBefore: countsBefore.notification_outbox,
    outboxRowsAfter: await getCount('notification_outbox'),
    result: 'passed'
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end().catch(() => {});
  });
