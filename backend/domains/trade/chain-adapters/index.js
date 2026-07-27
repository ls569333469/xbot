const { isAddress } = require('ethers');
const {
  CHAIN_REGISTRY,
  assertChainRegistry,
  getAllChains,
  getExecutionChains
} = require('../../../lib/chain-config');
const { compileExitStrategy } = require('../exit-strategy-compiler');

assertChainRegistry();
const SUPPORTED_CHAINS = new Set(getAllChains().map((chain) => chain.id));
const LIVE_EXECUTION_CHAINS = new Set(getExecutionChains().map((chain) => chain.id));

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

function resolveGasPriceWei(chainId, gas = {}, preferredLevel = 'average') {
  const chain = requireChain(chainId);
  if (!['bsc', 'base'].includes(chain.id)) return null;
  const envValue = normalizeGasPriceWei(process.env[`GMGN_${chain.id.toUpperCase()}_GAS_PRICE`]);
  const providerValue = normalizeGasPriceWei(
    gas?.[preferredLevel] ?? gas?.average ?? gas?.suggest_base_fee ?? gas?.high ?? gas?.low
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

function estimatedGasUnits(gas = {}) {
  const value = gas.estimated_gas ?? gas.estimate_gas ?? gas.gas_limit ?? gas.gasLimit;
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) && BigInt(normalized) > 0n ? BigInt(normalized) : null;
}

function assertRetryFeeCap(chainId, gasPriceWei, gas, retryConfig) {
  const cap = Number(retryConfig?.maxRetryFeeNative || 0);
  const units = estimatedGasUnits(gas);
  if (!Number.isFinite(cap) || cap <= 0 || !units) {
    const error = new Error(`Cannot prove the ${chainId} retry fee is within its absolute cap`);
    error.code = 'RETRY_FEE_CAP_UNVERIFIABLE';
    throw error;
  }
  const projected = Number(BigInt(gasPriceWei) * units) / 1e18;
  if (!Number.isFinite(projected) || projected > cap) {
    const error = new Error(`Projected ${chainId} retry fee exceeds its configured cap`);
    error.code = 'RETRY_FEE_CAP_EXCEEDED';
    throw error;
  }
  return projected;
}

function nativeFeeFields(chainId, hasConditions, gas, retryOptions = {}) {
  const chain = requireChain(chainId);
  const attemptNo = Math.max(1, Number(retryOptions.attemptNo || 1));
  const isRetry = attemptNo > 1;
  if (chain.id === 'robinhood') {
    if (isRetry) {
      const error = new Error('Robinhood retry fee fields are not contract-verified');
      error.code = 'RETRY_RUNTIME_DISABLED';
      throw error;
    }
    return {};
  }
  const escalating = isRetry && Boolean(retryOptions.retryConfig?.feeEscalationEnabled);
  if (chain.id === 'sol') {
    let priorityFee = Number(process.env.GMGN_SOL_PRIORITY_FEE || '0.00001');
    let tipFee = Number(process.env.GMGN_SOL_TIP_FEE || '0.00001');
    if (escalating) {
      const multiplier = attemptNo === 2 ? 1.25 : 1.5;
      priorityFee *= multiplier;
      tipFee *= multiplier;
    }
    if (isRetry) {
      const cap = Number(retryOptions.retryConfig?.maxRetryFeeNative || 0);
      if (!Number.isFinite(cap) || cap <= 0 || priorityFee + tipFee > cap) {
        const error = new Error('Projected Solana retry fee exceeds or lacks an absolute cap');
        error.code = cap > 0 ? 'RETRY_FEE_CAP_EXCEEDED' : 'RETRY_FEE_CAP_UNVERIFIABLE';
        throw error;
      }
    }
    return {
      is_anti_mev: true,
      ...(hasConditions || isRetry ? {
        priority_fee: String(priorityFee),
        tip_fee: String(tipFee)
      } : {})
    };
  }
  if (chain.id === 'bsc') {
    const gasPrice = resolveGasPriceWei(chain.id, gas, escalating ? 'high' : 'average');
    if (isRetry) assertRetryFeeCap(chain.id, gasPrice, gas, retryOptions.retryConfig);
    return {
      is_anti_mev: true,
      gas_price: gasPrice,
      ...(hasConditions && process.env.GMGN_BSC_TIP_FEE
        ? { tip_fee: String(process.env.GMGN_BSC_TIP_FEE) }
        : {})
    };
  }
  if (chain.id === 'base') {
    const gasPrice = resolveGasPriceWei(chain.id, gas, escalating ? 'high' : 'average');
    if (isRetry) assertRetryFeeCap(chain.id, gasPrice, gas, retryOptions.retryConfig);
    return {
      gas_price: gasPrice
    };
  }
  const configuredLevel = String(process.env.GMGN_ETH_GAS_LEVEL || 'average').toLowerCase();
  const gasLevel = ['low', 'average', 'high'].includes(configuredLevel)
    ? configuredLevel
    : 'average';
  if (isRetry) {
    const selectedGasPrice = normalizeGasPriceWei(gas?.[escalating ? 'high' : gasLevel]);
    if (!selectedGasPrice) {
      const error = new Error('Ethereum gas estimate is unavailable for capped retry');
      error.code = 'RETRY_FEE_CAP_UNVERIFIABLE';
      throw error;
    }
    assertRetryFeeCap(chain.id, selectedGasPrice, gas, retryOptions.retryConfig);
  }
  return {
    gas_level: escalating ? 'high' : gasLevel,
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
    ...nativeFeeFields(chain.id, conditions.length > 0, input.gas, {
      attemptNo: input.attemptNo,
      retryConfig: input.retryConfig
    }),
    ...(conditions.length > 0 ? {
      condition_orders: conditions,
      sell_ratio_type: 'buy_amount'
    } : {})
  };
}

function buildConditionOrders(whitelist) {
  return compileExitStrategy(whitelist.exit_strategy, whitelist).conditionOrders;
}

function rpcConfig(chainId) {
  const chain = requireChain(chainId);
  return {
    url: String(process.env[chain.rpcEnvKey] || '').trim() || null,
    chainId: chain.chainId || null,
    confirmations: Math.max(1, Number(
      process.env[`GMGN_${chain.id.toUpperCase()}_CONFIRMATIONS`]
        || chain.defaultConfirmations
    ))
  };
}

module.exports = {
  SUPPORTED_CHAINS,
  LIVE_EXECUTION_CHAINS,
  buildConditionOrders,
  buildSwapParams,
  assertRetryFeeCap,
  estimatedGasUnits,
  nativeFeeFields,
  normalizeGasPriceWei,
  requireChain,
  resolveGasPriceWei,
  rpcConfig,
  validateTokenAddress
};
