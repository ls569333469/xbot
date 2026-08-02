const assert = require('node:assert/strict');
const test = require('node:test');
const budgetReset = require('../jobs/budget-reset');
const { exitThresholds, tokenPriceUsd } = require('../jobs/price-monitor');

test('legacy budget reset cannot clear cumulative P9 balances', async () => {
  assert.deepEqual(await budgetReset.reset(), {
    status: 'disabled',
    reason: 'P9_LEDGER_IS_CUMULATIVE'
  });
});

test('price monitor reads the official nested GMGN price contract', () => {
  assert.equal(tokenPriceUsd({ decimals: 9, price: { price: '0.00125' } }), 0.00125);
});

test('price monitor keeps a NULL stop-loss threshold disabled for no-stop strategies', () => {
  assert.deepEqual(exitThresholds({ tp_pct: 100, sl_pct: null }), {
    takeProfit: 100,
    stopLoss: null
  });
  assert.deepEqual(exitThresholds({ tp_pct: undefined, sl_pct: undefined }), {
    takeProfit: null,
    stopLoss: null
  });
});
