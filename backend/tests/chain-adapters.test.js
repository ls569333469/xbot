const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSwapParams,
  nativeFeeFields,
  resolveGasPriceWei
} = require('../domains/trade/chain-adapters');

function withoutGasOverrides(run) {
  const previousBsc = process.env.GMGN_BSC_GAS_PRICE;
  const previousBase = process.env.GMGN_BASE_GAS_PRICE;
  delete process.env.GMGN_BSC_GAS_PRICE;
  delete process.env.GMGN_BASE_GAS_PRICE;
  try {
    return run();
  } finally {
    if (previousBsc === undefined) delete process.env.GMGN_BSC_GAS_PRICE;
    else process.env.GMGN_BSC_GAS_PRICE = previousBsc;
    if (previousBase === undefined) delete process.env.GMGN_BASE_GAS_PRICE;
    else process.env.GMGN_BASE_GAS_PRICE = previousBase;
  }
}

test('BSC swap uses the live GMGN gas price and fails closed without it', () => {
  withoutGasOverrides(() => {
    assert.equal(resolveGasPriceWei('bsc', { average: '120000000' }), '120000000');
    const params = buildSwapParams({
      chain: 'bsc',
      walletAddress: '0x1111111111111111111111111111111111111111',
      inputToken: '0x0000000000000000000000000000000000000000',
      outputToken: '0x2222222222222222222222222222222222222222',
      inputAmountRaw: '5000000000000000',
      slippage: 10,
      conditionOrders: [{ order_type: 'profit_stop' }],
      gas: { average: '120000000' }
    });
    assert.equal(params.gas_price, '120000000');
    assert.equal(params.is_anti_mev, true);
    assert.throws(
      () => resolveGasPriceWei('bsc', {}),
      (error) => error.code === 'GMGN_GAS_PRICE_UNAVAILABLE'
    );
  });
});

test('Base swap sends numeric gas without unsupported anti-MEV fields', () => {
  withoutGasOverrides(() => {
    const params = buildSwapParams({
      chain: 'base',
      walletAddress: '0x1111111111111111111111111111111111111111',
      inputToken: '0x0000000000000000000000000000000000000000',
      outputToken: '0x2222222222222222222222222222222222222222',
      inputAmountRaw: '1000000000000000',
      slippage: 10,
      conditionOrders: [],
      gas: { average: '17500000' }
    });
    assert.equal(params.gas_price, '17500000');
    assert.equal('is_anti_mev' in params, false);
  });
});

test('Ethereum uses an official gas tier and only enables auto fee for strategies', () => {
  const previous = process.env.GMGN_ETH_GAS_LEVEL;
  process.env.GMGN_ETH_GAS_LEVEL = 'medium';
  try {
    const plain = buildSwapParams({
      chain: 'eth',
      walletAddress: '0x1111111111111111111111111111111111111111',
      inputToken: '0x0000000000000000000000000000000000000000',
      outputToken: '0x2222222222222222222222222222222222222222',
      inputAmountRaw: '1000000000000000',
      slippage: 10,
      conditionOrders: []
    });
    assert.equal(plain.gas_level, 'average');
    assert.equal('auto_fee' in plain, false);

    const protectedSwap = buildSwapParams({
      chain: 'eth',
      walletAddress: '0x1111111111111111111111111111111111111111',
      inputToken: '0x0000000000000000000000000000000000000000',
      outputToken: '0x2222222222222222222222222222222222222222',
      inputAmountRaw: '1000000000000000',
      slippage: 10,
      conditionOrders: [{ order_type: 'loss_stop' }]
    });
    assert.equal(protectedSwap.auto_fee, true);
  } finally {
    if (previous === undefined) delete process.env.GMGN_ETH_GAS_LEVEL;
    else process.env.GMGN_ETH_GAS_LEVEL = previous;
  }
});

test('all execution chains enforce retry fee caps and Robinhood rejects retry fee guessing', () => {
  const originalPriority = process.env.GMGN_SOL_PRIORITY_FEE;
  const originalTip = process.env.GMGN_SOL_TIP_FEE;
  process.env.GMGN_SOL_PRIORITY_FEE = '0.00001';
  process.env.GMGN_SOL_TIP_FEE = '0.00001';
  try {
    const sol = nativeFeeFields('sol', false, {}, {
      attemptNo: 2,
      retryConfig: { maxRetryFeeNative: 0.00002, feeEscalationEnabled: false }
    });
    assert.equal(sol.priority_fee, '0.00001');
    assert.throws(() => nativeFeeFields('sol', false, {}, {
      attemptNo: 2,
      retryConfig: { maxRetryFeeNative: 0.000019, feeEscalationEnabled: false }
    }), error => error.code === 'RETRY_FEE_CAP_EXCEEDED');

    withoutGasOverrides(() => {
      const gas = { average: '100000000', high: '150000000', estimated_gas: '21000' };
      const bsc = nativeFeeFields('bsc', false, gas, {
        attemptNo: 2,
        retryConfig: { maxRetryFeeNative: 0.00001, feeEscalationEnabled: false }
      });
      assert.equal(bsc.gas_price, '100000000');
      assert.equal(bsc.is_anti_mev, true);

      const base = nativeFeeFields('base', false, gas, {
        attemptNo: 2,
        retryConfig: { maxRetryFeeNative: 0.00001, feeEscalationEnabled: false }
      });
      assert.equal(base.gas_price, '100000000');
      assert.equal('is_anti_mev' in base, false);
    });

    const ethGas = { average: '10000000000', high: '15000000000', estimated_gas: '21000' };
    assert.equal(nativeFeeFields('eth', false, ethGas, {
      attemptNo: 2,
      retryConfig: { maxRetryFeeNative: 0.001, feeEscalationEnabled: false }
    }).gas_level, 'average');
    assert.throws(() => nativeFeeFields('eth', false, ethGas, {
      attemptNo: 2,
      retryConfig: { maxRetryFeeNative: 0.0001, feeEscalationEnabled: false }
    }), error => error.code === 'RETRY_FEE_CAP_EXCEEDED');

    assert.deepEqual(nativeFeeFields('robinhood', false, {}, { attemptNo: 1 }), {});
    assert.throws(() => nativeFeeFields('robinhood', false, {}, {
      attemptNo: 2,
      retryConfig: { maxRetryFeeNative: 1 }
    }), error => error.code === 'RETRY_RUNTIME_DISABLED');
  } finally {
    if (originalPriority === undefined) delete process.env.GMGN_SOL_PRIORITY_FEE;
    else process.env.GMGN_SOL_PRIORITY_FEE = originalPriority;
    if (originalTip === undefined) delete process.env.GMGN_SOL_TIP_FEE;
    else process.env.GMGN_SOL_TIP_FEE = originalTip;
  }
});
