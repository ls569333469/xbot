const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WhitelistActivationWorker,
  assertWatchesInSync,
  loadActivationContext
} = require('../jobs/whitelist-activation');
const { deferActivation } = require('../domains/whitelist/activation-outbox');
const { watchDemandFingerprint } = require('../domains/x-monitor/6551/watch-sync-outbox');
const { roleFlags } = require('../domains/x-monitor/6551/watch-reconciler');

function enable6551WatchApply() {
  const previous = {
    provider: process.env.X_DATA_PROVIDER,
    apply: process.env.X_6551_WATCH_APPLY_ENABLED,
    token: process.env.OPENNEWS_TOKEN
  };
  process.env.X_DATA_PROVIDER = '6551';
  process.env.X_6551_WATCH_APPLY_ENABLED = 'true';
  process.env.OPENNEWS_TOKEN = 'test-token';
  return () => {
    if (previous.provider === undefined) delete process.env.X_DATA_PROVIDER;
    else process.env.X_DATA_PROVIDER = previous.provider;
    if (previous.apply === undefined) delete process.env.X_6551_WATCH_APPLY_ENABLED;
    else process.env.X_6551_WATCH_APPLY_ENABLED = previous.apply;
    if (previous.token === undefined) delete process.env.OPENNEWS_TOKEN;
    else process.env.OPENNEWS_TOKEN = previous.token;
  };
}

test('follow-discovery whitelist activation resolves its policy KOL actor', async () => {
  let capturedSql = '';
  const executor = { async query(sql, params) {
    capturedSql = sql;
    assert.deepEqual(params, [42]);
    return { rows: [{ id: 42, source: 'follow_discovery', actor_handles: ['cz_binance'] }] };
  } };
  const context = await loadActivationContext(42, executor);
  assert.deepEqual(context.actor_handles, ['cz_binance']);
  assert.match(capturedSql, /FROM follow_discovery_policies AS policy/);
  assert.match(capturedSql, /whitelist\.follow_discovery_policy_id = policy\.id/);
  assert.match(capturedSql, /policy\.archived_at IS NULL/);
});

