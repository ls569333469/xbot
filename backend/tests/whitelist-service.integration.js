const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('./integration-guard');
const db = require('../lib/db');
const whitelistService = require('../domains/whitelist/service');
const { enqueueWatchSyncForHandles } = require('../domains/x-monitor/6551/watch-sync-outbox');
const { roleFlags } = require('../domains/x-monitor/6551/watch-reconciler');

test('whitelist budget validation is owned by the CA entry', () => {
  assert.deepEqual(
    whitelistService.validateBudgetValues({
      chain_id: 'sol', budget_per_trade: 0.005, total_budget: 0.03
    }),
    {
      chain_id: 'sol',
      budget_per_trade: 0.005,
      total_budget: 0.03,
      slippage: 10,
      allow_repeat_buy: false,
      max_repeat_buys: 1
    }
  );
  assert.throws(
    () => whitelistService.validateBudgetValues({
      chain_id: 'sol', budget_per_trade: 0.1, total_budget: 0.05
    }),
    { code: 'WHITELIST_BUDGET_INVALID' }
  );
});

test('whitelist service saves and replaces explicit relations transactionally', async () => {
  const suffix = String(Date.now()).slice(-7);
  const actorHandle = `svcact${suffix}`;
  const secondActorHandle = `svcacb${suffix}`;
  const firstTarget = `svctgta${suffix}`;
  const secondTarget = `svctgtb${suffix}`;
  const addressSuffix = suffix.replace(/0/g, '1');
  const ca = `1111111111111111111111111${addressSuffix}`;
  let whitelistId = null;

  try {
    const createResult = await whitelistService.addWhitelist({
      contract_address: ca,
      chain_id: 'sol',
      symbol: `SVC${suffix}`,
      project_name: 'Relation Service Test',
      budget_per_trade: 0.001,
      total_budget: 0.01,
      relations: [
        { actor_handle: `@${actorHandle}`, target_x_handle: `@${firstTarget}` }
      ]
    });
    const created = createResult.item;
    whitelistId = created.id;
    assert.equal(createResult.mergedIntoExisting, false);
    assert.equal(created.relations.length, 1);
    assert.equal(created.relations[0].actor_handle, actorHandle);
    assert.equal(created.relations[0].target_x_handle, firstTarget);
    assert.deepEqual(created.project_x_handles, [firstTarget]);

    const mergeResult = await whitelistService.addWhitelist({
      contract_address: ca,
      chain_id: 'sol',
      symbol: 'IGNORED',
      project_name: 'Ignored duplicate values',
      budget_per_trade: 0.002,
      total_budget: 0.02,
      relations: [
        { actor_handle: secondActorHandle, target_x_handle: firstTarget }
      ]
    });
    assert.equal(mergeResult.item.id, whitelistId);
    assert.equal(mergeResult.mergedIntoExisting, true);
    assert.equal(mergeResult.addedRelations, 1);
    assert.equal(Number(mergeResult.item.budget_per_trade), 0.001);
    assert.equal(mergeResult.item.relations.length, 2);

    const updated = await whitelistService.updateWhitelist(whitelistId, {
      project_name: 'Updated Relation Service Test',
      relations: [
        { actor_handle: actorHandle, target_x_handle: secondTarget }
      ]
    });
    assert.equal(updated.project_name, 'Updated Relation Service Test');
    assert.equal(updated.relations.length, 1);
    assert.equal(updated.relations[0].target_x_handle, secondTarget);
    assert.deepEqual(updated.project_x_handles, [secondTarget]);

    const oldRelation = await db.query(
      `SELECT COUNT(*)::int AS count FROM x_signal_relations
       WHERE whitelist_id = $1 AND target_x_handle = $2`,
      [whitelistId, firstTarget]
    );
    assert.equal(oldRelation.rows[0].count, 0);
  } finally {
    if (whitelistId) await db.query('DELETE FROM ca_whitelist WHERE id = $1', [whitelistId]);
    await db.query(
      `DELETE FROM x_kol_accounts
       WHERE lower(regexp_replace(x_handle, '^@+', '')) = ANY($1::text[])`,
      [[actorHandle, secondActorHandle]]
    );
  }
});

