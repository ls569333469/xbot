const assert = require('node:assert/strict');
const test = require('node:test');
const {
  clonePreset,
  compileExitStrategy,
  normalizeExitStrategy
} = require('../domains/trade/exit-strategy-compiler');

test('compiles moonbag strategy into official GMGN condition orders', () => {
  const compiled = compileExitStrategy(clonePreset('moonbag_trailing'));
  assert.deepEqual(compiled.conditionOrders, [
    { side: 'sell', sell_ratio: '50', order_type: 'profit_stop', price_scale: '100' },
    { side: 'sell', sell_ratio: '25', order_type: 'profit_stop', price_scale: '300' },
    {
      side: 'sell',
      sell_ratio: '25',
      order_type: 'profit_stop_trace',
      price_scale: '900',
      drawdown_rate: '40'
    }
  ]);
});

test('keeps an explicit no-stop strategy unprotected', () => {
  const compiled = compileExitStrategy(clonePreset('principal_no_stop'));
  assert.equal(compiled.conditionOrders.length, 1);
  assert.equal(compiled.conditionOrders.some((order) => order.order_type === 'loss_stop'), false);
});

test('keeps legacy TP and SL values as an equivalent fallback strategy', () => {
  const compiled = compileExitStrategy(null, { auto_tp_pct: 125, auto_sl_pct: 18 });
  assert.equal(compiled.conditionOrders[0].price_scale, '125');
  assert.equal(compiled.conditionOrders[1].price_scale, '18');
});

test('rejects overselling, unordered take profits, and more than ten legs', () => {
  assert.throws(() => normalizeExitStrategy({
    legs: [
      { type: 'take_profit', trigger_pct: 200, sell_pct: 60 },
      { type: 'take_profit', trigger_pct: 100, sell_pct: 50 }
    ]
  }), /strictly increasing/);
  assert.throws(() => normalizeExitStrategy({
    legs: [
      { type: 'take_profit', trigger_pct: 100, sell_pct: 60 },
      { type: 'trailing_take_profit', activation_pct: 300, drawdown_pct: 20, sell_pct: 50 }
    ]
  }), /cannot sell more than 100%/);
  assert.throws(() => normalizeExitStrategy({
    legs: Array.from({ length: 11 }, (_, index) => ({
      type: 'take_profit', trigger_pct: index + 1, sell_pct: 1
    }))
  }), /At most 10/);
});
