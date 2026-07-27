const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ledgerUsdAmount,
  reservationUnitUsd,
  unusedFeeEnvelope
} = require('../domains/trade/budget-accounting');

test('budget accounting separates principal, fee use, and unused fee envelope', () => {
  const reservation = {
    amount_native: '1',
    fee_native: '0.2',
    fee_used_native: '0.05',
    amount_usd_snapshot: '360'
  };
  assert.equal(reservationUnitUsd(reservation), 300);
  assert.equal(ledgerUsdAmount(reservation, 1, 0), 300);
  assert.equal(ledgerUsdAmount(reservation, 0, 0.05), 15);
  assert.ok(Math.abs(unusedFeeEnvelope(reservation) - 0.15) < 1e-12);
});

test('budget accounting fails closed for incomplete or invalid snapshots', () => {
  assert.equal(reservationUnitUsd({ amount_native: 1, fee_native: 0, amount_usd_snapshot: null }), null);
  assert.equal(ledgerUsdAmount({ amount_native: 1, fee_native: 0, amount_usd_snapshot: null }, 1), null);
  assert.equal(unusedFeeEnvelope({ fee_native: -1, fee_used_native: 0 }), 0);
  assert.equal(unusedFeeEnvelope({ fee_native: 0.1, fee_used_native: 0.2 }), 0);
});
