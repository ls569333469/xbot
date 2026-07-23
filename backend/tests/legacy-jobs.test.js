const assert = require('node:assert/strict');
const test = require('node:test');
const budgetReset = require('../jobs/budget-reset');
const { tokenPriceUsd } = require('../jobs/price-monitor');

test('legacy budget reset cannot clear cumulative P9 balances', async () => {
  assert.deepEqual(await budgetReset.reset(), {
    status: 'disabled',
    reason: 'P9_LEDGER_IS_CUMULATIVE'
  });
});

test('price monitor reads the official nested GMGN price contract', () => {
  assert.equal(tokenPriceUsd({ decimals: 9, price: { price: '0.00125' } }), 0.00125);
});
