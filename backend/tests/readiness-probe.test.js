const assert = require('node:assert/strict');
const test = require('node:test');
const { jsonb, normalizeTradeEvidence } = require('../domains/trade/readiness-service');

test('readiness probe serializes GMGN balance arrays as JSON for jsonb columns', () => {
  const value = jsonb([{ symbol: 'SOL', balance: '0.5' }]);
  assert.equal(value, '[{"symbol":"SOL","balance":"0.5"}]');
  assert.deepEqual(JSON.parse(value), [{ symbol: 'SOL', balance: '0.5' }]);
});

test('readiness exposes confirmed orders and RPC receipts as per-chain evidence', () => {
  assert.deepEqual(normalizeTradeEvidence({
    confirmed_buy_attempts: '1',
    confirmed_sell_attempts: '1',
    confirmed_orders: '2',
    confirmed_receipts: '2',
    last_confirmed_at: '2026-07-22T00:00:00.000Z'
  }), {
    confirmedBuys: 1,
    confirmedSells: 1,
    confirmedOrders: 2,
    confirmedReceipts: 2,
    lastConfirmedAt: '2026-07-22T00:00:00.000Z'
  });

  assert.deepEqual(normalizeTradeEvidence(), {
    confirmedBuys: 0,
    confirmedSells: 0,
    confirmedOrders: 0,
    confirmedReceipts: 0,
    lastConfirmedAt: null
  });
});
