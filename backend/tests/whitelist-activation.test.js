const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WhitelistActivationWorker,
  assertWatchesInSync
} = require('../jobs/whitelist-activation');

test('activation waits for Watch Outbox completion and matching remote flags', async () => {
  const originalProvider = process.env.X_DATA_PROVIDER;
  process.env.X_DATA_PROVIDER = '6551';
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM x_provider_watches AS watch')) {
        return { rows: [{
          username: 'vladtenev',
          sync_status: 'in_sync',
          managed: true,
          desired_flags: { watchReply: true },
          remote_flags: { watchReply: false },
          outbox_status: 'pending'
        }] };
      }
      return { rows: [] };
    }
  };

  try {
    await assert.rejects(
      assertWatchesInSync({ actor_handles: ['vladtenev'] }, executor),
      error => error.code === 'WATCH_SYNC_PENDING'
    );
    assert.ok(calls.some((item) => item.sql.includes('INSERT INTO x_watch_sync_outbox')));
  } finally {
    process.env.X_DATA_PROVIDER = originalProvider;
  }
});

test('activation accepts a managed Watch only after desired flags are remotely covered', async () => {
  const originalProvider = process.env.X_DATA_PROVIDER;
  process.env.X_DATA_PROVIDER = '6551';
  let queried = false;
  const executor = {
    async query(sql) {
      queried = true;
      assert.match(sql, /LEFT JOIN x_watch_sync_outbox/);
      return { rows: [{
        username: 'vladtenev',
        sync_status: 'in_sync',
        managed: true,
        desired_flags: { watchReply: true },
        remote_flags: { watchReply: true, watchQuote: true },
        outbox_status: 'succeeded'
      }] };
    }
  };
  try {
    await assert.doesNotReject(assertWatchesInSync({ actor_handles: ['vladtenev'] }, executor));
    assert.equal(queried, true);
  } finally {
    process.env.X_DATA_PROVIDER = originalProvider;
  }
});

test('inactive whitelist activation is discarded instead of being claimed forever', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT whitelist.*')) {
        return { rows: [{ id: 5, status: 'paused', activation_version: 3 }] };
      }
      return { rows: [] };
    }
  };
  const worker = new WhitelistActivationWorker({ db: executor, logger: { error() {} } });
  const result = await worker.process({ whitelist_id: 5, desired_version: 3, attempt_count: 0 });
  assert.deepEqual(result, { status: 'superseded' });
  const discarded = calls.find((item) => item.sql.includes("THEN 'succeeded'"));
  assert.ok(discarded);
  assert.deepEqual(discarded.params, [5, 3]);
});

test('activation moves a valid whitelist to live_ready after Watch, RPC, cache, and quote checks', async () => {
  const originalProvider = process.env.X_DATA_PROVIDER;
  process.env.X_DATA_PROVIDER = '6551';
  const calls = [];
  const whitelist = {
    id: 6,
    status: 'active',
    activation_version: 4,
    chain_id: 'base',
    contract_address: '0x1111111111111111111111111111111111111111',
    budget_per_trade: '0.01',
    total_budget: '0.1',
    slippage: '5',
    exit_strategy: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [{ type: 'take_profit', trigger_pct: 100, sell_pct: 100 }]
    },
    exit_strategy_version: 1,
    actor_handles: ['vladtenev']
  };
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT whitelist.*')) return { rows: [whitelist] };
      if (sql.includes('FROM x_provider_watches AS watch')) {
        return { rows: [{
          username: 'vladtenev', sync_status: 'in_sync', managed: true,
          desired_flags: { watchTweet: true }, remote_flags: { watchTweet: true },
          outbox_status: 'succeeded'
        }] };
      }
      if (sql.includes("SET live_activation_state = 'live_ready'")) return { rows: [{ id: 6 }] };
      return { rows: [] };
    }
  };
  const worker = new WhitelistActivationWorker({
    db: executor,
    logger: { error() {} },
    dependencies: {
      loadCachedContext: async () => ({
        chain: { id: 'base', decimals: 18, nativeToken: '0x0000000000000000000000000000000000000000' },
        wallet: { address: '0x2222222222222222222222222222222222222222' }
      }),
      probeRpc: async () => ({ ok: true, identity: '8453' }),
      quoteOrder: async () => ({ output_amount: '100' })
    }
  });

  try {
    const result = await worker.process({ whitelist_id: 6, desired_version: 4, attempt_count: 0 });
    assert.equal(result.status, 'live_ready');
    assert.ok(calls.some((item) => item.sql.includes("pg_notify('xbot_activation_ready'")));
  } finally {
    process.env.X_DATA_PROVIDER = originalProvider;
  }
});
