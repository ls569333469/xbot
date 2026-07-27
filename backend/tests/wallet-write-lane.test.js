const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WalletWriteLane,
  laneKey,
  normalizedWallet
} = require('../domains/trade/wallet-write-lane');

test('wallet lane normalizes EVM addresses but preserves Solana casing', () => {
  assert.equal(normalizedWallet('base', '  0xAbCd  '), '0xabcd');
  assert.equal(normalizedWallet('sol', '  AbCd  '), 'AbCd');
  assert.equal(laneKey('base', '0xAbCd'), 'wallet_lane:base:0xabcd');
});

test('manual quarantine release requires both reason and evidence', async () => {
  const lane = new WalletWriteLane({ db: {} });
  await assert.rejects(
    lane.releaseQuarantine({ chain: 'base', walletAddress: '0x1', operator: 'admin', reason: '', evidence: {} }),
    error => error.code === 'WALLET_QUARANTINE_AUDIT_REQUIRED'
  );
  await assert.rejects(
    lane.releaseQuarantine({ chain: 'base', walletAddress: '0x1', operator: 'admin', reason: 'checked', evidence: null }),
    error => error.code === 'WALLET_QUARANTINE_AUDIT_REQUIRED'
  );
});

test('stale recovery releases persisted provider orders before quarantining unknown writes', async () => {
  const calls = [];
  const fakeDb = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    }
  };
  const lane = new WalletWriteLane({ db: fakeDb });
  assert.deepEqual(await lane.recoverStaleSubmissions(), []);
  assert.match(calls[0].sql, /provider_order_id IS NOT NULL/);
  assert.match(calls[0].sql, /state = 'idle'/);
  assert.match(calls[1].sql, /state = 'quarantined'/);
  assert.equal(calls.length, 2);
});

test('a terminal provider response without a hash keeps the wallet quarantined for evidence', async () => {
  const calls = [];
  const fakeDb = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ owner_attempt_id: 9, state: 'quarantined' }] };
    }
  };
  const lane = new WalletWriteLane({ db: fakeDb });
  const result = await lane.settleSubmittedOrder({
    id: 9,
    chain: 'base',
    wallet_address: '0xABC'
  }, {
    status: 'failed',
    providerStatus: 'failed',
    providerOrderId: 'order-9',
    txHash: null
  });
  assert.equal(result.state, 'quarantined');
  assert.match(calls[0].sql, /INSERT INTO wallet_write_lanes/);
  assert.equal(calls[0].params[4], 'NO_HASH_FAILURE_EVIDENCE_PENDING');
});

test('a submitted order with a hash releases only its own write lane', async () => {
  const calls = [];
  const fakeDb = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ state: 'idle' }] };
    }
  };
  const lane = new WalletWriteLane({ db: fakeDb });
  await lane.settleSubmittedOrder({ id: 11 }, {
    status: 'pending',
    txHash: '0x123'
  });
  assert.match(calls[0].sql, /WHERE owner_attempt_id = \$1 AND state = 'submitting'/);
  assert.equal(calls[0].params[0], 11);
});
