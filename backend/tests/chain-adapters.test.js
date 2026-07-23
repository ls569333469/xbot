const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSwapParams,
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
