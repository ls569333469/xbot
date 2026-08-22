const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildGasReserveAdvisory,
  getPositionBalanceState,
  principalUsdCost
} = require('../domains/trade/trade-repository');

test('minimum gas reserve is recorded as a non-blocking advisory for an old balance', () => {
  const previous = process.env.GMGN_MIN_GAS_RESERVE_BASE;
  process.env.GMGN_MIN_GAS_RESERVE_BASE = '0.002';
  try {
    const advisory = buildGasReserveAdvisory({
      chain: { id: 'base' },
      budgetNative: '0.1',
      feeReserveNative: '0.001',
      walletNativeBalance: 0.01,
      walletNativeBalanceSource: 'stale_cache_untrusted',
      cacheMeta: { wallet: { fresh: false, age_ms: 1800000000 } }
    }, { exitGasReserve: 0.002 }, {
      retryEnabled: false,
      maxRetries: 0,
      maxRetryFeeNative: 0
    });

    assert.equal(advisory.code, 'MINIMUM_GAS_RESERVE_BREACH');
    assert.equal(advisory.blocking, false);
    assert.equal(advisory.observed_balance_source, 'stale_cache_untrusted');
    assert.equal(advisory.required_gas_reserve, 0.002);
  } finally {
    if (previous === undefined) delete process.env.GMGN_MIN_GAS_RESERVE_BASE;
    else process.env.GMGN_MIN_GAS_RESERVE_BASE = previous;
  }
});

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

test('position wallet recovery groups the joined signal trace deterministically', async () => {
  let capturedSql = '';
  const result = await getPositionBalanceState(571, {
    async query(sql, params) {
      capturedSql = sql;
      assert.deepEqual(params, [571]);
      return { rows: [{ position_id: 571, trace_id: 'trace-571' }] };
    }
  });

  assert.match(capturedSql, /GROUP BY position\.id, signal\.trace_id/);
  assert.deepEqual(result, { position_id: 571, trace_id: 'trace-571' });
});
