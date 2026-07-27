const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');
const {
  getRuntimePolicyDetail,
  getRuntimeSummary
} = require('../domains/trade/runtime-policy-summary');

test('compact runtime APIs stay bounded with 100 whitelists and 1000 relations', async () => {
  const client = await db.pool.connect();
  let queryQueue = Promise.resolve();
  const executor = {
    query(...args) {
      const query = queryQueue.then(() => client.query(...args));
      queryQueue = query.catch(() => {});
      return query;
    }
  };
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  try {
    await client.query('BEGIN');
    await client.query("UPDATE ca_whitelist SET status = 'paused' WHERE status = 'active'");
    await client.query("UPDATE chain_live_readiness SET live_enabled = (chain = 'sol')");
    await client.query("DELETE FROM live_acceptance_scopes");
    await client.query(
      `INSERT INTO x_kol_accounts(x_user_id, x_handle, enabled)
       SELECT 'p17-scale-user-${suffix}-' || value,
              'p17scale${suffix}' || value,
              true
       FROM generate_series(1, 10) AS value`
    );
    await client.query(
      `INSERT INTO ca_whitelist(
         contract_address, chain_id, symbol, project_name, budget_per_trade,
         total_budget, spent_budget, slippage, status, live_activation_state
       )
       SELECT 'P17ScaleToken${suffix}' || value,
              'sol', 'S' || value, 'P17Scale${suffix} Project ' || value,
              0.01, 1, 0, 10, 'active', 'live_ready'
       FROM generate_series(1, 100) AS value`
    );
    await client.query(
      `INSERT INTO x_signal_relations(
         whitelist_id, kol_id, target_x_handle, event_types, enabled
       )
       SELECT whitelist.id, actor.id,
              'p17target${suffix}' || whitelist.id,
              ARRAY['reply','quote']::text[], true
       FROM ca_whitelist AS whitelist
       CROSS JOIN x_kol_accounts AS actor
       WHERE whitelist.project_name LIKE 'P17Scale${suffix}%'
         AND actor.x_user_id LIKE 'p17-scale-user-${suffix}-%'`
    );

    const startedAt = performance.now();
    const summary = await getRuntimeSummary(executor);
    const detail = await getRuntimePolicyDetail({
      search: `P17Scale${suffix}`,
      page: 1,
      page_size: 20
    }, executor);
    const elapsedMs = performance.now() - startedAt;

    assert.equal(summary.counts.whitelists, 100);
    assert.equal(summary.counts.watches, 10);
    assert.equal(summary.counts.relations, 1000);
    assert.equal(detail.total, 100);
    assert.equal(detail.items.length, 20);
    assert.ok(detail.items.every((item) => item.actor_handles.length <= 5));
    assert.ok(elapsedMs < 5000, `compact runtime queries took ${elapsedMs.toFixed(1)}ms`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

test.after(async () => {
  await db.pool.end();
});