test('activation waits for Watch Outbox completion and matching remote flags', async () => {
  const restoreEnv = enable6551WatchApply();
  const desiredFlags = roleFlags('kol', { eventTypes: ['reply'] });
  const remoteFlags = { ...desiredFlags, newTweetReplyBol: false };
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes(') AS desired') && sql.includes('GROUP BY x_handle')) {
        return { rows: [{ x_handle: 'vladtenev', event_types: ['reply'] }] };
      }
      if (sql.includes('FROM x_provider_watches') && sql.includes('username = ANY')
          && !sql.includes('AS watch')) {
        return { rows: [{ username: 'vladtenev', managed: true, sync_status: 'in_sync', remote_flags: remoteFlags }] };
      }
      if (sql.includes('FROM x_provider_watches AS watch')) {
        return { rows: [{
          username: 'vladtenev',
          sync_status: 'in_sync',
          managed: true,
          desired_flags: desiredFlags,
          remote_flags: remoteFlags,
          outbox_status: 'pending',
          outbox_desired_fingerprint: watchDemandFingerprint(true, desiredFlags)
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
    restoreEnv();
  }
});

test('activation accepts a managed Watch only when remote flags exactly match current demand', async () => {
  const restoreEnv = enable6551WatchApply();
  const desiredFlags = roleFlags('kol', { eventTypes: ['quote', 'reply'] });
  let queried = false;
  const executor = {
    async query(sql) {
      if (sql.includes(') AS desired') && sql.includes('GROUP BY x_handle')) {
        return { rows: [{ x_handle: 'vladtenev', event_types: ['quote', 'reply'] }] };
      }
      if (sql.includes('FROM x_provider_watches') && sql.includes('username = ANY')
          && !sql.includes('AS watch')) {
        return { rows: [{ username: 'vladtenev', managed: true, sync_status: 'in_sync', remote_flags: desiredFlags }] };
      }
      if (sql.includes('FROM x_provider_watches AS watch')) {
        queried = true;
        assert.match(sql, /LEFT JOIN x_watch_sync_outbox/);
        return { rows: [{
          username: 'vladtenev',
          sync_status: 'in_sync',
          managed: true,
          desired_flags: desiredFlags,
          remote_flags: desiredFlags,
          outbox_status: 'succeeded',
          outbox_desired_fingerprint: watchDemandFingerprint(true, desiredFlags)
        }] };
      }
      return { rows: [] };
    }
  };
  try {
    await assert.doesNotReject(assertWatchesInSync({ actor_handles: ['vladtenev'] }, executor));
    assert.equal(queried, true);
  } finally {
    restoreEnv();
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

test('activation fails once with WATCH_SYNC_DISABLED when a real Watch change cannot run', async () => {
  const previous = {
    provider: process.env.X_DATA_PROVIDER,
    apply: process.env.X_6551_WATCH_APPLY_ENABLED,
    token: process.env.OPENNEWS_TOKEN
  };
  process.env.X_DATA_PROVIDER = '6551';
  process.env.X_6551_WATCH_APPLY_ENABLED = 'false';
  process.env.OPENNEWS_TOKEN = 'test-token';
  const whitelist = {
    id: 8,
    status: 'active',
    activation_version: 2,
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
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT whitelist.*')) return { rows: [whitelist] };
      if (sql.includes(') AS desired') && sql.includes('GROUP BY x_handle')) {
        return { rows: [{ x_handle: 'vladtenev', event_types: ['tweet'] }] };
      }
      return { rows: [] };
    }
  };
  const worker = new WhitelistActivationWorker({ db: executor, logger: { error() {} } });

  try {
    const result = await worker.process({ whitelist_id: 8, desired_version: 2, attempt_count: 0 });
    assert.deepEqual(result, { status: 'sync_failed', error: 'WATCH_SYNC_DISABLED' });
    assert.ok(calls.some((item) => item.sql.includes("SET live_activation_state = 'sync_failed'")));
    assert.equal(calls.some((item) => item.sql.includes("SET live_activation_state = 'syncing'")), false);
  } finally {
    if (previous.provider === undefined) delete process.env.X_DATA_PROVIDER;
    else process.env.X_DATA_PROVIDER = previous.provider;
    if (previous.apply === undefined) delete process.env.X_6551_WATCH_APPLY_ENABLED;
    else process.env.X_6551_WATCH_APPLY_ENABLED = previous.apply;
    if (previous.token === undefined) delete process.env.OPENNEWS_TOKEN;
    else process.env.OPENNEWS_TOKEN = previous.token;
  }
});

test('activation moves a valid whitelist to live_ready after Watch and RPC checks without a quote', async () => {
  const restoreEnv = enable6551WatchApply();
  const desiredFlags = roleFlags('kol', { eventTypes: ['tweet'] });
  const calls = [];
  const whitelist = {
    id: 6,
    status: 'active',
    source: 'follow_discovery',
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
    actor_handles: ['vladtenev'],
    provider_verification_snapshot: { info: {}, security: {}, pool: {} }
  };
  let quoteCalls = 0;
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT whitelist.*')) return { rows: [whitelist] };
      if (sql.includes(') AS desired') && sql.includes('GROUP BY x_handle')) {
        return { rows: [{ x_handle: 'vladtenev', event_types: ['tweet'] }] };
      }
      if (sql.includes('FROM x_provider_watches') && sql.includes('username = ANY')
          && !sql.includes('AS watch')) {
        return { rows: [{ username: 'vladtenev', managed: true, sync_status: 'in_sync', remote_flags: desiredFlags }] };
      }
      if (sql.includes('FROM x_provider_watches AS watch')) {
        return { rows: [{
          username: 'vladtenev', sync_status: 'in_sync', managed: true,
          desired_flags: desiredFlags, remote_flags: desiredFlags,
          outbox_status: 'succeeded',
          outbox_desired_fingerprint: watchDemandFingerprint(true, desiredFlags)
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
      quoteOrder: async () => {
        quoteCalls += 1;
        return { output_amount: '100' };
      }
    }
  });

  try {
    const result = await worker.process({ whitelist_id: 6, desired_version: 4, attempt_count: 0 });
    assert.equal(result.status, 'live_ready');
    assert.equal(quoteCalls, 0, 'P22 activation must not preflight a GMGN quote');
    assert.ok(calls.some((item) => item.sql.includes("pg_notify('xbot_activation_ready'")));
  } finally {
    restoreEnv();
  }
});

test('P24 fixed CA activation performs only local configuration checks', async () => {
  const { probeWhitelist } = require('../jobs/whitelist-activation');
  let quoteCalls = 0;
  await probeWhitelist({
    id: 7, source: 'manual', activation_version: 1, chain_id: 'base',
    contract_address: '0x1111111111111111111111111111111111111111',
    budget_per_trade: '0.01', total_budget: '0.1', slippage: '5',
    exit_strategy: { version: 1, sell_ratio_type: 'buy_amount', legs: [] },
    exit_strategy_version: 1, actor_handles: ['vladtenev']
  }, {
    loadCachedContext: async () => ({
      chain: { id: 'base', decimals: 18, nativeToken: '0x0000000000000000000000000000000000000000' },
      wallet: { address: '0x2222222222222222222222222222222222222222' }
    }),
    probeRpc: async () => ({ ok: true, identity: '8453' }),
    quoteOrder: async () => {
      quoteCalls += 1;
      return { output_amount: '100' };
    }
  });
  assert.equal(quoteCalls, 0);
});

test('activation waits until GMGN reset_at instead of retrying during a ban', async () => {
  let delaySeconds;
  const executor = { async query(_sql, params) {
    if (params.length === 6) delaySeconds = Number(params[3]);
    return { rows: [] };
  } };
  const resetAt = Date.now() + 240_000;
  await deferActivation(
    { whitelist_id: 6, desired_version: 4, attempt_count: 1 },
    { code: 'RATE_LIMIT_BANNED', resetAt },
    executor
  );
  assert.ok(delaySeconds >= 238 && delaySeconds <= 242, `delay=${delaySeconds}`);
});
