const assert = require('node:assert/strict');
const test = require('node:test');
const { clonePreset } = require('../domains/trade/exit-strategy-compiler');
const { createSignal, materialize } = require('../domains/dynamic-signal/dynamic-target-service');

test('P24 dynamic Live target is locally ready without an activation outbox', async () => {
  const calls = [];
  const executor = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT * FROM x_actor_dynamic_policies')) {
        return { rows: [{
          id: 9, enabled: true, revision: 3, context_hash: 'policy-hash',
          budget_per_trade: '0.01', daily_budget: '0.1', slippage: 10,
          chain_budgets: { bsc: { budget_per_trade: '0.01', daily_budget: '0.1' } },
          per_token_buy_limit: 1, exit_strategy: clonePreset('principal_no_stop')
        }] };
      }
      if (sql.startsWith('INSERT INTO dynamic_targets')) return { rows: [{ id: 10 }] };
      if (sql.startsWith('INSERT INTO ca_whitelist')) {
        return { rows: [{ id: 11, activation_version: 1, live_activation_state: 'live_ready' }] };
      }
      if (sql.includes('UPDATE ca_whitelist') && sql.includes('activation_version = activation_version')) {
        return { rows: [{ id: 11, activation_version: 1 }] };
      }
      if (sql.startsWith('INSERT INTO whitelist_activation_outbox')) return { rows: [] };
      if (sql.startsWith('UPDATE dynamic_targets')) return { rows: [] };
      if (sql.startsWith('INSERT INTO trade_signals')) return { rows: [{ id: 12 }] };
      return { rows: [] };
    }
  };
  const job = {
    mode: 'live', actor_policy_id: 9, policy_revision: 3,
    context_hash: 'policy-hash', x_activity_id: 20, kol_id: 30, kol_handle: 'dynamic_actor'
  };
  const attempt = { id: 21 };
  const selected = {
    id: 31, variantId: 31, chainId: 'bsc',
    contractAddress: '0x0000000000000000000000000000000000000001',
    symbol: 'TEST', name: 'Test Token'
  };

  const target = await materialize(job, attempt, selected, executor);
  assert.equal(target.whitelist.live_activation_state, 'live_ready');
  assert.equal(target.activation_version, 1);
  assert.equal(calls.some((item) => item.sql.startsWith('INSERT INTO whitelist_activation_outbox')), false);
  const whitelistInsert = calls.find((item) => item.sql.startsWith('INSERT INTO ca_whitelist'));
  assert.equal(whitelistInsert.params.at(-2), 'live_ready');

  await createSignal(job, attempt, target, {
    intent: { intentClass: 'buy_direct', reasonCodes: ['EXPLICIT_BUY_LANGUAGE'], ruleRevision: 'p20-test' },
    resolverRevision: 'p20-test', confidence: 1
  }, executor);
  const signalInsert = calls.find((item) => item.sql.startsWith('INSERT INTO trade_signals'));
  assert.equal(signalInsert.params.at(-2).symbol, null);
  assert.equal(signalInsert.params.at(-2).name, null);
  assert.equal(signalInsert.params.at(-1).strategy_type, 'dynamic_policy');
  assert.equal(signalInsert.params.at(-1).execution_decision.status, 'not_attempted');
  assert.ok(calls.some((item) => item.sql.includes("'entity_event','entity.changed'")));
});
