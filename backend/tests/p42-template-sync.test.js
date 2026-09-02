const assert = require('node:assert/strict');
const test = require('node:test');
const { clonePreset } = require('../domains/trade/exit-strategy-compiler');
const {
  execute,
  preview,
  SKIP
} = require('../domains/whitelist/template-sync');
const {
  tradeConfigSnapshot,
  isTradeConfigSnapshot,
  hashSnapshot
} = require('../domains/signal/contract-snapshot');
const { getSignalForExecution } = require('../domains/trade/trade-repository');

function templateSnapshot(overrides = {}) {
  return {
    schema_version: 2,
    budget_per_trade: 0.1,
    total_budget: 0.5,
    slippage: 10,
    allow_repeat_buy: false,
    max_repeat_buys: 1,
    exit_strategy: clonePreset('principal_no_stop'),
    direct_source_event_types: ['tweet'],
    relation_event_types: ['retweet', 'quote', 'reply', 'follow'],
    direct_source_rule_enabled: true,
    direct_source_actor_handles: ['source'],
    relation_rule_enabled: false,
    relation_actor_handles: [],
    relation_target_policy: 'all_selected_project_identities',
    ...overrides
  };
}

function target(id, overrides = {}) {
  return {
    id,
    source: 'manual',
    status: 'active',
    chain_id: 'bsc',
    symbol: `T${id}`,
    contract_address: `0x${String(id).padStart(40, '0')}`,
    budget_per_trade: 0.05,
    total_budget: 0.5,
    spent_budget: 0,
    slippage: 5,
    allow_repeat_buy: false,
    max_repeat_buys: 1,
    current_buy_count: 0,
    exit_strategy: clonePreset('principal_no_stop'),
    exit_strategy_version: 1,
    auto_tp_pct: 100,
    auto_sl_pct: null,
    ...overrides
  };
}

function fakeExecutor(rows, { failUpdateId = null, signalRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM whitelist_templates')) {
        return { rows: [{
          id: 9,
          name: 'BSC 小额模板',
          chain_id: 'bsc',
          version: 3,
          template_snapshot: templateSnapshot()
        }] };
      }
      if (sql.includes('FROM ca_whitelist')) return { rows: rows.filter((row) => params[0].includes(row.id)) };
      if (sql.includes('FROM budget_reservations')) return { rows: [] };
      if (sql.includes('FROM trade_attempts')) return { rows: [] };
      if (sql.includes('FROM trade_signals')) return { rows: signalRows };
      if (sql.includes('FROM live_acceptance_scopes')) return { rows: [] };
      if (sql.includes('INSERT INTO whitelist_template_sync_runs')) return { rows: [{ id: 100 }] };
      if (sql.includes('UPDATE ca_whitelist')) {
        if (failUpdateId && Number(params.at(-1)) === failUpdateId) throw new Error('simulated write failure');
        return { rows: [{ id: Number(params.at(-1)) }] };
      }
      return { rows: [] };
    }
  };
}

test('P42 trade config snapshot is immutable and includes the execution fields', () => {
  const snapshot = tradeConfigSnapshot({
    budget_per_trade: 0.1,
    total_budget: 0.5,
    slippage: 8,
    allow_repeat_buy: true,
    max_repeat_buys: 3,
    exit_strategy: clonePreset('principal_no_stop'),
    exit_strategy_version: 4,
  });
  assert.equal(snapshot.snapshot_version, 'p42.trade_config.v1');
  assert.equal(snapshot.budget_per_trade, 0.1);
  assert.equal(snapshot.max_repeat_buys, 3);
  assert.equal(snapshot.exit_strategy_version, 4);
  assert.equal(snapshot.auto_sl_pct, null);
  assert.match(snapshot.snapshot_hash, /^[a-f0-9]{64}$/);
  assert.equal(isTradeConfigSnapshot({ ...snapshot, budget_per_trade: 0.2 }), false);
  assert.equal(isTradeConfigSnapshot({ ...snapshot, max_repeat_buys: 2 }), false);
});

test('P42 trade config snapshots survive JSONB key reordering and preserve legacy hashes', () => {
  const snapshot = tradeConfigSnapshot({
    budget_per_trade: 0.1,
    total_budget: 0.5,
    slippage: 8,
    allow_repeat_buy: true,
    max_repeat_buys: 2,
    exit_strategy: clonePreset('principal_no_stop')
  });
  const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
  reordered.exit_strategy = Object.fromEntries(Object.entries(reordered.exit_strategy).reverse());
  reordered.exit_strategy.legs = reordered.exit_strategy.legs.map((leg) => (
    Object.fromEntries(Object.entries(leg).reverse())
  ));
  assert.equal(isTradeConfigSnapshot(reordered), true);

  const { snapshot_hash: ignored, ...body } = snapshot;
  const legacy = { ...reordered, snapshot_hash: hashSnapshot(body) };
  assert.equal(isTradeConfigSnapshot(legacy), true);
});

