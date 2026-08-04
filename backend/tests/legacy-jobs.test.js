const assert = require('node:assert/strict');
const test = require('node:test');
const { exitThresholds, tokenPriceUsd } = require('../jobs/price-monitor');

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
