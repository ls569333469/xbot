const gmgnAdapter = require('../../lib/gmgn-adapter');
const { requiresProviderGasPrice } = require('./chain-adapters');

function providerRequestOptions(options, stage) {
  return {
    ...(options.rateLease ? { rateLease: options.rateLease } : {}),
    ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
    requestContext: options.requestContext(stage)
  };
}

function mergeTriggeredTokenInfo(cached, tokenInfo, signal) {
  const expectedAddress = String(signal?.contract_address || '').trim();
  const actualAddress = String(tokenInfo?.address || '').trim();
  const matches = expectedAddress.startsWith('0x')
    ? actualAddress.toLowerCase() === expectedAddress.toLowerCase()
    : actualAddress === expectedAddress;
  if (!matches) {
    const error = new Error('GMGN token info returned a different contract address');
    error.code = 'GMGN_TOKEN_ADDRESS_MISMATCH';
    throw error;
  }
  if (!Number.isInteger(Number(tokenInfo?.decimals))) {
    const error = new Error('GMGN token info did not return valid token decimals');
    error.code = 'GMGN_SCHEMA_INVALID';
    throw error;
  }
  cached.token = {
    ...cached.token,
    raw: tokenInfo.raw || cached.token.raw,
    address: actualAddress,
    name: tokenInfo.name || cached.token.name,
    symbol: tokenInfo.symbol || cached.token.symbol,
    decimals: Number(tokenInfo.decimals),
    priceUsd: tokenInfo.priceUsd ?? cached.token.priceUsd,
    liquidityUsd: tokenInfo.liquidityUsd ?? cached.token.liquidityUsd,
    marketCapUsd: tokenInfo.marketCapUsd ?? cached.token.marketCapUsd,
    rugRatio: tokenInfo.rugRatio ?? cached.token.rugRatio,
    fieldAvailability: tokenInfo.fieldAvailability || cached.token.fieldAvailability
  };
  cached.cacheMeta.token = {
    version: 'p25-triggered-provider-context-v1',
    age_ms: 0,
    hit: false,
    source: 'gmgn_trigger_token_info'
  };
  return cached.token;
}

function assertSecurityContract(security, chainId) {
  if (!security?.raw || typeof security.raw !== 'object' || Array.isArray(security.raw)) {
    const error = new Error('GMGN token security response is not an object');
    error.code = 'GMGN_SECURITY_SCHEMA_INVALID';
    throw error;
  }
  if (['bsc', 'base'].includes(chainId) && security.isHoneypot === null) {
    const error = new Error('GMGN token security response lacks a valid honeypot flag');
    error.code = 'GMGN_SECURITY_SCHEMA_INVALID';
    throw error;
  }
  const rugRatioOptional = chainId === 'robinhood';
  if ((security.rugRatio === null && !rugRatioOptional)
      || (security.rugRatio !== null && (security.rugRatio < 0 || security.rugRatio > 1))) {
    const error = new Error('GMGN token security response lacks a valid rug ratio');
    error.code = 'GMGN_SECURITY_SCHEMA_INVALID';
    throw error;
  }
  if (security.isHoneypot === true) {
    const error = new Error('GMGN reports the token as a honeypot');
    error.code = 'GMGN_SECURITY_HONEYPOT';
    throw error;
  }
  if (security.rugRatio > 0.3) {
    const error = new Error('GMGN reports a rug ratio above the automated-trading limit');
    error.code = 'GMGN_SECURITY_RUG_RISK';
    throw error;
  }
  return security;
}

function normalizeGasPrice(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const error = new Error('GMGN gas price response is not an object');
    error.code = 'GMGN_GAS_SCHEMA_INVALID';
    throw error;
  }
  const nativeTokenUsdPrice = Number(data.native_token_usd_price);
  return {
    ...data,
    native_token_usd_price: Number.isFinite(nativeTokenUsdPrice) && nativeTokenUsdPrice > 0
      ? nativeTokenUsdPrice : null
  };
}

async function buildTriggeredProviderContext(input, dependencies = {}) {
  const access = dependencies.gmgnAccess;
  if (!access) throw new TypeError('gmgnAccess is required');
  const { cached, signal, inputAmountRaw, slippage } = input;
  const terminal = input.mode === 'terminal';
  const securityRequired = terminal && input.securityCheck === true;
  const quoteRequired = terminal && input.quoteRequired === true;
  const gasRequired = terminal && requiresProviderGasPrice(cached.chain.id, cached.gas || {}, {
    attemptNo: input.attemptNo || 1,
    escalating: Boolean(input.escalating)
  });
  const options = {
    rateLease: input.rateLease,
    deadlineAt: input.deadlineAt,
    requestContext: input.requestContext
  };
  const requests = [];
  if (securityRequired) {
    requests.push(['security', access.getTokenSecurity(
      cached.chain.id,
      signal.contract_address,
      providerRequestOptions(options, 'security')
    )]);
  }
  if (gasRequired) {
    requests.push(['gas', access.getGasPrice(
      cached.chain.id,
      providerRequestOptions(options, 'gas')
    )]);
  }
  if (quoteRequired) {
    requests.push(['quote', access.quoteOrder(
      cached.chain.id,
      cached.wallet.address,
      cached.chain.nativeToken,
      signal.contract_address,
      inputAmountRaw,
      Number(slippage),
      providerRequestOptions(options, 'quote')
    )]);
  }
  const responses = await Promise.all(requests.map(async ([stage, promise]) => [stage, await promise]));
  const rawByStage = Object.fromEntries(responses);
  const security = securityRequired
    ? assertSecurityContract(
      gmgnAdapter.normalizeSecurity(rawByStage.security, cached.chain.id),
      cached.chain.id
    )
    : cached.security || gmgnAdapter.normalizeSecurity({}, cached.chain.id);
  const gas = gasRequired ? normalizeGasPrice(rawByStage.gas) : (cached.gas || {});
  const quote = quoteRequired
    ? gmgnAdapter.normalizeQuote(rawByStage.quote)
    : {
      raw: {},
      outputAmountRaw: null,
      minOutputAmountRaw: null,
      inputDecimals: null,
      outputDecimals: null,
      priceImpactPct: null,
      totalCostRaw: null,
      platformFeeRaw: null
    };

  cached.security = security;
  cached.gas = gas;
  if (securityRequired) {
    cached.cacheMeta.security = {
      version: 'p25-triggered-provider-context-v1', age_ms: 0, hit: false,
      source: 'gmgn_trigger_security'
    };
  }
  if (gasRequired) {
    cached.cacheMeta.gas = {
      version: 'p25-triggered-provider-context-v1', age_ms: 0, hit: false,
      source: 'gmgn_trigger_gas'
    };
  }
  return { security, gas, quote };
}

module.exports = {
  assertSecurityContract,
  buildTriggeredProviderContext,
  mergeTriggeredTokenInfo,
  normalizeGasPrice,
  requiresProviderGasPrice,
  providerRequestOptions
};