test('budget-only edits keep an exact Watch succeeded while event changes advance demand', async () => {
  const suffix = String(Date.now()).slice(-7);
  const actorHandle = `watchact${suffix}`;
  const targetHandle = `watchtgt${suffix}`;
  const addressSuffix = suffix.replace(/0/g, '2');
  const ca = `2222222222222222222222222${addressSuffix}`;
  const previous = {
    provider: process.env.X_DATA_PROVIDER,
    apply: process.env.X_6551_WATCH_APPLY_ENABLED,
    token: process.env.OPENNEWS_TOKEN
  };
  process.env.X_DATA_PROVIDER = '6551';
  process.env.X_6551_WATCH_APPLY_ENABLED = 'false';
  process.env.OPENNEWS_TOKEN = 'integration-test-token';
  let whitelistId = null;

  try {
    const created = await whitelistService.addWhitelist({
      contract_address: ca,
      chain_id: 'sol',
      symbol: `WATCH${suffix}`,
      project_name: 'Watch demand integration test',
      budget_per_trade: 0.001,
      total_budget: 0.01,
      relations: [{
        actor_handle: actorHandle,
        target_x_handle: targetHandle,
        event_types: ['reply']
      }]
    });
    whitelistId = created.item.id;
    const replyFlags = roleFlags('kol', { eventTypes: ['reply'] });
    await db.query(
      `INSERT INTO x_provider_watches(
         provider, username, roles, desired_flags, remote_flags, managed, sync_status
       ) VALUES ('6551', $1, ARRAY['kol'], $2, $2, true, 'in_sync')
       ON CONFLICT (provider, username) DO UPDATE
       SET desired_flags = EXCLUDED.desired_flags, remote_flags = EXCLUDED.remote_flags,
           managed = true, sync_status = 'in_sync'`,
      [actorHandle, replyFlags]
    );
    await enqueueWatchSyncForHandles([actorHandle]);
    const before = await db.query(
      'SELECT desired_version, status FROM x_watch_sync_outbox WHERE actor_handle = $1',
      [actorHandle]
    );
    assert.equal(before.rows[0].status, 'succeeded');

    await whitelistService.updateWhitelist(whitelistId, { budget_per_trade: 0.002 });
    const afterBudget = await db.query(
      'SELECT desired_version, status FROM x_watch_sync_outbox WHERE actor_handle = $1',
      [actorHandle]
    );
    assert.deepEqual(afterBudget.rows[0], before.rows[0]);

    await whitelistService.updateWhitelist(whitelistId, {
      relations: [{
        actor_handle: actorHandle,
        target_x_handle: targetHandle,
        event_types: ['quote', 'reply']
      }]
    });
    const afterEvents = await db.query(
      `SELECT desired_version, status, last_error
       FROM x_watch_sync_outbox WHERE actor_handle = $1`,
      [actorHandle]
    );
    assert.equal(Number(afterEvents.rows[0].desired_version), Number(before.rows[0].desired_version) + 1);
    assert.equal(afterEvents.rows[0].status, 'failed');
    assert.equal(afterEvents.rows[0].last_error, 'WATCH_SYNC_DISABLED');
  } finally {
    if (whitelistId) await db.query('DELETE FROM ca_whitelist WHERE id = $1', [whitelistId]);
    await db.query('DELETE FROM x_watch_sync_outbox WHERE actor_handle = $1', [actorHandle]);
    await db.query("DELETE FROM x_provider_watches WHERE provider = '6551' AND username = $1", [actorHandle]);
    await db.query(
      `DELETE FROM x_kol_accounts
       WHERE lower(regexp_replace(x_handle, '^@+', '')) = $1`,
      [actorHandle]
    );
    if (previous.provider === undefined) delete process.env.X_DATA_PROVIDER;
    else process.env.X_DATA_PROVIDER = previous.provider;
    if (previous.apply === undefined) delete process.env.X_6551_WATCH_APPLY_ENABLED;
    else process.env.X_6551_WATCH_APPLY_ENABLED = previous.apply;
    if (previous.token === undefined) delete process.env.OPENNEWS_TOKEN;
    else process.env.OPENNEWS_TOKEN = previous.token;
  }
});

test.after(async () => {
  await db.pool.end();
});
