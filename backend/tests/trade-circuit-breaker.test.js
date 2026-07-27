const assert = require('node:assert/strict');
const test = require('node:test');
const { TradeCircuitBreaker } = require('../domains/trade/trade-circuit-breaker');

function circuitDb() {
  const state = {
    chain: 'base', state: 'open', consecutive_failures: 0, threshold: 3,
    last_failure_attempt_id: null
  };
  const notifications = [];
  return {
    state,
    notifications,
    async query(sql, params = []) {
      if (/INSERT INTO chain_trade_circuits/.test(sql)) return { rows: [] };
      if (/SELECT \* FROM chain_trade_circuits/.test(sql)) {
        if (/state = 'tripped'/.test(sql)) return { rows: state.state === 'tripped' ? [{ ...state }] : [] };
        return { rows: [{ ...state }] };
      }
      if (/UPDATE chain_trade_circuits/.test(sql) && /consecutive_failures = \$3/.test(sql)) {
        state.state = params[1] ? 'tripped' : 'open';
        state.consecutive_failures = params[2];
        state.threshold = params[3];
        state.last_failure_attempt_id = params[4];
        return { rows: [{ ...state }] };
      }
      if (/UPDATE chain_trade_circuits/.test(sql) && /last_success_attempt_id/.test(sql)) {
        state.state = 'open';
        state.consecutive_failures = 0;
        return { rows: [{ ...state }] };
      }
      if (/INSERT INTO notification_outbox/.test(sql)) {
        notifications.push(params);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test('consecutive definitive failures trip only the selected chain buy circuit', async () => {
  const db = circuitDb();
  const breaker = new TradeCircuitBreaker({ db });
  await breaker.recordDefinitiveFailure('base', 1, 3);
  await breaker.recordDefinitiveFailure('base', 2, 3);
  const tripped = await breaker.recordDefinitiveFailure('base', 3, 3);
  assert.equal(tripped.state, 'tripped');
  assert.equal(tripped.consecutive_failures, 3);
  assert.equal(db.notifications.length, 1);
  await assert.rejects(
    breaker.assertBuyAllowed('base'),
    error => error.code === 'CHAIN_CONSECUTIVE_FAILURE_LOCK'
  );
  await breaker.recordConfirmedTrade('base', 4);
  assert.equal(db.state.state, 'open');
  assert.doesNotReject(() => breaker.assertBuyAllowed('base'));
});
