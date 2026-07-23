const assert = require('node:assert/strict');
const test = require('node:test');
const { principalUsdCost } = require('../domains/trade/trade-repository');

test('position lot USD cost comes from the native budget snapshot, not the output token price', () => {
  const cost = principalUsdCost('0.05', {
    amount_native: '0.05',
    fee_native: '0.0002',
    amount_usd_snapshot: '3.945782688254'
  });
  assert.ok(Math.abs(cost - 3.9300624385) < 1e-12);
  assert.equal(principalUsdCost('0.05', {
    amount_native: null,
    fee_native: null,
    amount_usd_snapshot: null
  }), null);
});