test('P42 execution falls back to the whitelist repeat-buy settings for legacy signals', async () => {
  const result = await getSignalForExecution('42', {
    query: async (sql) => {
      assert.match(sql, /whitelist\.allow_repeat_buy/);
      assert.match(sql, /whitelist\.max_repeat_buys/);
      return { rows: [{
        signal_id: 42,
        trade_config_snapshot: {},
        allow_repeat_buy: true,
        max_repeat_buys: 2,
        current_buy_count: 1
      }] };
    }
  });
  assert.equal(result.allow_repeat_buy, true);
  assert.equal(result.max_repeat_buys, 2);
});

test('P42 keeps incomplete legacy signal inputs on the compatibility path', () => {
  const snapshot = tradeConfigSnapshot({ budget_per_trade: 0.1 });
  assert.deepEqual(snapshot, {});
  assert.equal(isTradeConfigSnapshot(snapshot), false);
});

test('P42 rejects malformed versioned snapshots before execution can use them', () => {
  assert.equal(isTradeConfigSnapshot({
    snapshot_version: 'p42.trade_config.v1',
    budget_per_trade: null,
    total_budget: 0.5,
    slippage: 10,
    allow_repeat_buy: false,
    max_repeat_buys: 1,
    exit_strategy: clonePreset('principal_no_stop')
  }), false);
  const valid = tradeConfigSnapshot({
    budget_per_trade: 0.1,
    total_budget: 0.5,
    slippage: 10,
    allow_repeat_buy: false,
    max_repeat_buys: 1,
    exit_strategy: clonePreset('principal_no_stop'),
    exit_strategy_version: 1,
    auto_tp_pct: 100,
    auto_sl_pct: null
  });
  assert.equal(isTradeConfigSnapshot({ ...valid, auto_tp_pct: null }), false);
  assert.equal(isTradeConfigSnapshot({ ...valid, exit_strategy_version: null }), false);
});

test('P42 preview only reads and skips targets with the protective checks', async () => {
  const executor = fakeExecutor([
    target(1),
    target(2, { current_buy_count: 1 }),
  ]);
  const plan = await preview({ template_id: '9', whitelist_ids: ['1', '2'] }, executor);
  assert.deepEqual(plan.summary, { requested: 2, updated: 2, unchanged: 0, skipped: 0 });
  assert.equal(executor.calls.some((call) => /INSERT|UPDATE|SAVEPOINT/.test(call.sql)), false);
  assert.equal(plan.items[0].after_config.budget_per_trade, 0.1);
  assert.equal(plan.items[1].reason_code, null);

  const skipped = await preview({ template_id: '9', whitelist_ids: ['3'] }, fakeExecutor([
    target(3, { current_buy_count: 2 })
  ]));
  assert.equal(skipped.items[0].reason_code, SKIP.REPEAT_BELOW_HISTORY);
});

test('P42 treats malformed or tampered snapshots as legacy pending signals', async () => {
  const executor = fakeExecutor([target(1)], {
    signalRows: [{ whitelist_id: 1, trade_config_snapshot: { snapshot_version: 'p42.trade_config.v1' } }]
  });
  const plan = await preview({ template_id: '9', whitelist_ids: ['1'] }, executor);
  assert.equal(plan.items[0].outcome, 'skipped');
  assert.equal(plan.items[0].reason_code, SKIP.LEGACY_SIGNAL);
});

test('P42 executes each CA independently and never writes Activation or Watch records', async () => {
  const executor = fakeExecutor([target(1), target(2)], { failUpdateId: 2 });
  const result = await execute({
    template_id: '9',
    whitelist_ids: ['1', '2'],
    expected_template_version: 3
  }, executor);
  assert.equal(result.run_id, 100);
  assert.equal(result.items[0].outcome, 'updated');
  assert.equal(result.items[1].outcome, 'skipped');
  assert.equal(result.items[1].reason_code, 'SYNC_ITEM_WRITE_FAILED');
  assert.equal(executor.calls.some((call) => /activation|watch|6551/i.test(call.sql)), false);
  assert.equal(executor.calls.filter((call) => call.sql.includes('UPDATE ca_whitelist')).length, 2);
});
