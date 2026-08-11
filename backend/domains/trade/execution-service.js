const gmgnAccess = require('../../lib/gmgn-access-service').accessFor('trade_execution');
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
const intentRepository = require('./trade-intent-repository');
const { walletWriteLane } = require('./wallet-write-lane');
const { tradeFailureEvidenceService } = require('./trade-failure-evidence-service');
const { classifyWriteError } = require('./gmgn-write-error-classifier');
const { probeRpc } = require('./chain-receipt-service');
const { executionGateService } = require('./execution-gate-service');
const { createExecutionTrace } = require('./execution-trace');
const runtimeAuthorization = require('./runtime-signal-authorization');
const { PRIORITIES, endpointWeight } = require('../../lib/gmgn-rate-scheduler');
const { scopeKey } = require('../../lib/gmgn-shared-rate-limit');
const {
  buildTriggeredProviderContext,
  mergeTriggeredTokenInfo,
  requiresProviderGasPrice
} = require('./triggered-provider-context');

function runtimeReadinessOptions(options = {}) {
  return {
    ...options,
    scope: options.scope || engineState.getScopeInput?.() || { scope_type: 'combined' }
  };
}

function wakeOrderReconciliation(orderId) {
  const { reconciler } = require('./reconciliation-service');
  reconciler.wakeOrder(orderId);
}

function nativeBalance(wallet, symbol) {
  return gmgnAdapter.walletNativeBalance(wallet, symbol);
}

function nativePriceUsd(wallet, symbol) {
  return gmgnAdapter.walletNativePriceUsd(wallet, symbol);
}

async function resolveWalletNativeBalance(cached, dependencies = {}) {
  const gmgnBalance = nativeBalance(cached.wallet, cached.chain.nativeSymbol);
  if (gmgnBalance !== null) {
    return { value: gmgnBalance, source: 'gmgn', rpc: null };
  }

  const rpcProbe = await (dependencies.probeRpc || probeRpc)(cached.chain.id, {
    walletAddress: cached.wallet.address
  });
  const rpcBalance = Number(rpcProbe?.nativeBalance);
  if (rpcProbe?.ok
      && rpcProbe.nativeBalance !== null
      && rpcProbe.nativeBalance !== undefined
      && rpcProbe.nativeBalance !== ''
      && Number.isFinite(rpcBalance)
      && rpcBalance >= 0) {
    return {
      value: rpcBalance,
      source: 'rpc',
      rpc: {
        identity: rpcProbe.identity || null,
        block_ref: rpcProbe.blockRef || null
      }
    };
  }

  return {
    value: null,
    source: 'unavailable',
    rpc: {
      error: rpcProbe?.error || 'CHAIN_RPC_BALANCE_UNAVAILABLE'
    }
  };
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
  const key = `GMGN_MAX_FEE_RESERVE_${chainId.toUpperCase()}`;
  const configured = String(process.env[key] || '').trim();
  if (!configured || !Number.isFinite(Number(configured)) || Number(configured) <= 0) {
    const error = new Error(`${key} must be explicitly configured as a positive number`);
    error.code = 'CHAIN_FEE_RESERVE_MISSING';
    throw error;
  }
  return configured;
}

