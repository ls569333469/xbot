const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('./integration-guard');
const db = require('../lib/db');
const whitelistService = require('../domains/whitelist/service');

test('whitelist budget validation uses the same chain limit shown by the frontend', () => {
  const chainConfigs = {
    sol: { maxPerTrade: 0.005, nativeSymbol: 'SOL' }
  };
  assert.deepEqual(
    whitelistService.validateBudgetValues({
      chain_id: 'sol', budget_per_trade: 0.005, total_budget: 0.03
    }, chainConfigs),
    { chain_id: 'sol', budget_per_trade: 0.005, total_budget: 0.03 }
  );
  assert.throws(
    () => whitelistService.validateBudgetValues({
      chain_id: 'sol', budget_per_trade: 0.1, total_budget: 0.1
    }, chainConfigs),
    { code: 'WHITELIST_TRADE_AMOUNT_EXCEEDS_CHAIN_LIMIT' }
  );
});

test('whitelist service saves and replaces explicit relations transactionally', async () => {
  const suffix = String(Date.now()).slice(-7);
  const actorHandle = `svcact${suffix}`;
  const secondActorHandle = `svcacb${suffix}`;
  const firstTarget = `svctgta${suffix}`;
  const secondTarget = `svctgtb${suffix}`;
  const ca = `SERVICECA${suffix}`;
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

test.after(async () => {
  await db.pool.end();
});
