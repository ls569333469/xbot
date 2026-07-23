const gmgnHttp = require('../../lib/gmgn-http');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const { decimalToRaw, rawToDecimal } = require('../../lib/decimal-units');
const engineState = require('../../lib/engine-state');
const { assertLiveMode } = require('../../lib/runtime-mode');
const configService = require('../config/service');
const livePolicy = require('../signal/live-policy');
const {
  buildConditionOrders,
  buildSwapParams,
  requireChain,
} = require('./chain-adapters');
const { loadCachedContext } = require('./fast-path-context');
const prepareTokens = require('./prepare-token-service');
const repository = require('./trade-repository');
const readinessService = require('./readiness-service');

function nativeBalance(wallet, symbol) {
  return gmgnAdapter.walletNativeBalance(wallet, symbol);
}

function nativePriceUsd(wallet, symbol) {
  return gmgnAdapter.walletNativePriceUsd(wallet, symbol);
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveNativePriceUsd(cached) {
  return nativePriceUsd(cached.wallet, cached.chain.nativeSymbol)
    ?? positiveNumber(cached.gas?.native_token_usd_price)
    ?? positiveNumber(cached.nativeToken?.priceUsd)
    ?? null;
}

function feeReserve(chainId) {
  const defaults = { sol: '0.0002', bsc: '0.001', base: '0.0005', eth: '0.002' };
  return String(process.env[`GMGN_MAX_FEE_RESERVE_${chainId.toUpperCase()}`] || defaults[chainId]);
}

function derivePriceImpactPct(context) {
  if (context.quote.priceImpactPct !== null) {
    return { value: context.quote.priceImpactPct, source: 'provider' };
  }
  if (!Number.isInteger(Number(context.token?.decimals))
      || !/^\d+$/.test(String(context.quote?.outputAmountRaw || ''))) {
    return { value: null, source: 'unavailable' };
  }
  const inputUsd = Number(context.budgetNative) * Number(context.nativeUsd);
  const outputTokens = Number(rawToDecimal(
    context.quote.outputAmountRaw,
    context.token.decimals,
    Math.min(18, context.token.decimals)
  ));
  const outputUsd = outputTokens * Number(context.token.priceUsd);
  if (![inputUsd, outputTokens, outputUsd].every(Number.isFinite)
      || inputUsd <= 0 || outputTokens <= 0 || outputUsd <= 0) {
    return { value: null, source: 'unavailable' };
  }
  return {
    value: Math.max(0, ((inputUsd - outputUsd) / inputUsd) * 100),
    source: 'derived_from_quote_values'
  };
}

function taxAdjustedPriceImpact(priceImpact, buyTax) {
  if (buyTax === null || buyTax === undefined || buyTax === '') return priceImpact;
  const tax = Number(buyTax);
  if (priceImpact.value === null || !Number.isFinite(tax) || tax < 0) return priceImpact;
  return {
    value: Math.max(0, priceImpact.value - tax),
    source: `${priceImpact.source}_excluding_buy_tax`,
    grossValue: priceImpact.value,
    buyTax: tax
  };
}

function evaluateRisk(context, riskConfig) {
  const reasons = [];
  const warnings = [];
  const maxBuyTax = Number(riskConfig.max_buy_tax ?? 5);
  const maxSellTax = Number(riskConfig.max_sell_tax ?? 10);
  const maxRugRatio = Number(riskConfig.max_rug_ratio ?? 0.3);
  const minLiquidity = Number(riskConfig.min_liquidity_usd ?? 10_000);
  const maxSlippage = Number(riskConfig.max_slippage_pct ?? 15);
  const security = context.security;
  const liquidity = context.pool.liquidityUsd ?? context.token.liquidityUsd;
  const rugRatio = security.rugRatio ?? context.token.rugRatio;
  const grossPriceImpact = derivePriceImpactPct(context);
  const priceImpact = taxAdjustedPriceImpact(grossPriceImpact, security.buyTax);

  if (security.isHoneypot === true) reasons.push('HONEYPOT_DETECTED');
  if (security.isHoneypot === null && context.chain.id !== 'sol') reasons.push('HONEYPOT_UNKNOWN');
  if (security.isHoneypot === null && context.chain.id === 'sol') warnings.push('HONEYPOT_FIELD_UNAVAILABLE_SOL');
  if (context.chain.id !== 'sol' && security.buyTax === null) warnings.push('BUY_TAX_UNKNOWN');
  else if (security.buyTax !== null && security.buyTax > maxBuyTax) warnings.push('HIGH_BUY_TAX');
  if (context.chain.id !== 'sol' && security.sellTax === null) warnings.push('SELL_TAX_UNKNOWN');
  else if (security.sellTax !== null && security.sellTax > maxSellTax) warnings.push('HIGH_SELL_TAX');
  if (context.chain.id === 'sol' && security.renouncedMint === false) reasons.push('MINT_AUTHORITY_ACTIVE');
  if (context.chain.id === 'sol' && security.renouncedMint === null) reasons.push('MINT_AUTHORITY_UNKNOWN_SOL');
  if (context.chain.id === 'sol' && security.renouncedFreeze === false) reasons.push('FREEZE_AUTHORITY_ACTIVE');
  if (context.chain.id === 'sol' && security.renouncedFreeze === null) reasons.push('FREEZE_AUTHORITY_UNKNOWN_SOL');
  if (rugRatio === null) warnings.push('RUG_RATIO_UNKNOWN');
  else if (rugRatio > maxRugRatio) reasons.push('HIGH_RUG_RATIO');
  if (liquidity === null) reasons.push('LIQUIDITY_UNKNOWN');
  else if (liquidity < minLiquidity) reasons.push('LOW_LIQUIDITY');
  if (priceImpact.value === null && context.chain.id === 'sol') warnings.push('PRICE_IMPACT_UNKNOWN');
  else if (priceImpact.value === null) reasons.push('PRICE_IMPACT_UNKNOWN');
  else if (priceImpact.value > maxSlippage) reasons.push('SLIPPAGE_TOO_HIGH');
  if (context.walletNativeBalance === null) reasons.push('WALLET_BALANCE_UNKNOWN');
  else if (context.walletNativeBalance < Number(context.budgetNative) + Number(context.feeReserveNative)) {
    reasons.push('INSUFFICIENT_NATIVE_BALANCE');
  }
  if (context.budgetUsdSnapshot === null) reasons.push('NATIVE_USD_PRICE_UNKNOWN');

  return {
    passed: reasons.length === 0,
    reasons,
    warnings,
    checks: {
      honeypot: security.isHoneypot,
      buy_tax: security.buyTax,
      sell_tax: security.sellTax,
      tax_policy: 'whitelist_warning_only',
      rug_ratio: rugRatio,
      liquidity_usd: liquidity,
      price_impact_pct: priceImpact.value,
      price_impact_source: priceImpact.source,
      price_impact_gross_pct: grossPriceImpact.value,
      buy_tax_excluded_from_price_impact_pct: priceImpact.buyTax ?? null,
      wallet_native_balance: context.walletNativeBalance
    }
  };
}

async function buildPrepared(signalId, options = {}) {
  const signal = await repository.getSignalForExecution(signalId);
  if (!signal) {
    const error = new Error('Signal not found');
    error.code = 'SIGNAL_NOT_FOUND';
    throw error;
  }
  if (signal.whitelist_status !== 'active') {
    const error = new Error('Whitelist is not active');
    error.code = 'WHITELIST_NOT_ACTIVE';
    throw error;
  }
  const cached = await loadCachedContext(signal);
  const inputAmountRaw = decimalToRaw(signal.budget_per_trade, cached.chain.decimals);
  const quoteRaw = await gmgnHttp.quoteOrder(
    cached.chain.id,
    cached.wallet.address,
    cached.chain.nativeToken,
    signal.contract_address,
    inputAmountRaw,
    Number(signal.slippage),
    options.rateLease ? { rateLease: options.rateLease, deadlineAt: options.deadlineAt } : {}
  );
  const quote = gmgnAdapter.normalizeQuote(quoteRaw);
  const budgetNative = String(signal.budget_per_trade);
  const walletNativeBalance = nativeBalance(cached.wallet, cached.chain.nativeSymbol);
  const nativeUsd = resolveNativePriceUsd(cached);
  const feeReserveNative = feeReserve(cached.chain.id);
  const principalUsdSnapshot = nativeUsd ? Number(budgetNative) * nativeUsd : null;
  const feeReserveUsdSnapshot = nativeUsd ? Number(feeReserveNative) * nativeUsd : null;
  const budgetUsdSnapshot = nativeUsd
    ? (Number(budgetNative) + Number(feeReserveNative)) * nativeUsd
    : null;
  const context = {
    ...cached,
    signal,
    quote,
    inputAmountRaw,
    budgetNative,
    nativeUsd,
    principalUsdSnapshot,
    feeReserveUsdSnapshot,
    budgetUsdSnapshot,
    feeReserveNative,
    walletNativeBalance,
    conditionOrders: buildConditionOrders(signal)
  };
  const riskConfig = await configService.get('risk_config') || {};
  const policy = await livePolicy.evaluate(signal, { phase: options.policyPhase || 'live' });
  const risk = evaluateRisk(context, riskConfig);
  const riskSnapshot = {
    ...risk,
    policy,
    sources: {
      cache: cached.cacheMeta,
      token: {
        address: cached.token.address,
        symbol: cached.token.symbol,
        decimals: cached.token.decimals,
        price_usd: cached.token.priceUsd,
        rug_ratio: cached.token.rugRatio
      },
      native_token: {
        symbol: cached.nativeToken?.symbol || cached.chain.nativeSymbol,
        price_usd: nativeUsd
      },
      budget: {
        principal_native: Number(budgetNative),
        fee_reserve_native: Number(feeReserveNative),
        principal_usd: principalUsdSnapshot,
        fee_reserve_usd: feeReserveUsdSnapshot,
        total_usd: budgetUsdSnapshot
      },
      security: {
        honeypot: cached.security.isHoneypot,
        buy_tax: cached.security.buyTax,
        sell_tax: cached.security.sellTax,
        rug_ratio: cached.security.rugRatio,
        renounced_mint: cached.security.renouncedMint,
        renounced_freeze: cached.security.renouncedFreeze
      },
      pool: { liquidity_usd: cached.pool.liquidityUsd },
      quote: {
        output_amount_raw: quote.outputAmountRaw,
        min_output_amount_raw: quote.minOutputAmountRaw,
        provider_price_impact_pct: quote.priceImpactPct,
        effective_price_impact_pct: risk.checks.price_impact_pct,
        gross_price_impact_pct: risk.checks.price_impact_gross_pct,
        buy_tax_excluded_pct: risk.checks.buy_tax_excluded_from_price_impact_pct,
        price_impact_source: risk.checks.price_impact_source
      }
    }
  };
  const snapshotHash = repository.fingerprint({
    signal_id: signal.signal_id,
    whitelist_id: signal.whitelist_id,
    chain: cached.chain.id,
    wallet: cached.wallet.address,
    contract_address: signal.contract_address,
    budget: budgetNative,
    slippage: Number(signal.slippage),
    security: {
      honeypot: cached.security.isHoneypot,
      buy_tax: cached.security.buyTax,
      sell_tax: cached.security.sellTax,
      rug_ratio: cached.security.rugRatio
    },
    liquidity_usd: cached.pool.liquidityUsd ?? cached.token.liquidityUsd,
    risk_config: riskConfig,
    policy: policy.policy
  });
  return {
    ...context,
    risk,
    riskSnapshot,
    livePolicy: policy,
    snapshotHash,
    summary: {
      signal_id: signal.signal_id,
      chain: cached.chain.id,
      wallet: cached.wallet.address,
      native_symbol: cached.chain.nativeSymbol,
      wallet_native_balance: walletNativeBalance,
      input: `${budgetNative} ${cached.chain.nativeSymbol}`,
      input_raw: inputAmountRaw,
      fee_reserve: `${feeReserveNative} ${cached.chain.nativeSymbol}`,
      total_native_reserved: Number(budgetNative) + Number(feeReserveNative),
      total_usd_reserved: budgetUsdSnapshot,
      output_token: `${cached.token.symbol || signal.symbol} (${signal.contract_address})`,
      estimated_output: rawToDecimal(quote.outputAmountRaw, cached.token.decimals, 8),
      minimum_output: rawToDecimal(quote.minOutputAmountRaw, cached.token.decimals, 8),
      slippage_pct: Number(signal.slippage),
      risk_passed: risk.passed,
      risk_reasons: risk.reasons,
      risk_warnings: risk.warnings,
      live_allowed: policy.allowed,
      live_blockers: policy.blockers,
      cache: cached.cacheMeta
    }
  };
}

async function prepare(signalId, operatorId) {
  const prepared = await buildPrepared(signalId);
  const token = await prepareTokens.create({
    purpose: 'buy',
    signalId,
    operatorId,
    snapshotHash: prepared.snapshotHash,
    snapshot: prepared.summary
  });
  return { ...prepared.summary, prepare_token: token.token, expires_in_seconds: token.expiresInSeconds };
}

function isDefinitiveWriteRejection(error) {
  if (error.name !== 'GmgnOpenApiError') return false;
  return Number.isFinite(error.status) && error.status >= 400 && error.status < 500;
}

async function execute(signalId, prepareToken, operatorId) {
  assertLiveMode(engineState);
  const readiness = await readinessService.getSnapshot();
  if (!readiness.readyToArm) {
    const error = new Error(`Live readiness failed: ${readiness.blockers.join(', ')}`);
    error.code = 'LIVE_READINESS_FAILED';
    error.details = readiness;
    throw error;
  }
  const consumed = await prepareTokens.consume(prepareToken, { purpose: 'buy', operatorId });
  if (Number(consumed.signal_id) !== Number(signalId)) {
    const error = new Error('Prepare token does not belong to this signal');
    error.code = 'PREPARE_TOKEN_MISMATCH';
    throw error;
  }

  const deadlineAt = Date.now() + Math.max(1000, Number(process.env.SIGNAL_MAX_AGE_SECONDS || 300) * 1000);
  const rateLease = await gmgnHttp.scheduler.reserveTrade({ deadlineAt });
  let attempt = null;
  let swapStarted = false;
  try {
    const prepared = await buildPrepared(signalId, { rateLease, deadlineAt });
    if (prepared.snapshotHash !== consumed.snapshot_hash) {
      const error = new Error('Risk, wallet, policy, or budget snapshot changed; prepare again');
      error.code = 'PREPARE_SNAPSHOT_CHANGED';
      throw error;
    }
    await livePolicy.evaluate(prepared.signal, { throwOnFailure: true });
    if (!prepared.risk.passed) {
      const error = new Error(`Risk rejected signal: ${prepared.risk.reasons.join(', ')}`);
      error.code = prepared.risk.reasons[0] || 'RISK_REJECTED';
      throw error;
    }
    attempt = (await repository.createBuyAttempt(prepared)).attempt;
    await repository.transitionAttempt(attempt.id, ['reserved'], 'submitting', { actor: operatorId });
    swapStarted = true;
    const swapParams = buildSwapParams({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      inputToken: prepared.chain.nativeToken,
      outputToken: prepared.signal.contract_address,
      inputAmountRaw: prepared.inputAmountRaw,
      slippage: prepared.signal.slippage,
      conditionOrders: prepared.conditionOrders,
      gas: prepared.gas
    });
    const response = await gmgnHttp.swap(swapParams, { rateLease, returnMeta: true, deadlineAt });
    const normalizedOrder = gmgnAdapter.normalizeOrder(response.data);
    if (!normalizedOrder.providerOrderId) {
      const error = new Error('GMGN swap response did not include order_id');
      error.code = 'GMGN_ORDER_ID_MISSING';
      throw error;
    }
    const order = await repository.recordSubmittedOrder(
      attempt.id,
      normalizedOrder,
      prepared.quote,
      response.meta
    );
    return { attempt_id: attempt.id, order, status: normalizedOrder.status };
  } catch (error) {
    rateLease.release();
    if (!attempt) throw error;
    if (swapStarted && !isDefinitiveWriteRejection(error)) {
      await repository.markSubmissionUncertain(attempt.id, error);
    } else {
      await repository.releaseRejectedAttempt(attempt.id, error);
    }
    throw error;
  }
}

module.exports = {
  buildPrepared,
  derivePriceImpactPct,
  evaluateRisk,
  execute,
  feeReserve,
  loadCachedContext,
  nativeBalance,
  nativePriceUsd,
  resolveNativePriceUsd,
  prepare,
  taxAdjustedPriceImpact
};