function derivePriceImpactPct(context) {
  if (!context?.quote || typeof context.quote !== 'object') {
    return { value: null, source: 'unavailable' };
  }
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

function assertTargetChainReady(readiness, chainId, options = {}) {
  const chain = readiness?.chains?.find((item) => item.chain === chainId);
  const strategyScope = Boolean(options.strategyScope ?? options.dynamicScope);
  const targetReady = strategyScope
    ? Boolean(chain?.infrastructureReady ?? chain?.infrastructure_ready)
    : Boolean(chain?.ready);
  if (!targetReady) {
    const blockers = chain?.blockers || ['CHAIN_READINESS_MISSING'];
    const error = new Error(`Live readiness failed for ${chainId}: ${blockers.join(', ')}`);
    error.code = 'LIVE_CHAIN_READINESS_FAILED';
    error.details = chain || { chain: chainId, blockers };
    throw error;
  }
  return chain;
}

function boundedEvidenceDeadline(tradeDeadlineAt, now = Date.now()) {
  return Math.min(Number(tradeDeadlineAt), Number(now) + 1500);
}

function isProviderWaitError(error) {
  const code = String(error?.code || '');
  return Number(error?.status) === 429
    || code.includes('RATE_LIMIT')
    || code === 'GMGN_RATE_DEADLINE_EXPIRED';
}

function annotateProviderWait(error) {
  if (isProviderWaitError(error)) {
    error.retryable = true;
    error.providerWait = true;
  }
  return error;
}

function evaluateRisk(context) {
  const reasons = [];
  const warnings = [];
  const security = context.security || {};
  const pool = context.pool || {};
  const token = context.token || {};
  const quote = context.quote || {};
  const liquidity = pool.liquidityUsd ?? token.liquidityUsd ?? null;
  const rugRatio = security.rugRatio ?? token.rugRatio ?? null;
  const grossPriceImpact = derivePriceImpactPct(context);
  const priceImpact = taxAdjustedPriceImpact(grossPriceImpact, security.buyTax);

  if (security.isHoneypot === true) reasons.push('GMGN_SECURITY_HONEYPOT');
  if (security.isHoneypot === null && context.chain.id !== 'sol') warnings.push('HONEYPOT_UNKNOWN');
  if (security.isHoneypot === null && context.chain.id === 'sol') warnings.push('HONEYPOT_FIELD_UNAVAILABLE_SOL');
  if (context.chain.id !== 'sol' && security.buyTax === null) warnings.push('BUY_TAX_UNKNOWN');
  else if (security.buyTax !== null && security.buyTax > 0) warnings.push('BUY_TAX_PRESENT');
  if (context.chain.id !== 'sol' && security.sellTax === null) warnings.push('SELL_TAX_UNKNOWN');
  else if (security.sellTax !== null && security.sellTax > 0) warnings.push('SELL_TAX_PRESENT');
  if (context.chain.id === 'sol' && security.renouncedMint === false) warnings.push('MINT_AUTHORITY_ACTIVE');
  if (context.chain.id === 'sol' && security.renouncedMint === null) warnings.push('MINT_AUTHORITY_UNKNOWN_SOL');
  if (context.chain.id === 'sol' && security.renouncedFreeze === false) warnings.push('FREEZE_AUTHORITY_ACTIVE');
  if (context.chain.id === 'sol' && security.renouncedFreeze === null) warnings.push('FREEZE_AUTHORITY_UNKNOWN_SOL');
  if (rugRatio === null && context.chain.id === 'robinhood') {
    warnings.push('RUG_RATIO_FIELD_UNAVAILABLE_ROBINHOOD');
  } else if (rugRatio === null) reasons.push('GMGN_SECURITY_SCHEMA_INVALID');
  else if (rugRatio > 0.3) reasons.push('GMGN_SECURITY_RUG_RISK');
  else if (rugRatio > 0) warnings.push('RUG_RATIO_REPORTED');
  if (liquidity === null) warnings.push('LIQUIDITY_UNKNOWN');
  if (priceImpact.value === null) warnings.push('PRICE_IMPACT_UNKNOWN');
  const requiredNativeBalance = Number(context.requiredNativeBalance
    ?? (Number(context.budgetNative) + Number(context.feeReserveNative)));
  if (context.walletNativeBalance === null) reasons.push('WALLET_BALANCE_UNKNOWN');
  else if (!Number.isFinite(requiredNativeBalance)
      || context.walletNativeBalance < requiredNativeBalance) {
    reasons.push('INSUFFICIENT_NATIVE_BALANCE');
  }
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
      wallet_native_balance: context.walletNativeBalance,
      required_native_balance: requiredNativeBalance,
      exit_gas_reserve: Number(context.exitGasReserve || 0)
    }
  };
}

