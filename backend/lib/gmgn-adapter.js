const { requireChain } = require('../domains/trade/chain-adapters');

function required(value, field, code = 'GMGN_SCHEMA_INVALID') {
  if (value === undefined || value === null || value === '') {
    const error = new Error(`GMGN response is missing ${field}`);
    error.code = code;
    throw error;
  }
  return value;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value === true || value === 1 || String(value).toLowerCase() === 'true') return true;
  if (value === false || value === 0 || String(value).toLowerCase() === 'false') return false;
  return null;
}

function normalizeUserInfo(data) {
  const wallets = Array.isArray(data?.wallets) ? data.wallets : [];
  return {
    raw: data,
    wallets: wallets.map((wallet) => ({
      chain: String(wallet.chain || '').toLowerCase(),
      address: String(wallet.address || wallet.wallet_address || '').trim(),
      balances: Array.isArray(wallet.balances) ? wallet.balances : []
    })).filter((wallet) => wallet.chain && wallet.address)
  };
}

function selectWallet(data, chainId) {
  const chain = requireChain(chainId);
  const user = normalizeUserInfo(data);
  const matches = user.wallets.filter((wallet) => wallet.chain === chain.id);
  if (matches.length !== 1) {
    const error = new Error(`GMGN account must expose exactly one ${chain.id} wallet`);
    error.code = matches.length === 0 ? 'GMGN_WALLET_MISSING' : 'GMGN_WALLET_AMBIGUOUS';
    throw error;
  }
  return matches[0];
}

function walletNativeBalance(wallet, symbol) {
  const balance = (wallet?.balances || []).find((item) => (
    String(item.symbol || '').toUpperCase() === String(symbol || '').toUpperCase()
  ));
  const value = Number(balance?.balance ?? balance?.amount ?? balance?.ui_amount);
  return Number.isFinite(value) ? value : null;
}

function walletNativePriceUsd(wallet, symbol) {
  const balance = (wallet?.balances || []).find((item) => (
    String(item.symbol || '').toUpperCase() === String(symbol || '').toUpperCase()
  ));
  const price = Number(balance?.price_usd ?? balance?.price);
  if (Number.isFinite(price) && price > 0) return price;
  const amount = Number(balance?.balance ?? balance?.amount ?? balance?.ui_amount);
  const usdValue = Number(balance?.usd_value ?? balance?.usdValue);
  return Number.isFinite(amount) && amount > 0 && Number.isFinite(usdValue) && usdValue > 0
    ? usdValue / amount
    : null;
}

function normalizeTokenInfo(data) {
  const decimals = Number(required(data?.decimals, 'token.decimals'));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    const error = new Error('GMGN token decimals are invalid');
    error.code = 'GMGN_SCHEMA_INVALID';
    throw error;
  }
  return {
    raw: data,
    address: String(data.address || data.token_address || ''),
    symbol: String(data.symbol || ''),
    decimals,
    priceUsd: numberOrNull(data?.price?.price ?? data?.price_usd ?? data?.price),
    liquidityUsd: numberOrNull(data?.liquidity ?? data?.liquidity_usd),
    rugRatio: numberOrNull(data?.rug_ratio ?? data?.stat?.rug_ratio)
  };
}

function normalizeSecurity(data, chainId) {
  requireChain(chainId);
  return {
    raw: data,
    isHoneypot: booleanOrNull(data?.is_honeypot ?? data?.honeypot),
    buyTax: numberOrNull(data?.buy_tax),
    sellTax: numberOrNull(data?.sell_tax),
    rugRatio: numberOrNull(data?.rug_ratio),
    renouncedMint: booleanOrNull(data?.renounced_mint),
    renouncedFreeze: booleanOrNull(data?.renounced_freeze_account),
    top10HolderRate: numberOrNull(data?.top_10_holder_rate)
  };
}

function normalizePool(data) {
  return {
    raw: data,
    liquidityUsd: numberOrNull(data?.liquidity ?? data?.liquidity_usd ?? data?.pool?.liquidity)
  };
}

function normalizeQuote(data) {
  const outputAmountRaw = String(required(data?.output_amount, 'quote.output_amount'));
  if (!/^\d+$/.test(outputAmountRaw)) {
    const error = new Error('GMGN quote output amount is invalid');
    error.code = 'GMGN_SCHEMA_INVALID';
    throw error;
  }
  return {
    raw: data,
    outputAmountRaw,
    minOutputAmountRaw: String(data?.min_output_amount || outputAmountRaw),
    priceImpactPct: numberOrNull(data?.price_impact ?? data?.price_impact_pct),
    totalCostRaw: data?.tx?.sol_cost ? String(data.tx.sol_cost) : null,
    platformFeeRaw: data?.tx?.quote?.platformFee ? String(data.tx.quote.platformFee) : null
  };
}

function normalizeWalletTokenBalance(data, decimals) {
  const listed = Array.isArray(data?.balances) ? data.balances[0] : null;
  const source = listed || data?.token || data?.balance_info || data || {};
  const rawCandidate = source.raw_amount
    ?? source.amount_raw
    ?? source.balance_raw
    ?? source.token_balance_raw;
  let amountRaw = rawCandidate === undefined || rawCandidate === null
    ? null
    : String(rawCandidate);
  if (amountRaw !== null && !/^\d+$/.test(amountRaw)) amountRaw = null;

  const displayCandidate = source.balance ?? source.amount ?? source.ui_amount ?? source.token_balance;
  const amountDisplay = displayCandidate === undefined || displayCandidate === null
    ? null
    : String(displayCandidate);
  if (amountRaw === null && amountDisplay === null) {
    const error = new Error('GMGN wallet token balance lacks exact amount fields');
    error.code = 'GMGN_SCHEMA_INVALID';
    throw error;
  }
  const sourceDecimals = Number(source.decimal ?? source.decimals ?? decimals);
  const displayRequiresDecimals = amountDisplay !== null
    && !/^\d+$/.test(String(amountDisplay));
  const effectiveDecimals = sourceDecimals === 0
      && Number(decimals) > 0
      && (Number(amountDisplay) === 0 || displayRequiresDecimals)
    ? Number(decimals)
    : sourceDecimals;
  return {
    raw: data,
    amountRaw,
    amountDisplay,
    decimals: effectiveDecimals
  };
}

function normalizeOrderStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['confirmed', 'successful', 'success'].includes(status)) return 'confirmed';
  if (['failed', 'error'].includes(status)) return 'failed';
  if (status === 'expired') return 'expired';
  if (['submitted', 'created'].includes(status)) return 'submitted';
  if (['pending', 'processing', 'processed', 'check'].includes(status)) return 'pending';
  return 'unknown';
}

function normalizeStrategyStatus(value, strategyValue, details = {}) {
  const status = String(value || '').trim().toLowerCase();
  const strategyStatus = String(strategyValue || '').trim().toLowerCase();
  const closeTxHash = String(details.closeTxHash || '').trim();
  const closeAmountRaw = String(details.closeAmountRaw || '').trim();
  const conditionStatuses = (details.conditionOrders || [])
    .map((item) => String(item?.status || '').trim().toLowerCase())
    .filter(Boolean);
  if (closeTxHash || (/^\d+$/.test(closeAmountRaw) && BigInt(closeAmountRaw) > 0n)) return 'triggered';
  if (conditionStatuses.includes('success')) return 'triggered';
  if (['open', 'running', 'check', 'pending'].includes(status)) return 'running';
  if (['running', 'check', 'pending'].includes(strategyStatus)) return 'running';
  if (conditionStatuses.length > 0 && conditionStatuses.every((item) => ['cancel', 'cancelled', 'canceled'].includes(item))) {
    return 'cancelled';
  }
  if (['success', 'completed'].includes(status)) return 'triggered';
  if (status === 'closed' && ['stopped', 'cancelled', 'canceled'].includes(strategyStatus)) return 'cancelled';
  if (status === 'closed') return 'triggered';
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
  if (['failed', 'expired'].includes(status)) return status;
  if (['triggered', 'cancelling', 'partially_filled'].includes(status)) return status;
  return 'unknown';
}

function normalizeOrder(data) {
  const providerOrderId = String(data?.order_id || data?.id || '').trim() || null;
  const report = data?.report && typeof data.report === 'object' ? data.report : {};
  return {
    raw: data,
    providerOrderId,
    providerStatus: String(data?.status || ''),
    status: normalizeOrderStatus(data?.status),
    txHash: String(data?.hash || data?.tx_hash || report?.tx_hash || '').trim() || null,
    strategyOrderId: String(data?.strategy_order_id || '').trim() || null,
    report: {
      raw: report,
      inputAmountRaw: report.input_amount ? String(report.input_amount) : null,
      outputAmountRaw: report.output_amount ? String(report.output_amount) : null,
      inputDecimals: numberOrNull(report.input_token_decimals),
      outputDecimals: numberOrNull(report.output_token_decimals),
      priceUsd: numberOrNull(report.price_usd),
      gasNative: numberOrNull(report.gas_native),
      gasUsd: numberOrNull(report.gas_usd)
    },
    errorCode: data?.error_code || data?.error_status || null
  };
}

function normalizeStrategy(data) {
  const closeAmountRaw = data?.close_amount === undefined || data?.close_amount === ''
    ? null
    : String(data.close_amount);
  const closeOutputAmountRaw = data?.close_output_amount === undefined || data?.close_output_amount === ''
    ? null
    : String(data.close_output_amount);
  const closeTxHash = String(data?.close_sign_hash || '').trim() || null;
  const conditionOrders = Array.isArray(data?.condition_orders) ? data.condition_orders : [];
  return {
    raw: data,
    providerOrderId: String(data?.order_id || '').trim() || null,
    status: normalizeStrategyStatus(data?.status, data?.strategy_status, {
      closeTxHash,
      closeAmountRaw,
      conditionOrders
    }),
    providerStatus: String(data?.status || '').toLowerCase() || null,
    strategyStatus: String(data?.strategy_status || '').toLowerCase() || null,
    openAmountRaw: data?.open_amount === undefined ? null : String(data.open_amount),
    quoteInvestmentRaw: data?.quote_investment === undefined ? null : String(data.quote_investment),
    closeAmountRaw,
    closeOutputAmountRaw,
    closeTxHash,
    closePrice: numberOrNull(data?.close_price),
    closeTime: numberOrNull(data?.close_time),
    baseDecimals: numberOrNull(data?.base_decimal),
    quoteDecimals: numberOrNull(data?.quote_decimal),
    quoteToken: String(data?.quote_token || '').trim() || null,
    orderStatistic: data?.order_statistic && typeof data.order_statistic === 'object'
      ? data.order_statistic
      : {},
    conditionOrders,
    walletAddress: String(data?.wallet_address || '').trim() || null,
    baseToken: String(data?.base_token || '').trim() || null,
    createdAt: numberOrNull(data?.create_time)
  };
}

module.exports = {
  booleanOrNull,
  normalizeOrder,
  normalizeOrderStatus,
  normalizePool,
  normalizeQuote,
  normalizeSecurity,
  normalizeStrategy,
  normalizeStrategyStatus,
  normalizeTokenInfo,
  normalizeUserInfo,
  normalizeWalletTokenBalance,
  numberOrNull,
  selectWallet,
  walletNativeBalance,
  walletNativePriceUsd
};
