const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const testDatabase = String(process.argv[2] || process.env.XBOT_TEST_DB_NAME || '').trim();
const productionDatabase = String(process.env.DB_NAME || '').trim();

if (!testDatabase || !/test/i.test(testDatabase) || testDatabase === productionDatabase) {
  throw new Error('P16 migration rehearsal requires a dedicated test database name');
}

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: testDatabase,
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || ''
});

const migrationsDirectory = path.resolve(__dirname, '../db/migrations');

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

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
    const actorOne = await client.query(
      `INSERT INTO x_kol_accounts(x_user_id, x_handle, display_name, chain_ids, enabled)
       VALUES ('p16-actor-one', 'P16ActorOne', 'P16 Actor One', ARRAY['eth'], true)
       RETURNING id`
    );
    const actorTwo = await client.query(
      `INSERT INTO x_kol_accounts(x_user_id, x_handle, display_name, chain_ids, enabled)
       VALUES ('p16-actor-two', '@P16ActorTwo', 'P16 Actor Two', ARRAY['eth'], true)
       RETURNING id`
    );
    const whitelist = await client.query(
      `INSERT INTO ca_whitelist(
         contract_address, chain_id, symbol, project_name, budget_per_trade,
         total_budget, spent_budget, auto_tp_pct, auto_sl_pct, slippage, status
       ) VALUES (
         '0x1111111111111111111111111111111111111111', 'eth', 'P16M',
         'P16 Migration Fixture', 0.005, 0.05, 0.005, 155, 35, 12, 'active'
       ) RETURNING id`
    );
    const mixedRelation = await client.query(
      `INSERT INTO x_signal_relations(
         whitelist_id, kol_id, target_x_handle, event_types, enabled
       ) VALUES ($1, $2, '@ProjectOfficial', ARRAY['tweet','quote','reply'], true)
       RETURNING id`,
      [whitelist.rows[0].id, actorOne.rows[0].id]
    );
    const tweetOnlyRelation = await client.query(
      `INSERT INTO x_signal_relations(
         whitelist_id, kol_id, target_x_handle, event_types, enabled
       ) VALUES ($1, $2, 'ProjectFounder', ARRAY['tweet'], false)
       RETURNING id`,
      [whitelist.rows[0].id, actorTwo.rows[0].id]
    );
    const activity = await client.query(
      `INSERT INTO x_activities(
         kol_id, kol_handle, activity_type, target_x_handle,
         provider_event_id, provider, processed
       ) VALUES ($1, 'p16actorone', 'tweet', 'projectofficial',
         'p16-migration-event', '6551', true) RETURNING id`,
      [actorOne.rows[0].id]
    );
    const signal = await client.query(
      `INSERT INTO trade_signals(
         activity_id, whitelist_id, kol_id, kol_handle, signal_type,
         canonical_key, execution_mode, status, matched_relation_ids
       ) VALUES ($1, $2, $3, 'p16actorone', 'handle_match',
         'p16-migration-signal', 'live', 'executed', ARRAY[$4]::bigint[])
       RETURNING id`,
      [activity.rows[0].id, whitelist.rows[0].id, actorOne.rows[0].id, mixedRelation.rows[0].id]
    );
    const position = await client.query(
      `INSERT INTO positions(
         signal_id, whitelist_id, contract_address, chain_id, symbol,
         amount_in, amount_out, buy_tx_hash, buy_order_id, execution_mode,
         status, opened_at
       ) VALUES ($1, $2, '0x1111111111111111111111111111111111111111',
         'eth', 'P16M', 0.005, 1000, 'P16_TEST_TX',
         'p16-migration-order', 'live', 'open_protected', NOW()) RETURNING id`,
      [signal.rows[0].id, whitelist.rows[0].id]
    );
    const intent = await client.query(
      `INSERT INTO trade_intents(
         source_key, scope_key, side, signal_id, position_id, whitelist_id,
         chain, wallet_address, contract_address, wallet_lane_key, status,
         principal_amount_raw, principal_amount_display, config_snapshot_json,
         confirmation_source, completed_at
       ) VALUES (
         'p16-migration-source', 'p16-migration-scope', 'buy', $1, $2, $3,
         'eth', '0x2222222222222222222222222222222222222222',
         '0x1111111111111111111111111111111111111111',
         'eth:0x2222222222222222222222222222222222222222', 'confirmed',
         '5000000000000000', 0.005, '{"fixture":true}', 'provider', NOW()
       ) RETURNING id`,
      [signal.rows[0].id, position.rows[0].id, whitelist.rows[0].id]
    );
    const attempt = await client.query(
      `INSERT INTO trade_attempts(
         signal_id, whitelist_id, position_id, intent_id, attempt_no, side,
         idempotency_key, chain, wallet_address, input_token, output_token,
         input_amount_raw, input_amount_display, output_amount_raw,
         output_amount_display, status, request_fingerprint, metadata,
         submitted_at, confirmed_at
       ) VALUES ($1, $2, $3, $4, 1, 'buy', 'p16-migration-attempt', 'eth',
         '0x2222222222222222222222222222222222222222', 'ETH',
         '0x1111111111111111111111111111111111111111', '5000000000000000',
         0.005, '1000000000000000000000', 1000, 'confirmed',
         'p16-migration-fingerprint', '{"fixture":true}', NOW(), NOW())
       RETURNING id`,
      [signal.rows[0].id, whitelist.rows[0].id, position.rows[0].id, intent.rows[0].id]
    );
    const order = await client.query(
      `INSERT INTO trade_orders(
         attempt_id, provider_order_id, tx_hash, provider_status,
         normalized_status, input_token, output_token, input_amount_raw,
         output_amount_raw, input_amount_display, output_amount_display,
         gas_native, submitted_at, confirmed_at
       ) VALUES ($1, 'p16-migration-order', 'P16_TEST_TX', 'success',
         'confirmed', 'ETH', '0x1111111111111111111111111111111111111111',
         '5000000000000000', '1000000000000000000000', 0.005, 1000,
         0.0002, NOW(), NOW()) RETURNING id`,
      [attempt.rows[0].id]
    );
    await client.query('COMMIT');
    return {
      actorOne: actorOne.rows[0].id,
      actorTwo: actorTwo.rows[0].id,
      whitelist: whitelist.rows[0].id,
      mixedRelation: mixedRelation.rows[0].id,
      tweetOnlyRelation: tweetOnlyRelation.rows[0].id,
      signal: signal.rows[0].id,
      position: position.rows[0].id,
      attempt: attempt.rows[0].id,
      order: order.rows[0].id
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
    throw new Error(`P16 migration rehearsal database must be empty: ${testDatabase}`);
  }

  await client.query(`
    CREATE TABLE schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  const migrationNames = fs.readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of migrationNames.filter((name) => name < '017_')) {
    await applyMigration(name);
  }

  const fixture = await createHistoricalFixture();
  const unchangedTables = {
    positions: fixture.position,
    trade_attempts: fixture.attempt,
    trade_orders: fixture.order
  };
  const before = {};
  for (const [table, id] of Object.entries(unchangedTables)) {
    const columns = await getColumns(table);
    before[table] = { columns, row: await getRow(table, id, columns), count: await getCount(table) };
  }
  const signalColumns = (await getColumns('trade_signals'))
    .filter((column) => !['matched_relation_ids', 'updated_at'].includes(column));
  const signalBefore = await getRow('trade_signals', fixture.signal, signalColumns);
  const watchOutboxBefore = await getCount('x_watch_sync_outbox');

  await applyMigration('017_p16_whitelist_workspace_research_and_exit_strategy.sql');

  for (const [table, id] of Object.entries(unchangedTables)) {
    assert.deepEqual(await getRow(table, id, before[table].columns), before[table].row);
    assert.equal(await getCount(table), before[table].count);
  }
  assert.deepEqual(await getRow('trade_signals', fixture.signal, signalColumns), signalBefore);

  const whitelist = await client.query(
    `SELECT exit_strategy, exit_strategy_version
     FROM ca_whitelist WHERE id = $1`,
    [fixture.whitelist]
  );
  assert.deepEqual(whitelist.rows[0], {
    exit_strategy: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [
        { type: 'take_profit', trigger_pct: 155, sell_pct: 100 },
        { type: 'stop_loss', drop_pct: 35, sell_pct: 100 }
      ]
    },
    exit_strategy_version: 1
  });

  const relations = await client.query(
    `SELECT id, event_types FROM x_signal_relations
     WHERE whitelist_id = $1 ORDER BY id`,
    [fixture.whitelist]
  );
  assert.deepEqual(relations.rows, [
    { id: String(fixture.mixedRelation), event_types: ['quote', 'reply'] }
  ]);

  const sourceRules = await client.query(
    `SELECT actor_id, event_types, match_mode, enabled
     FROM x_signal_source_rules WHERE whitelist_id = $1 ORDER BY actor_id`,
    [fixture.whitelist]
  );
  assert.deepEqual(sourceRules.rows, [
    { actor_id: fixture.actorOne, event_types: ['tweet'], match_mode: 'ca_or_ticker', enabled: true },
    { actor_id: fixture.actorTwo, event_types: ['tweet'], match_mode: 'ca_or_ticker', enabled: false }
  ]);

  await applyMigration('018_p16_final_product_convergence.sql');
  await applyMigration('019_p16_research_audit_closure.sql');
  for (const [table, id] of Object.entries(unchangedTables)) {
    assert.deepEqual(await getRow(table, id, before[table].columns), before[table].row);
    assert.equal(await getCount(table), before[table].count);
  }
  const finalSourceRules = await client.query(
    `SELECT actor_id, event_types, match_mode, source_kind, enabled
     FROM x_signal_source_rules WHERE whitelist_id = $1 ORDER BY actor_id`,
    [fixture.whitelist]
  );
  assert.deepEqual(finalSourceRules.rows, [
    { actor_id: fixture.actorOne, event_types: ['tweet'], match_mode: 'ca_only', source_kind: 'project', enabled: true },
    { actor_id: fixture.actorTwo, event_types: ['tweet'], match_mode: 'ca_only', source_kind: 'project', enabled: false }
  ]);
  assert.equal(await getCount('p16_source_rule_match_mode_backup'), 2);
  assert.equal(await getCount('research_jobs'), 0);
  assert.equal(await getCount('research_job_items'), 0);
  assert.equal((await getColumns('research_jobs')).includes('concurrency_limit'), true);
  assert.equal((await getColumns('research_jobs')).includes('cancelled_at'), true);

  const migratedSignal = await client.query(
    `SELECT matched_relation_ids, matched_source_rule_ids
     FROM trade_signals WHERE id = $1`,
    [fixture.signal]
  );
  assert.deepEqual(migratedSignal.rows[0].matched_relation_ids, []);
  assert.equal(migratedSignal.rows[0].matched_source_rule_ids.length, 1);
  assert.equal(
    migratedSignal.rows[0].matched_source_rule_ids[0],
    String((await client.query(
      `SELECT id FROM x_signal_source_rules
       WHERE whitelist_id = $1 AND actor_id = $2`,
      [fixture.whitelist, fixture.actorOne]
    )).rows[0].id)
  );

  const projectAccounts = await client.query(
    `SELECT handle, usage FROM whitelist_x_accounts
     WHERE whitelist_id = $1 ORDER BY handle`,
    [fixture.whitelist]
  );
  assert.deepEqual(projectAccounts.rows, [
    { handle: 'projectfounder', usage: 'interaction_target' },
    { handle: 'projectofficial', usage: 'interaction_target' }
  ]);
  assert.equal(await getCount('x_actor_directory'), 2);
  assert.equal(await getCount('x_watch_sync_outbox'), watchOutboxBefore);

  const { upsertActorCandidate } = require('../domains/research/service');
  await upsertActorCandidate({
    handle: 'p16researcher',
    display_name: 'P16 Researcher',
    role: 'founder',
    organization: 'P16',
    source: 'xai',
    confidence: 'medium',
    verified: false,
    evidence: [{ label: 'first' }]
  }, 'eth', client);
  await upsertActorCandidate({
    handle: 'p16researcher',
    display_name: 'P16 Researcher',
    role: 'ceo',
    organization: 'P16',
    source: 'gmgn',
    confidence: 'verified',
    verified: true,
    evidence: [{ label: 'verified' }]
  }, 'base', client);
  const candidate = await client.query(
    `SELECT role_types, chain_ids, source_types, confidence, is_verified
     FROM x_actor_directory WHERE lower(handle) = 'p16researcher'`
  );
  assert.deepEqual(candidate.rows, [{
    role_types: ['ceo', 'founder'],
    chain_ids: ['base', 'eth'],
    source_types: ['gmgn', 'xai'],
    confidence: 'verified',
    is_verified: true
  }]);

  await applyMigration('020_p16_1_prelaunch_project_monitor.sql');
  for (const [table, id] of Object.entries(unchangedTables)) {
    assert.deepEqual(await getRow(table, id, before[table].columns), before[table].row);
    assert.equal(await getCount(table), before[table].count);
  }
  assert.deepEqual(await getRow('trade_signals', fixture.signal, signalColumns), signalBefore);
  const launchTables = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [[
      'project_launch_discoveries',
      'project_launch_relations',
      'project_launch_rules',
      'project_launch_sources'
    ]]
  );
  assert.deepEqual(launchTables.rows.map((row) => row.table_name), [
    'project_launch_discoveries',
    'project_launch_relations',
    'project_launch_rules',
    'project_launch_sources'
  ]);
  assert.equal((await getColumns('ca_whitelist')).includes('launch_rule_id'), true);
  const postLaunchSources = await client.query(
    `SELECT actor_id, source_kind, enabled
     FROM x_signal_source_rules WHERE whitelist_id = $1 ORDER BY actor_id`,
    [fixture.whitelist]
  );
  assert.deepEqual(postLaunchSources.rows, [
    { actor_id: fixture.actorOne, source_kind: 'project', enabled: false },
    { actor_id: fixture.actorTwo, source_kind: 'project', enabled: false }
  ]);
  const preservedSourceIdentities = await client.query(
    `SELECT handle, role, usage FROM whitelist_x_accounts
     WHERE whitelist_id = $1 AND usage = 'identity' ORDER BY handle`,
    [fixture.whitelist]
  );
  assert.deepEqual(preservedSourceIdentities.rows, [
    { handle: 'p16actorone', role: 'project', usage: 'identity' },
    { handle: 'p16actortwo', role: 'project', usage: 'identity' }
  ]);
  assert.equal(await getCount('project_launch_rules'), 0);
  assert.equal(await getCount('project_launch_sources'), 0);
  assert.equal(await getCount('project_launch_relations'), 0);
  assert.equal(await getCount('project_launch_discoveries'), 0);
  assert.equal(await getCount('x_watch_sync_outbox'), watchOutboxBefore);

  process.stdout.write(`${JSON.stringify({
    database: testDatabase,
    migrations: [
      '017_p16_whitelist_workspace_research_and_exit_strategy.sql',
      '018_p16_final_product_convergence.sql',
      '019_p16_research_audit_closure.sql',
      '020_p16_1_prelaunch_project_monitor.sql'
    ],
    unchangedTradeTables: Object.keys(unchangedTables),
    legacyExitStrategyEquivalent: true,
    legacyTweetSignalEvidenceMigrated: true,
    projectTargetsPreserved: projectAccounts.rows.length,
    projectSourceIdentitiesPreserved: preservedSourceIdentities.rows.length,
    launchMonitorTables: launchTables.rows.length,
    watchOutboxWrites: 0,
    researchActorUpsert: true,
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