function terminalRequestWeight(chainId, options = {}) {
  const endpoints = new Set(['POST /v1/trade/swap']);
  if (requiresProviderGasPrice(chainId, options.gas || {}, options)) {
    endpoints.add('GET /v1/trade/gas_price');
  }
  if (options.securityCheck === true) endpoints.add('GET /v1/token/security');
  if (options.quoteRequired === true) endpoints.add('GET /v1/trade/quote');
  if (options.tokenInfoRequired === true) endpoints.add('GET /v1/token/info');
  return [...endpoints].reduce((total, endpoint) => {
    const [method, path] = endpoint.split(' ');
    return total + endpointWeight(method, path);
  }, 0);
}

function reserveExecutionTrade(options = {}) {
  return gmgnAccess.reserveTrade({
    ...options,
    weight: terminalRequestWeight(options.chainId, options)
  });
}

function gmgnRequestContext(signal, stage, traceId = null) {
  const follow = Number(signal.follow_discovery_policy_id || 0) > 0;
  const dynamic = Number(signal.actor_policy_id || 0) > 0;
  const signalId = Number(signal.signal_id || signal.id || 0) || null;
  const executionSessionId = signalId ? `signal:${signalId}` : null;
  return {
    source: `${follow ? 'p21_follow_discovery' : dynamic ? 'p20_dynamic' : 'fixed_ca'}_${stage}`,
    signalId,
    policyId: Number(signal.follow_discovery_policy_id || signal.actor_policy_id || 0) || null,
    whitelistId: Number(signal.whitelist_id || 0) || null,
    traceId: traceId || signal.trace_id || executionSessionId,
    executionSessionId,
    rateScope: scopeKey()
  };
}

