const assert = require('node:assert/strict');
const test = require('node:test');
const { addRaw, decimalToRaw, minRaw, rawToDecimal, subtractRaw } = require('../lib/decimal-units');

test('decimal helpers never use floating point for raw token amounts', () => {
  assert.equal(decimalToRaw('0.10000000', 9), '100000000');
  assert.equal(rawToDecimal('4171525653', 6), '4171.525653');
  assert.equal(minRaw('10', '2', '30'), '2');
  assert.equal(addRaw('9007199254740993', '7'), '9007199254741000');
  assert.equal(subtractRaw('100', '99'), '1');
  assert.throws(() => subtractRaw('1', '2'), error => error.code === 'RAW_AMOUNT_UNDERFLOW');
  assert.throws(() => decimalToRaw('0.0001', 3), error => error.code === 'DECIMAL_PRECISION_EXCEEDED');
});

test('raw conversion preserves the full fractional precision', () => {
  assert.equal(rawToDecimal('97582155', 9), '0.097582155');
  assert.equal(rawToDecimal('4132773117', 6), '4132.773117');
  assert.equal(rawToDecimal('1200000', 6), '1.2');
});
