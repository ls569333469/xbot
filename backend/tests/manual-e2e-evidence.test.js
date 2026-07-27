const assert = require('node:assert/strict');
const test = require('node:test');
const { summarizeManualE2e } = require('../domains/trade/manual-e2e-evidence');

function completePath(side, offset) {
  return {
    side,
    intent_id: offset,
    intent_status: 'confirmed',
    attempt_id: offset + 1,
    attempt_status: 'confirmed',
    order_id: offset + 2,
    order_status: 'confirmed',
    tx_hash: `tx-${offset}`,
    receipt_id: offset + 3,
    receipt_tx_hash: `tx-${offset}`,
    receipt_status: 'confirmed'
  };
}

function completeFacts() {
  return {
    position: { id: 7, status: 'closed', lot_count: 1, remaining_raw: '0' },
    buy: completePath('buy', 10),
    sell: completePath('sell', 20),
    strategy: {
      strategy_count: 1,
      active_count: 0,
      groups: [{ id: 30, status: 'cancelled' }]
    },
    budget: {
      reservation_id: 40,
      reservation_status: 'committed',
      fee_native: '0.001',
      fee_used_native: '0.0007',
      ledger_types: ['reserve', 'commit', 'release'],
      released_fee_native: '0.0003'
    }
  };
}

test('manual E2E passes only with complete buy, close, receipt, lot, strategy, and budget evidence', () => {
  const summary = summarizeManualE2e(completeFacts());
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.missing, []);
  assert.equal(summary.position.remaining_raw, '0');
});

test('manual E2E records explicit missing evidence instead of passing on sell confirmation alone', () => {
  const facts = completeFacts();
  facts.buy.receipt_status = 'pending';
  facts.strategy.active_count = 1;
  facts.budget.ledger_types = ['reserve'];
  const summary = summarizeManualE2e(facts);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.missing, [
    'BUY_PATH_INCOMPLETE',
    'STRATEGY_NOT_TERMINAL',
    'BUDGET_COMMIT_LEDGER_MISSING'
  ]);
});