async function buildPrepared(signalId, options = {}) {
  const storedSignal = await repository.getSignalForExecution(signalId);
  if (!storedSignal) {
    const error = new Error('Signal not found');
    error.code = 'SIGNAL_NOT_FOUND';
    throw error;
  }
  if (storedSignal.whitelist_status !== 'active') {
    const error = new Error('Whitelist is not active');
    error.code = 'WHITELIST_NOT_ACTIVE';
    throw error;
  }
  const configuredSlippage = Number(storedSignal.slippage);
  const slippageCap = Number(options.slippageCap);
  const signal = {
    ...storedSignal,
    slippage: Number.isFinite(slippageCap)
      ? Math.min(configuredSlippage, slippageCap)
      : configuredSlippage
  };
  const requestTraceId = options.trace?.traceId || signal.trace_id || null;
  const cached = await loadCachedContext(signal, {
    fresh: Boolean(options.forceRefresh),
    verificationSnapshot: signal.provider_verification_snapshot,
    requestOptions: {
      priority: PRIORITIES.NEW_TRADE,
      ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
      requestContext: gmgnRequestContext(signal, 'context', requestTraceId)
    }
  });
  options.trace?.mark('cache', {
    fallback: Object.values(cached.cacheMeta || {}).some((entry) => !entry.hit)
  });
  const inputAmountRaw = decimalToRaw(signal.budget_per_trade, cached.chain.decimals);
  const providerPromise = buildTriggeredProviderContext({
    cached,
    signal,
    inputAmountRaw,
    slippage: signal.slippage,
    rateLease: options.rateLease,
    deadlineAt: options.deadlineAt,
    mode: options.providerMode || 'none',
    securityCheck: Boolean(options.securityCheck),
    quoteRequired: Boolean(options.quoteRequired),
    attemptNo: options.attemptNo || 1,
    escalating: Boolean(options.escalating),
    requestContext: (stage) => gmgnRequestContext(signal, stage, requestTraceId)
  }, { gmgnAccess });
  const evidencePromise = options.captureEvidence
    ? providerPromise.then((provider) => options.captureEvidence({
      side: 'buy',
      chain: cached.chain.id,
      wallet_address: cached.wallet.address,
      input_token: cached.chain.nativeToken,
      output_token: signal.contract_address,
      input_amount_raw: inputAmountRaw,
      snapshot_version: 1
    }, {
      tokenDecimals: cached.token.decimals,
      gas: provider.gas,
      requestContext: gmgnRequestContext(signal, 'pre_submit_evidence', requestTraceId)
    }))
    : Promise.resolve(null);
  const [providerContext, walletBalance, preSubmitSnapshot] = await Promise.all([
    providerPromise,
    resolveWalletNativeBalance(cached, options),
    evidencePromise
  ]);
  options.trace?.mark('provider_context');
  const quote = providerContext.quote;
  const budgetNative = String(signal.budget_per_trade);
  const walletNativeBalance = walletBalance.value;
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
  const chainConfigs = await configService.get('chain_configs');
  const chainConfig = chainConfigs?.[cached.chain.id] || {};
  const retryPolicy = intentRepository.retryPolicy(cached.chain.id, chainConfig);
  const retryFeeEnvelopeNative = retryPolicy.retryEnabled
    ? retryPolicy.maxRetries * retryPolicy.maxRetryFeeNative
    : 0;
  const exitGasReserve = Number(retryPolicy.exitGasReserve || 0);
  const requiredNativeBalance = Number(budgetNative) + Number(feeReserveNative)
    + retryFeeEnvelopeNative + exitGasReserve;
  context.retryFeeEnvelopeNative = retryFeeEnvelopeNative;
  context.exitGasReserve = exitGasReserve;
  context.requiredNativeBalance = requiredNativeBalance;
  const policy = await livePolicy.evaluate(signal, { phase: options.policyPhase || 'live' });
  const risk = evaluateRisk(context);
  options.trace?.mark('risk', { passed: risk.passed });
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
      wallet_balance: {
        native_balance: walletNativeBalance,
        source: walletBalance.source,
        rpc: walletBalance.rpc
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
    exit_strategy: signal.exit_strategy,
    exit_strategy_version: signal.exit_strategy_version,
    condition_orders: context.conditionOrders,
    security: {
      honeypot: cached.security.isHoneypot,
      buy_tax: cached.security.buyTax,
      sell_tax: cached.security.sellTax,
      rug_ratio: cached.security.rugRatio
    },
    liquidity_usd: cached.pool.liquidityUsd ?? cached.token.liquidityUsd,
    authorization: 'whitelist_owned_security_warnings',
    policy: policy.policy
  });
  return {
    ...context,
    risk,
    riskSnapshot,
    livePolicy: policy,
    preSubmitSnapshot: preSubmitSnapshot ? {
      ...preSubmitSnapshot,
      quote: quote.raw || {},
      native_usd_price: nativeUsd
    } : null,
    traceId: options.trace?.traceId || signal.trace_id || null,
    timing: options.trace?.snapshot() || {},
    snapshotHash,
    summary: {
      signal_id: signal.signal_id,
      chain: cached.chain.id,
      wallet: cached.wallet.address,
      native_symbol: cached.chain.nativeSymbol,
      wallet_native_balance: walletNativeBalance,
      wallet_native_balance_source: walletBalance.source,
      input: `${budgetNative} ${cached.chain.nativeSymbol}`,
      input_raw: inputAmountRaw,
      fee_reserve: `${feeReserveNative} ${cached.chain.nativeSymbol}`,
      total_native_reserved: Number(budgetNative) + Number(feeReserveNative)
        + retryFeeEnvelopeNative,
      retry_fee_envelope: `${retryFeeEnvelopeNative} ${cached.chain.nativeSymbol}`,
      exit_gas_reserve: `${exitGasReserve} ${cached.chain.nativeSymbol}`,
      required_wallet_balance: requiredNativeBalance,
      total_usd_reserved: budgetUsdSnapshot,
      output_token: `${cached.token.symbol || signal.symbol} (${signal.contract_address})`,
      estimated_output: /^\d+$/.test(String(quote.outputAmountRaw || ''))
        ? rawToDecimal(quote.outputAmountRaw, cached.token.decimals, 8) : null,
      minimum_output: /^\d+$/.test(String(quote.minOutputAmountRaw || ''))
        ? rawToDecimal(quote.minOutputAmountRaw, cached.token.decimals, 8) : null,
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

async function execute(signalId, prepareToken, operatorId) {
  assertLiveMode(engineState);
  const readiness = await readinessService.getSnapshot(runtimeReadinessOptions());
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
  const signalForLease = await repository.getSignalForExecution(signalId);
  const rateLease = await reserveExecutionTrade({
    chainId: signalForLease?.chain_id,
    deadlineAt,
    requestContext: gmgnRequestContext({ signal_id: signalId }, 'provider_lease')
  });
  let attempt = null;
  let swapStarted = false;
  try {
    const prepared = await buildPrepared(signalId, {
      rateLease, deadlineAt, providerMode: 'terminal'
    });
    if (!engineState.scopeAllowsSignal(prepared.signal)) {
      const error = new Error('Signal is outside the armed runtime scope');
      error.code = 'LIVE_SCOPE_SIGNAL_NOT_ALLOWED';
      throw error;
    }
    assertTargetChainReady(readiness, prepared.chain.id, {
      strategyScope: runtimeAuthorization.scoped(prepared.signal)
    });
    if (prepared.snapshotHash !== consumed.snapshot_hash) {
      const error = new Error('Risk, wallet, policy, or budget snapshot changed; prepare again');
      error.code = 'PREPARE_SNAPSHOT_CHANGED';
      throw error;
    }
    await livePolicy.evaluate(prepared.signal, { throwOnFailure: true });
    const created = await repository.createBuyAttempt(prepared);
    if (created.merged || created.duplicate) {
      rateLease.release();
      return {
        intent_id: created.intent.id,
        attempt_id: null,
        status: created.duplicate ? 'existing_trade_intent' : 'merged_into_active_intent'
      };
    }
    attempt = created.attempt;
    const snapshot = await tradeFailureEvidenceService.capturePreSubmitSnapshot(attempt, {
      tokenDecimals: prepared.token.decimals,
      quote: prepared.quote,
      gas: prepared.gas,
      nativeUsd: prepared.nativeUsd,
      config: created.intent.config_snapshot_json
    });
    const swapParams = buildSwapParams({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      inputToken: prepared.chain.nativeToken,
      outputToken: prepared.signal.contract_address,
      inputAmountRaw: prepared.inputAmountRaw,
      slippage: prepared.signal.slippage,
      conditionOrders: prepared.conditionOrders,
      gas: prepared.gas,
      attemptNo: attempt.attempt_no,
      retryConfig: created.intent.config_snapshot_json?.chain_config
    });
    await repository.beginBuySubmission(attempt.id, {
      snapshot,
      estimatedFeeNative: prepared.feeReserveNative,
      configurationFingerprint: readiness.configurationFingerprint,
      activationVersion: prepared.signal.activation_version,
      emergencyStop: String(process.env.EMERGENCY_STOP || 'false').toLowerCase() === 'true',
      operatorId,
      timing: prepared.timing
    });
    swapStarted = true;
    const response = await gmgnAccess.swap(swapParams, {
      rateLease, returnMeta: true, deadlineAt,
      requestContext: gmgnRequestContext(prepared.signal, 'swap', prepared.traceId)
    });
    rateLease.release();
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
    await walletWriteLane.settleSubmittedOrder(attempt, normalizedOrder);
    wakeOrderReconciliation(order.id);
    return {
      intent_id: created.intent.id,
      attempt_id: attempt.id,
      attempt_no: attempt.attempt_no,
      order,
      status: normalizedOrder.status
    };
  } catch (error) {
    rateLease.release();
    if (!attempt) throw error;
    const classification = classifyWriteError(error, { writeStarted: swapStarted });
    if (classification.kind === 'uncertain') {
      await repository.markSubmissionUncertain(attempt.id, error);
      await walletWriteLane.quarantine(attempt, classification.code, {
        error: error.message,
        classification: classification.kind
      });
    } else {
      await walletWriteLane.release(attempt.id, 'WRITE_REJECTED_OR_NOT_STARTED');
      await repository.releaseRejectedAttempt(attempt.id, error);
    }
    throw error;
  }
}

async function executeAutomatic(signalId, operatorId = '6551-live-worker', options = {}) {
  assertLiveMode(engineState);
  const trace = createExecutionTrace({ traceId: options.traceId });
  trace.mark('claim');
  const strategyScope = Boolean(options.strategyScope ?? options.dynamicScope);
  let gate;
  try {
    gate = executionGateService.assertReady(options.chainId, {
      strategyScope
    });
  } catch (error) {
    if (error.code !== 'EXECUTION_GATE_STALE') throw error;
    const readiness = await readinessService.getSnapshot(runtimeReadinessOptions());
    executionGateService.update(readiness);
    gate = executionGateService.assertReady(options.chainId, {
      strategyScope
    });
  }
  trace.mark('gate');

  const deadlineAt = Date.now()
    + Math.max(1000, Number(process.env.SIGNAL_MAX_AGE_SECONDS || 300) * 1000);
  let rateLease = null;
  let attempt = null;
  let swapStarted = false;
  try {
    const signalForLease = await repository.getSignalForExecution(signalId);
    rateLease = await reserveExecutionTrade({
      chainId: signalForLease?.chain_id || options.chainId,
      deadlineAt,
      requestContext: gmgnRequestContext(
        { signal_id: signalId },
        'provider_lease',
        trace.traceId
      )
    });
    const prepared = await buildPrepared(signalId, {
      rateLease,
      deadlineAt,
      trace,
      captureEvidence: null,
      providerMode: 'terminal'
    });
    if (!engineState.scopeAllowsSignal(prepared.signal)) {
      const error = new Error('Signal is outside the armed runtime scope');
      error.code = 'LIVE_SCOPE_SIGNAL_NOT_ALLOWED';
      throw error;
    }
    assertTargetChainReady(gate, prepared.chain.id, {
      strategyScope
    });
    if (!prepared.livePolicy.allowed) {
      const error = new Error(`Live policy rejected signal: ${prepared.livePolicy.blockers.join(', ')}`);
      error.code = prepared.livePolicy.blockers[0] || 'LIVE_POLICY_REJECTED';
      throw error;
    }
    const created = await repository.createBuyAttempt({
      ...prepared,
      traceId: trace.traceId,
      timing: trace.snapshot()
    });
    if (created.merged || created.duplicate) {
      rateLease.release();
      return {
        intent_id: created.intent.id,
        attempt_id: null,
        status: created.duplicate ? 'existing_trade_intent' : 'merged_into_active_intent'
      };
    }
    attempt = created.attempt;
    trace.mark('attempt');
    const preSubmitSnapshot = await tradeFailureEvidenceService.capturePreSubmitSnapshot(attempt, {
      tokenDecimals: prepared.token.decimals,
      quote: prepared.quote,
      gas: prepared.gas,
      nativeUsd: prepared.nativeUsd,
      config: created.intent.config_snapshot_json
    });
    const swapParams = buildSwapParams({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      inputToken: prepared.chain.nativeToken,
      outputToken: prepared.signal.contract_address,
      inputAmountRaw: prepared.inputAmountRaw,
      slippage: prepared.signal.slippage,
      conditionOrders: prepared.conditionOrders,
      gas: prepared.gas,
      attemptNo: attempt.attempt_no,
      retryConfig: created.intent.config_snapshot_json?.chain_config
    });
    await repository.beginBuySubmission(attempt.id, {
      snapshot: preSubmitSnapshot,
      estimatedFeeNative: prepared.feeReserveNative,
      configurationFingerprint: gate.configurationFingerprint,
      activationVersion: prepared.signal.activation_version,
      emergencyStop: String(process.env.EMERGENCY_STOP || 'false').toLowerCase() === 'true',
      operatorId,
      timing: trace.snapshot()
    });
    trace.mark('lane');
    trace.mark('swap');
    swapStarted = true;
    const response = await gmgnAccess.swap(swapParams, {
      rateLease, returnMeta: true, deadlineAt,
      requestContext: gmgnRequestContext(prepared.signal, 'swap', prepared.traceId)
    });
    rateLease.release();
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
    trace.mark('submitted', { http_ms: response.meta?.latencyMs ?? null });
    await repository.recordExecutionTiming(attempt.id, trace.snapshot());
    await walletWriteLane.settleSubmittedOrder(attempt, normalizedOrder);
    wakeOrderReconciliation(order.id);
    return {
      intent_id: created.intent.id,
      attempt_id: attempt.id,
      attempt_no: attempt.attempt_no,
      order,
      status: normalizedOrder.status,
      trace_id: trace.traceId
    };
  } catch (error) {
    rateLease?.release();
    if (!attempt) throw annotateProviderWait(error);
    const classification = classifyWriteError(error, { writeStarted: swapStarted });
    if (classification.kind === 'uncertain') {
      await repository.markSubmissionUncertain(attempt.id, error);
      await walletWriteLane.quarantine(attempt, classification.code, {
        error: error.message,
        classification: classification.kind
      });
    } else {
      await walletWriteLane.release(attempt.id, 'WRITE_REJECTED_OR_NOT_STARTED');
      await repository.releaseRejectedAttempt(attempt.id, error);
    }
    throw error;
  }
}

async function retryIntent(intent, operatorId = 'retry-worker') {
  assertLiveMode(engineState);
  const chainConfigs = await configService.get('chain_configs') || {};
  const chainConfig = chainConfigs[intent.chain];
  if (!chainConfig?.retryEnabled) {
    const error = new Error('Chain retry is disabled by the current runtime configuration');
    error.code = 'RETRY_RUNTIME_DISABLED';
    throw error;
  }
  const readiness = await readinessService.getSnapshot(runtimeReadinessOptions());
  if (!readiness.readyToArm) {
    const error = new Error('Live readiness changed before retry');
    error.code = 'LIVE_READINESS_FAILED';
    throw error;
  }
  const deadlineAt = new Date(intent.expires_at).getTime();
  const rateLease = await reserveExecutionTrade({
    chainId: intent.chain,
    deadlineAt,
    requestContext: gmgnRequestContext({
      signal_id: intent.signal_id,
      trace_id: intent.trace_id || null,
      whitelist_id: intent.whitelist_id || null
    }, 'provider_lease')
  });
  let attempt = null;
  let swapStarted = false;
  try {
    const prepared = await buildPrepared(intent.signal_id, {
      rateLease,
      deadlineAt,
      forceRefresh: true,
      slippageCap: Number(intent.slippage_cap),
      policyPhase: 'live',
      providerMode: 'terminal',
      attemptNo: Number(intent.retry_count || 0) + 1,
      escalating: true
    });
    if (!engineState.scopeAllowsSignal(prepared.signal)) {
      const error = new Error('Signal is outside the armed runtime scope');
      error.code = 'LIVE_SCOPE_SIGNAL_NOT_ALLOWED';
      throw error;
    }
    assertTargetChainReady(readiness, intent.chain, {
      strategyScope: runtimeAuthorization.scoped(prepared.signal)
    });
    await livePolicy.evaluate(prepared.signal, { throwOnFailure: true });
    if (String(prepared.inputAmountRaw) !== String(intent.principal_amount_raw)) {
      const error = new Error('Retry principal differs from the original Trade Intent');
      error.code = 'RETRY_PRINCIPAL_CHANGED';
      throw error;
    }
    attempt = await intentRepository.createRetryAttempt(intent.id, {
      signalId: prepared.signal.signal_id,
      whitelistId: prepared.signal.whitelist_id,
      inputToken: prepared.chain.nativeToken,
      outputToken: prepared.signal.contract_address,
      inputAmountRaw: prepared.inputAmountRaw,
      inputAmountDisplay: prepared.budgetNative,
      requestFingerprint: repository.fingerprint({
        intent_id: intent.id,
        retry_count: Number(intent.retry_count) + 1,
        snapshot_hash: prepared.snapshotHash,
        input_amount_raw: prepared.inputAmountRaw
      }),
      metadata: {
        snapshot_hash: prepared.snapshotHash,
        cache: prepared.cacheMeta,
        condition_orders: prepared.conditionOrders,
        exit_strategy: prepared.signal.exit_strategy,
        exit_strategy_version: prepared.signal.exit_strategy_version,
        token_decimals: prepared.token.decimals,
        token_symbol: prepared.token.symbol,
        retry: true
      }
    });
    const snapshot = await tradeFailureEvidenceService.capturePreSubmitSnapshot(attempt, {
      tokenDecimals: prepared.token.decimals,
      quote: prepared.quote,
      gas: prepared.gas,
      nativeUsd: prepared.nativeUsd,
      config: intent.config_snapshot_json
    });
    const swapParams = buildSwapParams({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      inputToken: prepared.chain.nativeToken,
      outputToken: prepared.signal.contract_address,
      inputAmountRaw: prepared.inputAmountRaw,
      slippage: prepared.signal.slippage,
      conditionOrders: prepared.conditionOrders,
      gas: prepared.gas,
      attemptNo: attempt.attempt_no,
      retryConfig: chainConfig
    });
    await repository.beginBuySubmission(attempt.id, {
      snapshot,
      estimatedFeeNative: prepared.feeReserveNative,
      configurationFingerprint: readiness.configurationFingerprint,
      activationVersion: prepared.signal.activation_version,
      emergencyStop: String(process.env.EMERGENCY_STOP || 'false').toLowerCase() === 'true',
      operatorId,
      timing: prepared.timing
    });
    swapStarted = true;
    const response = await gmgnAccess.swap(swapParams, {
      rateLease, returnMeta: true, deadlineAt,
      requestContext: gmgnRequestContext(prepared.signal, 'swap', prepared.traceId)
    });
    rateLease.release();
    const normalizedOrder = gmgnAdapter.normalizeOrder(response.data);
    if (!normalizedOrder.providerOrderId) {
      const error = new Error('GMGN retry response did not include order_id');
      error.code = 'GMGN_ORDER_ID_MISSING';
      throw error;
    }
    const order = await repository.recordSubmittedOrder(
      attempt.id,
      normalizedOrder,
      prepared.quote,
      response.meta
    );
    await walletWriteLane.settleSubmittedOrder(attempt, normalizedOrder);
    wakeOrderReconciliation(order.id);
    return {
      intent_id: intent.id,
      attempt_id: attempt.id,
      attempt_no: attempt.attempt_no,
      order,
      status: normalizedOrder.status
    };
  } catch (error) {
    rateLease.release();
    if (!attempt) throw error;
    const classification = classifyWriteError(error, { writeStarted: swapStarted });
    if (classification.kind === 'uncertain') {
      await repository.markSubmissionUncertain(attempt.id, error);
      await walletWriteLane.quarantine(attempt, classification.code, { error: error.message });
    } else {
      await walletWriteLane.release(attempt.id, 'RETRY_REJECTED_OR_NOT_STARTED');
      await repository.releaseRejectedAttempt(attempt.id, error);
    }
    throw error;
  }
}

module.exports = {
  assertTargetChainReady,
  boundedEvidenceDeadline,
  buildPrepared,
  derivePriceImpactPct,
  evaluateRisk,
  execute,
  executeAutomatic,
  feeReserve,
  gmgnRequestContext,
  mergeTriggeredTokenInfo,
  loadCachedContext,
  nativeBalance,
  nativePriceUsd,
  resolveNativePriceUsd,
  resolveWalletNativeBalance,
  prepare,
  retryIntent,
  taxAdjustedPriceImpact
};
