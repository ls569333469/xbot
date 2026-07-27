const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buyKeys,
  createBuyIntent,
  recoverStalePreSubmitAttempts,
  retryDelayMs,
  retryPolicy,
  sellScopeKey
} = require('../domains/trade/trade-intent-repository');

test('trade intent keys separate source, active scope, and wallet lane identity', () => {
  const keys = buyKeys({
    signalId: 77,
    chain: 'base',
    walletAddress: '0xABCDEF0000000000000000000000000000000000',
    contractAddress: '0x1234560000000000000000000000000000000000'
  });
  assert.equal(keys.sourceKey, 'buy:signal:77');
  assert.equal(keys.scopeKey, 'buy:base:0xabcdef0000000000000000000000000000000000:0x1234560000000000000000000000000000000000');
  assert.equal(keys.walletLaneKey, 'wallet_lane:base:0xabcdef0000000000000000000000000000000000');
  assert.equal(sellScopeKey(12), 'sell:12');
});

test('retry policy remains disabled by default and caps user input at two retries', () => {
  const disabled = retryPolicy('sol', {});
  assert.equal(disabled.retryEnabled, false);
  assert.equal(disabled.maxRetries, 2);
  const enabled = retryPolicy('eth', {
    retryEnabled: true,
    maxRetries: 99,
    retryWindowMs: 500,
    failureEvidenceWindowMs: 100,
    maxRetryFeeNative: 0.01
  });
  assert.equal(enabled.retryEnabled, true);
  assert.equal(enabled.maxRetries, 2);
  assert.equal(enabled.retryWindowMs, 1000);
  assert.equal(enabled.failureEvidenceWindowMs, 5000);
  assert.equal(retryDelayMs('sol', 2), 250);
  assert.equal(retryDelayMs('sol', 3), 500);
  assert.equal(retryDelayMs('eth', 2), 500);
  assert.equal(retryDelayMs('eth', 3), 1000);
});

test('a repeated source key recovers its existing intent without creating another submission', async () => {
  const existing = {
    id: 42,
    source_key: 'buy:signal:77',
    scope_key: 'buy:base:0xabc:0xdef',
    status: 'confirmed'
  };
  const executor = {
    async query(sql) {
      if (sql.includes('INSERT INTO trade_intents')) return { rows: [] };
      if (sql.includes('SELECT * FROM trade_intents')) return { rows: [existing] };
      return { rows: [] };
    }
  };
  const result = await createBuyIntent(executor, {
    chain: { id: 'base' },
    wallet: { address: '0xAbC' },
    inputAmountRaw: '100',
    budgetNative: '0.01',
    snapshotHash: 'snapshot'
  }, {
    signal_id: 77,
    whitelist_id: 8,
    contract_address: '0xDeF',
    slippage: 10
  }, {});
  assert.equal(result.created, false);
  assert.equal(result.merged, false);
  assert.equal(result.duplicate, true);
  assert.equal(result.intent.id, 42);
});

test('stale pre-submit recovery only targets attempts that never crossed the funds-write boundary', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT attempt.*')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const fakeDb = { pool: { async connect() { return client; } } };
  assert.deepEqual(await recoverStalePreSubmitAttempts(90, 10, fakeDb), []);
  const selection = calls.find((call) => call.sql.includes('SELECT attempt.*'));
  assert.match(selection.sql, /funds_write_started_at IS NULL/);
  assert.match(selection.sql, /status IN\('reserved','preparing'\)/);
});
