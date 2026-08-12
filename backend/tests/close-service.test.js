const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CANCEL_VERIFY_DELAYS_MS,
  cancelConfirmed,
  cancellationFailureCode,
  closeRequestContext,
  closeSnapshotIdentity,
  normalizeBalanceRaw,
  normalizeCancellationWriteError,
  resolveCloseSlippage,
  selectSellAmountRaw,
  sumRemainingRaw,
  waitForStrategyCancellation
} = require('../domains/trade/close-service');

test('sell swaps use an attempt session independent from the originating buy signal', () => {
  const context = closeRequestContext({
    id: 44,
    signal_id: 820,
    whitelist_id: 9,
    signal_trace_id: 'buy-trace'
  }, 'swap', { attemptId: 155, side: 'sell' });
  assert.equal(context.signalId, 820);
  assert.equal(context.executionSessionId, 'attempt:155');
  assert.equal(context.attemptId, 155);
  assert.equal(context.positionId, 44);
  assert.equal(context.side, 'sell');
});

test('close service sums lots and accepts only explicit strategy cancellation', () => {
  assert.equal(sumRemainingRaw([
    { remaining_amount_raw: '9007199254740993' },
    { remaining_amount_raw: '7' }
  ]), '9007199254741000');
  assert.equal(cancelConfirmed({ success: true }), true);
  assert.equal(cancelConfirmed({ status: 'cancelled' }), true);
  assert.equal(cancelConfirmed({ status: 'running' }), false);
  assert.equal(cancellationFailureCode({}, {
    status: 'cancelled',
    closeTxHash: null
  }), null);
  assert.equal(cancellationFailureCode({}, null), 'STRATEGY_CANCEL_UNCERTAIN');
  assert.equal(cancellationFailureCode({ success: true }, {
    status: 'triggered',
    closeTxHash: 'tx-hash'
  }), 'STRATEGY_TRIGGERED_DURING_CANCEL');
});

test('close service converts display balances only with known decimals', () => {
  assert.equal(normalizeBalanceRaw({ balance_raw: '1234567' }, 6), '1234567');
  assert.equal(normalizeBalanceRaw({ balance: '1.234567' }, 6), '1234567');
});

test('close service treats a non-definitive cancellation write failure as uncertain', () => {
  const timeout = Object.assign(new Error('request timed out'), { code: 'GMGN_REQUEST_TIMEOUT' });
  const normalized = normalizeCancellationWriteError(timeout);
  assert.equal(normalized.code, 'STRATEGY_CANCEL_UNCERTAIN');
  assert.equal(normalized.cause, timeout);

  const rejection = Object.assign(new Error('invalid request'), {
    name: 'GmgnOpenApiError',
    status: 400
  });
  assert.equal(normalizeCancellationWriteError(rejection), rejection);
});

test('local rate reservation failure is a definitive pre-submit rejection', () => {
  const error = Object.assign(new Error('GMGN rate reservation is invalid or exhausted'), {
    code: 'GMGN_RATE_RESERVATION_INVALID'
  });
  const { classifyWriteError } = require('../domains/trade/gmgn-write-error-classifier');
  assert.deepEqual(classifyWriteError(error, { writeStarted: false }), {
    kind: 'rejected',
    code: 'GMGN_RATE_RESERVATION_INVALID',
    retryEligible: false,
    quarantine: false
  });
});

test('close service never sells same-CA wallet balance outside tracked lots', () => {
  assert.equal(selectSellAmountRaw('150000000', '100000000', '150000000'), '100000000');
  assert.equal(selectSellAmountRaw('100000000', '100000000', '75000000'), '75000000');
});

test('close service defaults to whitelist slippage and rejects missing or invalid values', () => {
  assert.equal(resolveCloseSlippage({ whitelist_slippage: '10.00' }), 10);
  assert.equal(resolveCloseSlippage({ whitelist_slippage: '10.00' }, 5), 5);
  assert.throws(
    () => resolveCloseSlippage({ whitelist_slippage: null }),
    (error) => error.code === 'CLOSE_SLIPPAGE_INVALID'
  );
  assert.throws(
    () => resolveCloseSlippage({ whitelist_slippage: '10.00' }, 0),
    (error) => error.code === 'CLOSE_SLIPPAGE_INVALID'
  );
});

test('close snapshot identity excludes mutable provider quote output', () => {
  const base = {
    position: { id: 42, status: 'open_protected', contract_address: 'token' },
    chain: { id: 'sol' },
    walletAddress: 'wallet',
    tokenDecimals: 6,
    remainingRaw: '19168440',
    walletAvailableRaw: '19168440',
    inputAmountRaw: '19168440',
    percent: 100,
    slippage: 10,
    strategyStates: [{
      group: { id: 29, provider_order_id: 'strategy-1' },
      status: 'running'
    }]
  };
  const first = closeSnapshotIdentity({ ...base, quote: { outputAmountRaw: '4900000' } });
  const second = closeSnapshotIdentity({ ...base, quote: { outputAmountRaw: '4800000' } });
  assert.deepEqual(first, second);
  assert.equal('quote' in first, false);
});

test('close service waits for provider history to confirm strategy cancellation', async () => {
  let queryCount = 0;
  const slept = [];
  const verification = await waitForStrategyCancellation({
    response: { success: true },
    deadlineAt: 10_000,
    now: () => 0,
    delaysMs: [0, 1000, 2000],
    sleepFn: async (ms) => slept.push(ms),
    verify: async () => {
      queryCount += 1;
      return queryCount < 3
        ? { status: 'running', closeTxHash: null }
        : { status: 'cancelled', closeTxHash: null };
    }
  });

  assert.equal(verification.status, 'cancelled');
  assert.equal(queryCount, 3);
  assert.deepEqual(slept, [1000, 2000]);
});

test('close service blocks a duplicate sell when strategy triggers during cancellation', async () => {
  await assert.rejects(
    waitForStrategyCancellation({
      response: { success: true },
      deadlineAt: 10_000,
      now: () => 0,
      delaysMs: [0],
      verify: async () => ({ status: 'triggered', closeTxHash: 'strategy-close-tx' })
    }),
    (error) => error.code === 'STRATEGY_TRIGGERED_DURING_CANCEL'
  );
});

test('close service tolerates a transient strategy-history query failure', async () => {
  let queryCount = 0;
  const verification = await waitForStrategyCancellation({
    response: { success: true },
    deadlineAt: 10_000,
    now: () => 0,
    delaysMs: [0, 1000],
    sleepFn: async () => {},
    verify: async () => {
      queryCount += 1;
      if (queryCount === 1) throw Object.assign(new Error('temporary timeout'), {
        code: 'GMGN_REQUEST_TIMEOUT'
      });
      return { status: 'cancelled', closeTxHash: null };
    }
  });

  assert.equal(verification.status, 'cancelled');
  assert.equal(queryCount, 2);
});

test('close service keeps cancellation uncertain after its bounded verification window', async () => {
  let now = 0;
  let queryCount = 0;
  await assert.rejects(
    waitForStrategyCancellation({
      response: { success: true },
      deadlineAt: 1500,
      now: () => now,
      delaysMs: [0, 1000, 1000],
      sleepFn: async (ms) => { now += ms; },
      verify: async () => {
        queryCount += 1;
        return { status: 'running', closeTxHash: null };
      }
    }),
    (error) => error.code === 'STRATEGY_CANCEL_UNVERIFIED'
  );
  assert.equal(queryCount, 2);
  assert.equal(CANCEL_VERIFY_DELAYS_MS.reduce((total, ms) => total + ms, 0), 28_000);
});
