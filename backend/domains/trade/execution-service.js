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
const intentRepository = require('./trade-intent-repository');
const { walletWriteLane } = require('./wallet-write-lane');
const { tradeFailureEvidenceService } = require('./trade-failure-evidence-service');
const { classifyWriteError } = require('./gmgn-write-error-classifier');
const { probeRpc } = require('./chain-receipt-service');

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

function assertTargetChainReady(readiness, chainId) {
  const chain = readiness?.chains?.find((item) => item.chain === chainId);
  if (!chain?.ready) {
    const blockers = chain?.blockers || ['CHAIN_READINESS_MISSING'];
    const error = new Error(`Live readiness failed for ${chainId}: ${blockers.join(', ')}`);
    error.code = 'LIVE_CHAIN_READINESS_FAILED';
    error.details = chain || { chain: chainId, blockers };
    throw error;
  }
  return chain;
}

function evaluateRisk(context) {
  const reasons = [];
  const warnings = [];
  const security = context.security;
  const liquidity = context.pool.liquidityUsd ?? context.token.liquidityUsd;
  const rugRatio = security.rugRatio ?? context.token.rugRatio;
  const grossPriceImpact = derivePriceImpactPct(context);
  const priceImpact = taxAdjustedPriceImpact(grossPriceImpact, security.buyTax);

  if (security.isHoneypot === true) warnings.push('HONEYPOT_REPORTED_BY_PROVIDER');
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
  if (rugRatio === null) warnings.push('RUG_RATIO_UNKNOWN');
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
      wallet_native_balance: context.walletNativeBalance,
      required_native_balance: requiredNativeBalance,
      exit_gas_reserve: Number(context.exitGasReserve || 0)
    }
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
  const cached = await loadCachedContext(signal, { fresh: Boolean(options.forceRefresh) });
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
  const walletBalance = await resolveWalletNativeBalance(cached, options);
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
    assertTargetChainReady(readiness, prepared.chain.id);
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
    await intentRepository.savePreSubmitSnapshot(
      attempt.id,
      snapshot,
      prepared.feeReserveNative
    );
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
    await walletWriteLane.acquire({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      attemptId: attempt.id
    });
    await repository.transitionAttempt(attempt.id, ['reserved'], 'submitting', { actor: operatorId });
    swapStarted = true;
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
    await walletWriteLane.settleSubmittedOrder(attempt, normalizedOrder);
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

async function retryIntent(intent, operatorId = 'retry-worker') {
  assertLiveMode(engineState);
  const chainConfigs = await configService.get('chain_configs') || {};
  const chainConfig = chainConfigs[intent.chain];
  if (!chainConfig?.retryEnabled) {
    const error = new Error('Chain retry is disabled by the current runtime configuration');
    error.code = 'RETRY_RUNTIME_DISABLED';
    throw error;
  }
  const readiness = await readinessService.getSnapshot();
  if (!readiness.readyToArm) {
    const error = new Error('Live readiness changed before retry');
    error.code = 'LIVE_READINESS_FAILED';
    throw error;
  }
  assertTargetChainReady(readiness, intent.chain);
  const deadlineAt = new Date(intent.expires_at).getTime();
  const rateLease = await gmgnHttp.scheduler.reserveTrade({ deadlineAt });
  let attempt = null;
  let swapStarted = false;
  try {
    const prepared = await buildPrepared(intent.signal_id, {
      rateLease,
      deadlineAt,
      forceRefresh: true,
      slippageCap: Number(intent.slippage_cap),
      policyPhase: 'live'
    });
    await livePolicy.evaluate(prepared.signal, { throwOnFailure: true });
    if (!prepared.risk.passed) {
      const error = new Error(`Retry risk rejected: ${prepared.risk.reasons.join(', ')}`);
      error.code = prepared.risk.reasons[0] || 'RISK_REJECTED';
      throw error;
    }
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
    await intentRepository.savePreSubmitSnapshot(
      attempt.id,
      snapshot,
      prepared.feeReserveNative
    );
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
    await walletWriteLane.acquire({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      attemptId: attempt.id
    });
    await repository.transitionAttempt(attempt.id, ['reserved'], 'submitting', { actor: operatorId });
    swapStarted = true;
    const response = await gmgnHttp.swap(swapParams, { rateLease, returnMeta: true, deadlineAt });
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
  buildPrepared,
  derivePriceImpactPct,
  evaluateRisk,
  execute,
  feeReserve,
  loadCachedContext,
  nativeBalance,
  nativePriceUsd,
  resolveNativePriceUsd,
  resolveWalletNativeBalance,
  prepare,
  retryIntent,
  taxAdjustedPriceImpact
};
