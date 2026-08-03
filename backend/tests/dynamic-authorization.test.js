const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateSignal, settleUsage } = require('../domains/dynamic-signal/dynamic-authorization');

const SIGNAL = {
  actor_policy_id: 7,
  actor_policy_revision: 4,
  dynamic_policy_context_hash: 'ctx-4',
  dynamic_target_id: 11,
  chain_id: 'bsc',
  contract_address: '0x0000000000000000000000000000000000000001',
  activity_type: 'tweet',
  source_created_at: new Date(Date.now() - 1000).toISOString(),
};

function policyRow(chainBudgets = { bsc: { budget_per_trade: '0.01', daily_budget: '0.05' } }) {
  return {
    id: 7,
    enabled: true,
    mode: 'live',
    kol_enabled: true,
    revision: 4,
    context_hash: 'ctx-4',
    allowed_event_types: ['tweet'],
    per_token_buy_limit: 1,
    daily_new_token_limit: 2,
    chain_budgets: chainBudgets,
    approval_id: 19,
    approval_revision: 4,
    approval_context_hash: 'ctx-4',
    target_status: 'active',
    target_chain: 'bsc',
    target_ca: SIGNAL.contract_address,
    target_context_hash: 'ctx-4',
  };
}

test('dynamic authorization reads and enforces the native budget for the signal chain', async () => {
  const calls = [];
  const executor = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT policy.*')) return { rows: [policyRow()] };
      if (sql.includes('dynamic_policy_usage_daily_by_chain')) {
        return { rows: [{ spent_native: '0.02', reserved_native: '0.01', new_token_count: 0, open_positions: 0, token_buys: 0, existing_token_events: 0 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const result = await evaluateSignal(SIGNAL, executor, { flags: { P20_LIVE_ENABLED: true } });
  assert.equal(result.allowed, true);
  assert.match(calls[1].sql, /dynamic_policy_usage_daily_by_chain/);
  assert.deepEqual(calls[1].params, [7, 'bsc', SIGNAL.contract_address]);
});

test('missing chain budget fails closed before usage lookup', async () => {
  const calls = [];
  const executor = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT policy.*')) return { rows: [policyRow({ sol: { budget_per_trade: '0.05', daily_budget: '0.25' } })] };
      throw new Error('usage lookup must not run without a chain budget');
    },
  };
  const result = await evaluateSignal(SIGNAL, executor, { flags: { P20_LIVE_ENABLED: true } });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockers, ['DYNAMIC_CHAIN_BUDGET_NOT_CONFIGURED']);
  assert.equal(calls.length, 1);
});

test('dynamic usage settlement updates the same chain ledger as the event', async () => {
  const calls = [];
  const executor = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('UPDATE dynamic_policy_usage_events')) {
        return { rows: [{ actor_policy_id: 7, usage_date: '2026-08-02', chain_id: 'bsc', amount_native: '0.01', counts_new_token: true }] };
      }
      if (sql.startsWith('UPDATE dynamic_policy_usage_daily_by_chain')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  assert.equal(await settleUsage(31, 'released', null, executor), true);
  assert.match(calls[1].sql, /dynamic_policy_usage_daily_by_chain/);
  assert.equal(calls[1].params.at(-1), 'bsc');
});
