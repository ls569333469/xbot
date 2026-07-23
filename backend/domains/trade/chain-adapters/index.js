const { isAddress } = require('ethers');
const { CHAIN_REGISTRY } = require('../../../lib/chain-config');

const SUPPORTED_CHAINS = new Set(['sol', 'bsc', 'base', 'eth']);

function requireChain(chainId) {
  const chain = String(chainId || '').trim().toLowerCase();
  if (!SUPPORTED_CHAINS.has(chain)) {
    const error = new Error(`Unsupported live chain: ${chainId}`);
    error.code = 'LIVE_CHAIN_UNSUPPORTED';
    throw error;
  }
  return { id: chain, ...CHAIN_REGISTRY[chain] };
}

function validateTokenAddress(chainId, address) {
  const chain = requireChain(chainId);
  const value = String(address || '').trim();
  const valid = chain.id === 'sol'
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
    : isAddress(value);
  if (!valid) {
    const error = new Error(`Invalid ${chain.id} token address`);
    error.code = 'TOKEN_ADDRESS_INVALID';
    throw error;
  }
  return chain.id === 'sol' ? value : value.toLowerCase();
}

const EVM_MIN_GAS_PRICE_WEI = Object.freeze({
  bsc: 50_000_000n,
  base: 10_000_000n
});

function normalizeGasPriceWei(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized) || BigInt(normalized) <= 0n) return null;
  return normalized;
}

function resolveGasPriceWei(chainId, gas = {}) {
  const chain = requireChain(chainId);
  if (!['bsc', 'base'].includes(chain.id)) return null;
  const envValue = normalizeGasPriceWei(process.env[`GMGN_${chain.id.toUpperCase()}_GAS_PRICE`]);
  const providerValue = normalizeGasPriceWei(
    gas?.average ?? gas?.suggest_base_fee ?? gas?.high ?? gas?.low
  );
  const selected = envValue || providerValue;
  if (!selected) {
    const error = new Error(`GMGN ${chain.id} gas price is unavailable`);
    error.code = 'GMGN_GAS_PRICE_UNAVAILABLE';
    throw error;
  }
  if (BigInt(selected) < EVM_MIN_GAS_PRICE_WEI[chain.id]) {
    const error = new Error(`GMGN ${chain.id} gas price is below the supported minimum`);
    error.code = 'GMGN_GAS_PRICE_TOO_LOW';
    throw error;
  }
  return selected;
}

function nativeFeeFields(chainId, hasConditions, gas) {
  const chain = requireChain(chainId);
  if (chain.id === 'sol') {
    return {
      is_anti_mev: true,
      ...(hasConditions ? {
        priority_fee: String(process.env.GMGN_SOL_PRIORITY_FEE || '0.00001'),
        tip_fee: String(process.env.GMGN_SOL_TIP_FEE || '0.00001')
      } : {})
    };
  }
  if (chain.id === 'bsc') {
    return {
      is_anti_mev: true,
      gas_price: resolveGasPriceWei(chain.id, gas),
      ...(hasConditions && process.env.GMGN_BSC_TIP_FEE
        ? { tip_fee: String(process.env.GMGN_BSC_TIP_FEE) }
        : {})
    };
  }
  if (chain.id === 'base') {
    return {
      gas_price: resolveGasPriceWei(chain.id, gas)
    };
  }
  const configuredLevel = String(process.env.GMGN_ETH_GAS_LEVEL || 'average').toLowerCase();
  const gasLevel = ['low', 'average', 'high'].includes(configuredLevel)
    ? configuredLevel
    : 'average';
  return {
    gas_level: gasLevel,
    ...(hasConditions ? { auto_fee: true } : {})
  };
}

function buildSwapParams(input) {
  const chain = requireChain(input.chain);
  const conditions = Array.isArray(input.conditionOrders) ? input.conditionOrders : [];
  return {
    chain: chain.id,
    from_address: input.walletAddress,
    input_token: input.inputToken,
    output_token: input.outputToken,
    input_amount: String(input.inputAmountRaw),
    slippage: Number(input.slippage),
    ...nativeFeeFields(chain.id, conditions.length > 0, input.gas),
    ...(conditions.length > 0 ? {
      condition_orders: conditions,
      sell_ratio_type: 'buy_amount'
    } : {})
  };
}

function buildConditionOrders(whitelist) {
  const orders = [];
  const takeProfit = Number(whitelist.auto_tp_pct || 0);
  const stopLoss = Number(whitelist.auto_sl_pct || 0);
  if (Number.isFinite(takeProfit) && takeProfit > 0) {
    orders.push({
      order_type: 'profit_stop',
      side: 'sell',
      price_scale: String(takeProfit),
      sell_ratio: '100'
    });
  }
  if (Number.isFinite(stopLoss) && stopLoss > 0) {
    orders.push({
      order_type: 'loss_stop',
      side: 'sell',
      price_scale: String(stopLoss),
      sell_ratio: '100'
    });
  }
  return orders.slice(0, 10);
}

function rpcConfig(chainId) {
  const chain = requireChain(chainId);
  const key = {
    sol: 'SOLANA_RPC_URL',
    bsc: 'BSC_RPC_URL',
    base: 'BASE_RPC_URL',
    eth: 'ETH_RPC_URL'
  }[chain.id];
  return {
    url: String(process.env[key] || '').trim() || null,
    chainId: chain.chainId || null,
    confirmations: Math.max(1, Number(process.env[`GMGN_${chain.id.toUpperCase()}_CONFIRMATIONS`] || (chain.id === 'sol' ? 1 : 2)))
  };
}

module.exports = {
  SUPPORTED_CHAINS,
  buildConditionOrders,
  buildSwapParams,
  nativeFeeFields,
  normalizeGasPriceWei,
  requireChain,
  resolveGasPriceWei,
  rpcConfig,
  validateTokenAddress
};
