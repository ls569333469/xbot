const gmgnAccess = require('../../lib/gmgn-access-service').accessFor('trade_close');
const { scopeKey } = require('../../lib/gmgn-shared-rate-limit');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const { assertLiveExitMode } = require('../../lib/runtime-mode');
const { decimalToRaw, minRaw, rawToDecimal } = require('../../lib/decimal-units');
const { buildSwapParams, requireChain } = require('./chain-adapters');
const prepareTokens = require('./prepare-token-service');
const repository = require('./trade-repository');
const intentRepository = require('./trade-intent-repository');
const { walletWriteLane } = require('./wallet-write-lane');
const { tradeFailureEvidenceService } = require('./trade-failure-evidence-service');
const { classifyWriteError, isDefinitiveWriteRejection } = require('./gmgn-write-error-classifier');
const configService = require('../config/service');

const CLOSABLE_STATUSES = new Set(['open', 'open_protected', 'open_unprotected', 'partially_closed']);
const ACTIVE_STRATEGY_STATUSES = new Set(['pending', 'running', 'partially_filled']);
const UNSAFE_STRATEGY_STATUSES = new Set(['triggered', 'cancelling', 'unknown']);
const CANCEL_VERIFY_DELAYS_MS = Object.freeze([0, 1000, 2000, 5000, 5000, 5000, 5000, 5000]);

function closeRequestContext(position, stage, options = {}) {
  const attemptId = Number(options.attemptId || 0) || null;
  return {
    source: 'trade_close',
    stage,
    signalId: Number(position?.signal_id || 0) || null,
    whitelistId: Number(position?.whitelist_id || 0) || null,
    traceId: position?.signal_trace_id || position?.trace_id || null,
    executionSessionId: attemptId
      ? `attempt:${attemptId}`
      : position?.id ? `position:${Number(position.id)}` : null,
    attemptId,
    positionId: Number(position?.id || 0) || null,
    side: options.side || null,
    rateScope: scopeKey()
  };
}

function sumRemainingRaw(lots) {
  return (lots || []).reduce(
    (total, lot) => total + BigInt(String(lot.remaining_amount_raw || '0')),
    0n
  ).toString();
}

function selectSellAmountRaw(requestedRaw, remainingRaw, walletAvailableRaw) {
  return minRaw(requestedRaw, remainingRaw, walletAvailableRaw);
}

function resolveCloseSlippage(position, requestedSlippage) {
  const slippage = Number(requestedSlippage ?? position?.whitelist_slippage);
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 100) {
    const error = new Error('Close slippage must be between 0 and 100');
    error.code = 'CLOSE_SLIPPAGE_INVALID';
    throw error;
  }
  return slippage;
}

function closeSnapshotIdentity({
  position,
  chain,
  walletAddress,
  tokenDecimals,
  remainingRaw,
  walletAvailableRaw,
  inputAmountRaw,
  percent,
  slippage,
  strategyStates
}) {
  return {
    position_id: Number(position.id),
    position_status: position.status,
    chain: chain.id,
    wallet: walletAddress,
    token: position.contract_address,
    token_decimals: tokenDecimals,
    remaining_raw: remainingRaw,
    wallet_available_raw: walletAvailableRaw,
    input_amount_raw: inputAmountRaw,
    percent,
    slippage,
    strategies: strategyStates.map((item) => ({
      id: item.group.id,
      order_id: item.group.provider_order_id,
      status: item.status
    }))
  };
}

function strategyRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.list)) return value.list;
  if (Array.isArray(value?.orders)) return value.orders;
  return value && typeof value === 'object' ? [value] : [];
}

function findStrategy(raw, providerOrderId) {
  return strategyRows(raw)
    .map((item) => gmgnAdapter.normalizeStrategy(item))
    .find((item) => item.providerOrderId === String(providerOrderId)) || null;
}

function normalizeBalanceRaw(rawBalance, decimals) {
  const normalized = gmgnAdapter.normalizeWalletTokenBalance(rawBalance, decimals);
  if (Number(normalized.decimals) !== Number(decimals)) {
    const error = new Error('GMGN wallet balance decimals do not match the verified position lot');
    error.code = 'POSITION_BALANCE_DECIMALS_MISMATCH';
    throw error;
  }
  if (normalized.amountRaw !== null) return normalized.amountRaw;
  return decimalToRaw(normalized.amountDisplay, decimals);
}

function cancelConfirmed(data) {
  if (data === true) return true;
  if (data?.success === true || data?.cancelled === true || data?.canceled === true) return true;
  return ['cancelled', 'canceled', 'closed'].includes(String(data?.status || '').toLowerCase());
}

function cancellationFailureCode(response, verification) {
  if (verification?.status === 'cancelled' && !verification.closeTxHash) return null;
  if (verification?.status === 'triggered' || verification?.closeTxHash) {
    return 'STRATEGY_TRIGGERED_DURING_CANCEL';
  }
  if (!verification && !cancelConfirmed(response)) return 'STRATEGY_CANCEL_UNCERTAIN';
  return 'STRATEGY_CANCEL_UNVERIFIED';
}

function cancellationError(code, cause) {
  const error = new Error(code === 'STRATEGY_TRIGGERED_DURING_CANCEL'
    ? 'GMGN strategy triggered while cancellation was being verified'
    : 'GMGN strategy cancellation was not verified in provider history');
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function normalizeCancellationWriteError(error) {
  return isDefinitiveWriteRejection(error)
    ? error
    : cancellationError('STRATEGY_CANCEL_UNCERTAIN', error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStrategyCancellation({
  response,
  verify,
  deadlineAt,
  delaysMs = CANCEL_VERIFY_DELAYS_MS,
  sleepFn = sleep,
  now = Date.now
}) {
  let lastVerification = null;
  let lastQueryError = null;

  for (const delayMs of delaysMs) {
    const delay = Math.max(0, Number(delayMs) || 0);
    if (Number.isFinite(deadlineAt) && now() + delay >= deadlineAt) break;
    if (delay > 0) await sleepFn(delay);
    if (Number.isFinite(deadlineAt) && now() >= deadlineAt) break;

    try {
      lastVerification = await verify();
      const failureCode = cancellationFailureCode(response, lastVerification);
      if (!failureCode) return lastVerification;
      if (failureCode === 'STRATEGY_TRIGGERED_DURING_CANCEL') {
        throw cancellationError(failureCode);
      }
    } catch (error) {
      if (error.code === 'STRATEGY_TRIGGERED_DURING_CANCEL') throw error;
      lastQueryError = error;
    }
  }

  throw cancellationError(
    cancellationFailureCode(response, lastVerification),
    lastQueryError
  );
}

async function loadStrategyState(position) {
  const groups = Array.isArray(position.strategy_groups) ? position.strategy_groups : [];
  const activeGroups = groups.filter((group) => ACTIVE_STRATEGY_STATUSES.has(group.status)
    || UNSAFE_STRATEGY_STATUSES.has(group.status));
  const states = [];
  for (const group of activeGroups) {
    if (!group.provider_order_id) {
      states.push({ group, normalized: null, status: 'unknown' });
      continue;
    }
    const raw = await gmgnAccess.queryStrategyOrder(
      position.chain_id,
      group.provider_order_id,
      group.wallet_address || position.lots?.[0]?.wallet_address,
      { baseToken: position.contract_address },
      { requestContext: closeRequestContext(position, 'strategy_state') }
    );
    const normalized = findStrategy(raw, group.provider_order_id);
    states.push({ group, normalized, status: normalized?.status || 'unknown' });
  }
  return states;
}

async function buildClosePrepared(positionId, options = {}) {
  const position = await repository.getPositionForClose(positionId);
  if (!position) {
    const error = new Error('Position not found');
    error.code = 'POSITION_NOT_FOUND';
    throw error;
  }
  if (position.execution_mode !== 'live' || !CLOSABLE_STATUSES.has(position.status)) {
    const error = new Error('Position is not an open live position');
    error.code = 'POSITION_NOT_CLOSABLE';
    throw error;
  }
  const chain = requireChain(position.chain_id);
  const slippage = resolveCloseSlippage(position, options.slippage);
  const lots = Array.isArray(position.lots) ? position.lots : [];
  if (lots.length === 0) {
    const error = new Error('Position has no verified lot');
    error.code = 'POSITION_LOT_MISSING';
    throw error;
  }
  const tokenDecimals = Number(lots[0].token_decimals);
  if (!lots.every((lot) => Number(lot.token_decimals) === tokenDecimals)) {
    const error = new Error('Position lots disagree on token decimals');
    error.code = 'POSITION_LOT_DECIMALS_MISMATCH';
    throw error;
  }
  const walletAddress = String(lots[0].wallet_address || '');
  if (!walletAddress || !lots.every((lot) => String(lot.wallet_address) === walletAddress)) {
    const error = new Error('Position lots disagree on managed wallet');
    error.code = 'POSITION_LOT_WALLET_MISMATCH';
    throw error;
  }

  const percent = Math.min(100, Math.max(1, Number(options.percent || 100)));
  const remainingRaw = sumRemainingRaw(lots);
  const requestedRaw = ((BigInt(remainingRaw) * BigInt(Math.round(percent * 100))) / 10000n).toString();
  const balanceRawResponse = await gmgnAccess.getWalletTokenBalance(
    chain.id,
    walletAddress,
    position.contract_address,
    { requestContext: closeRequestContext(position, 'wallet_balance') }
  );
  const walletAvailableRaw = normalizeBalanceRaw(balanceRawResponse, tokenDecimals);
  const inputAmountRaw = selectSellAmountRaw(requestedRaw, remainingRaw, walletAvailableRaw);
  if (BigInt(inputAmountRaw) <= 0n) {
    const error = new Error('No wallet balance is available for this position lot');
    error.code = 'POSITION_BALANCE_EMPTY';
    throw error;
  }

  const strategyStates = await loadStrategyState(position);
  const unsafe = strategyStates.find((item) => UNSAFE_STRATEGY_STATUSES.has(item.status));
  if (unsafe) {
    const error = new Error(`Strategy ${unsafe.group.provider_order_id || unsafe.group.id} is ${unsafe.status}`);
    error.code = 'STRATEGY_STATE_UNSAFE';
    throw error;
  }
  const cancellable = strategyStates.filter((item) => ACTIVE_STRATEGY_STATUSES.has(item.status));
  const quoteRaw = await gmgnAccess.quoteOrder(
    chain.id,
    walletAddress,
    position.contract_address,
    chain.nativeToken,
    inputAmountRaw,
    slippage,
    {
      ...(options.rateLease ? { rateLease: options.rateLease } : {}),
      ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
      requestContext: closeRequestContext(position, 'quote')
    }
  );
  const quote = gmgnAdapter.normalizeQuote(quoteRaw);
  // Gas is resolved from the local execution profile/RPC snapshot. A close
  // preparation must not add an unbounded GMGN gas read before the trade.
  const gas = null;
  const snapshotHash = repository.fingerprint(closeSnapshotIdentity({
    position,
    chain,
    walletAddress,
    tokenDecimals,
    remainingRaw,
    walletAvailableRaw,
    inputAmountRaw,
    percent,
    slippage,
    strategyStates
  }));
  return {
    position,
    chain,
    wallet: { address: walletAddress },
    tokenDecimals,
    remainingRaw,
    walletAvailableRaw,
    inputAmountRaw,
    inputAmountDisplay: rawToDecimal(inputAmountRaw, tokenDecimals, 18),
    percent,
    slippage,
    quote,
    gas,
    cancellableStrategies: cancellable,
    snapshotHash,
    summary: {
      position_id: Number(position.id),
      chain: chain.id,
      wallet: walletAddress,
      token: position.contract_address,
      position_status: position.status,
      position_remaining_raw: remainingRaw,
      wallet_available_raw: walletAvailableRaw,
      sell_amount_raw: inputAmountRaw,
      sell_amount: rawToDecimal(inputAmountRaw, tokenDecimals, 18),
      estimated_native_output_raw: quote.outputAmountRaw,
      strategy_action: cancellable.length > 0 ? 'cancel_then_sell' : 'sell',
      strategy_order_ids: cancellable.map((item) => item.group.provider_order_id),
      percent,
      slippage
    }
  };
}

async function prepare(positionId, operatorId, options = {}) {
  const prepared = await buildClosePrepared(positionId, options);
  const token = await prepareTokens.create({
    purpose: 'close',
    positionId,
    operatorId,
    snapshotHash: prepared.snapshotHash,
    snapshot: prepared.summary
  });
  return { ...prepared.summary, prepare_token: token.token, expires_in_seconds: token.expiresInSeconds };
}

async function cancelStrategies(prepared, options = {}) {
  for (const item of prepared.cancellableStrategies) {
    await walletWriteLane.acquire({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      attemptId: options.attemptId
    });
    await repository.updateStrategyGroupStatus(
      item.group.id,
      ['pending', 'running', 'partially_filled'],
      'cancelling'
    );
    let response;
    try {
      response = await gmgnAccess.cancelStrategyOrder(prepared.chain.id, {
        chain: prepared.chain.id,
        from_address: prepared.wallet.address,
        order_id: item.group.provider_order_id,
        order_type: 'smart_trade'
      }, {
        deadlineAt: options.deadlineAt,
        requestContext: {
          ...closeRequestContext(prepared.position, 'strategy_cancel'),
          executionSessionId: `attempt:${Number(options.attemptId || prepared.position.id)}:recovery`
        }
      });
    } catch (error) {
      if (isDefinitiveWriteRejection(error)) {
        await walletWriteLane.release(options.attemptId, 'STRATEGY_CANCEL_REJECTED');
        await repository.updateStrategyGroupStatus(item.group.id, ['cancelling'], 'running', {
          cancel_error: error.code || error.message
        });
      } else {
        await walletWriteLane.quarantine({
          id: options.attemptId,
          chain: prepared.chain.id,
          wallet_address: prepared.wallet.address
        }, error.code || 'STRATEGY_CANCEL_UNCERTAIN', { error: error.message });
      }
      throw normalizeCancellationWriteError(error);
    }
    const verification = await waitForStrategyCancellation({
      response,
      deadlineAt: options.deadlineAt,
      verify: async () => {
        const verificationRaw = await gmgnAccess.queryStrategyOrder(
          prepared.chain.id,
          item.group.provider_order_id,
          prepared.wallet.address,
          { baseToken: prepared.position.contract_address },
          {
            deadlineAt: options.deadlineAt,
            requestContext: {
              ...closeRequestContext(prepared.position, 'strategy_cancel_verify'),
              executionSessionId: `attempt:${Number(options.attemptId || prepared.position.id)}:recovery`
            }
          }
        );
        return findStrategy(verificationRaw, item.group.provider_order_id);
      }
    });
    await repository.updateStrategyGroupStatus(
      item.group.id,
      ['cancelling'],
      'cancelled',
      { cancel_response: response, cancel_verification: verification.raw || verification }
    );
    await walletWriteLane.release(options.attemptId, 'STRATEGY_CANCEL_VERIFIED');
  }
}

async function execute(positionId, prepareToken, operatorId, options = {}) {
  // The engine arm state is the new-order gate. Existing live positions must
  // remain closable when social ingestion faults or the buy gate is stopped.
  assertLiveExitMode();
  const consumed = await prepareTokens.consume(prepareToken, { purpose: 'close', operatorId });
  if (Number(consumed.position_id) !== Number(positionId)) {
    const error = new Error('Prepare token does not belong to this position');
    error.code = 'PREPARE_TOKEN_MISMATCH';
    throw error;
  }
  const deadlineAt = Date.now() + 60_000;
  const positionContext = await repository.getPositionForClose(positionId);
  const rateLease = await gmgnAccess.reserveTrade({
    deadlineAt,
    requestContext: closeRequestContext(
      positionContext || { id: positionId },
      'provider_lease'
    )
  });
  let prepared;
  let attempt;
  let swapStarted = false;
  let strategiesCancelled = false;
  try {
    prepared = await buildClosePrepared(positionId, {
      percent: consumed.snapshot_json?.percent,
      slippage: consumed.snapshot_json?.slippage ?? 0,
      rateLease,
      deadlineAt
    });
    if (prepared.snapshotHash !== consumed.snapshot_hash) {
      const error = new Error('Position, wallet, quote inputs, or strategy state changed; prepare again');
      error.code = 'PREPARE_SNAPSHOT_CHANGED';
      throw error;
    }
    const created = await repository.createSellAttempt({
      ...prepared,
      closeIntentId: consumed.id,
      operatorId
    });
    if (created.merged) {
      rateLease.release();
      return {
        intent_id: created.intent.id,
        attempt_id: created.attempt?.id || null,
        status: 'existing_close_intent'
      };
    }
    attempt = created.attempt;
    await repository.transitionAttempt(attempt.id, ['reserved'], 'preparing', { actor: operatorId });
    await cancelStrategies(prepared, { deadlineAt, attemptId: attempt.id });
    strategiesCancelled = true;
    const snapshot = await tradeFailureEvidenceService.capturePreSubmitSnapshot(attempt, {
      tokenDecimals: prepared.tokenDecimals,
      tokenBalance: { balance_raw: prepared.walletAvailableRaw, decimal: prepared.tokenDecimals },
      quote: prepared.quote,
      gas: prepared.gas,
      config: created.intent.config_snapshot_json
    });
    await intentRepository.savePreSubmitSnapshot(attempt.id, snapshot);
    const swapParams = buildSwapParams({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      inputToken: prepared.position.contract_address,
      outputToken: prepared.chain.nativeToken,
      inputAmountRaw: prepared.inputAmountRaw,
      slippage: consumed.snapshot_json?.slippage ?? 0,
      conditionOrders: [],
      gas: prepared.gas,
      attemptNo: attempt.attempt_no,
      retryConfig: created.intent.config_snapshot_json?.chain_config
    });
    await walletWriteLane.acquire({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      attemptId: attempt.id
    });
    await repository.transitionAttempt(attempt.id, ['preparing'], 'submitting', { actor: operatorId });
    swapStarted = true;
    const response = await gmgnAccess.swap(swapParams, {
      rateLease,
      returnMeta: true,
      deadlineAt,
      requestContext: {
        ...closeRequestContext(prepared.position, 'swap', {
          attemptId: attempt.id,
          side: 'sell'
        })
      }
    });
    const normalizedOrder = gmgnAdapter.normalizeOrder(response.data);
    if (!normalizedOrder.providerOrderId) {
      const error = new Error('GMGN sell response did not include order_id');
      error.code = 'GMGN_ORDER_ID_MISSING';
      throw error;
    }
    const order = await repository.recordSubmittedOrder(attempt.id, normalizedOrder, prepared.quote, response.meta);
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
    if ((swapStarted && classification.kind === 'uncertain')
        || ['STRATEGY_CANCEL_UNCERTAIN', 'STRATEGY_CANCEL_UNVERIFIED',
          'STRATEGY_TRIGGERED_DURING_CANCEL'].includes(error.code)) {
      await repository.markSellUncertain(attempt.id, positionId, error);
      await walletWriteLane.quarantine(attempt, error.code || classification.code, {
        error: error.message,
        classification: classification.kind
      });
    } else {
      await walletWriteLane.release(attempt.id, 'WRITE_REJECTED_OR_NOT_STARTED');
      const fallback = !strategiesCancelled && prepared?.cancellableStrategies?.length > 0
        ? 'open_protected'
        : 'open_unprotected';
      await repository.rejectSellAttempt(attempt.id, positionId, error, fallback);
    }
    throw error;
  }
}

async function retryIntent(intent, operatorId = 'retry-worker') {
  assertLiveExitMode();
  const chainConfigs = await configService.get('chain_configs') || {};
  const chainConfig = chainConfigs[intent.chain];
  if (!chainConfig?.retryEnabled) {
    const error = new Error('Chain close retry is disabled by runtime configuration');
    error.code = 'RETRY_RUNTIME_DISABLED';
    throw error;
  }
  const deadlineAt = new Date(intent.expires_at).getTime();
  const positionContext = await repository.getPositionForClose(intent.position_id);
  const rateLease = await gmgnAccess.reserveTrade({
    deadlineAt,
    requestContext: closeRequestContext(
      positionContext || { id: intent.position_id, signal_id: intent.signal_id },
      'provider_lease'
    )
  });
  let prepared;
  let attempt;
  let swapStarted = false;
  let strategiesCancelled = false;
  try {
    prepared = await buildClosePrepared(intent.position_id, {
      percent: 100,
      slippage: Number(intent.slippage_cap),
      rateLease,
      deadlineAt
    });
    attempt = await intentRepository.createRetryAttempt(intent.id, {
      signalId: prepared.position.signal_id,
      whitelistId: prepared.position.whitelist_id,
      positionId: prepared.position.id,
      inputToken: prepared.position.contract_address,
      outputToken: prepared.chain.nativeToken,
      inputAmountRaw: prepared.inputAmountRaw,
      inputAmountDisplay: prepared.inputAmountDisplay,
      requestFingerprint: repository.fingerprint({
        intent_id: intent.id,
        retry_count: Number(intent.retry_count) + 1,
        snapshot_hash: prepared.snapshotHash,
        input_amount_raw: prepared.inputAmountRaw
      }),
      metadata: {
        snapshot_hash: prepared.snapshotHash,
        token_decimals: prepared.tokenDecimals,
        retry: true
      },
      status: 'reserved',
      actor: operatorId
    });
    await repository.transitionAttempt(attempt.id, ['reserved'], 'preparing', { actor: operatorId });
    await cancelStrategies(prepared, { deadlineAt, attemptId: attempt.id });
    strategiesCancelled = true;
    const snapshot = await tradeFailureEvidenceService.capturePreSubmitSnapshot(attempt, {
      tokenDecimals: prepared.tokenDecimals,
      tokenBalance: { balance_raw: prepared.walletAvailableRaw, decimal: prepared.tokenDecimals },
      quote: prepared.quote,
      gas: prepared.gas,
      config: intent.config_snapshot_json
    });
    await intentRepository.savePreSubmitSnapshot(attempt.id, snapshot);
    const swapParams = buildSwapParams({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      inputToken: prepared.position.contract_address,
      outputToken: prepared.chain.nativeToken,
      inputAmountRaw: prepared.inputAmountRaw,
      slippage: Number(intent.slippage_cap),
      conditionOrders: [],
      gas: prepared.gas,
      attemptNo: attempt.attempt_no,
      retryConfig: chainConfig
    });
    await walletWriteLane.acquire({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      attemptId: attempt.id
    });
    await repository.transitionAttempt(attempt.id, ['preparing'], 'submitting', { actor: operatorId });
    swapStarted = true;
    const response = await gmgnAccess.swap(swapParams, {
      rateLease,
      returnMeta: true,
      deadlineAt,
      requestContext: {
        ...closeRequestContext(prepared.position, 'swap', {
          attemptId: attempt.id,
          side: 'sell'
        }),
        source: 'trade_close_retry',
      }
    });
    const normalizedOrder = gmgnAdapter.normalizeOrder(response.data);
    if (!normalizedOrder.providerOrderId) {
      const error = new Error('GMGN close retry response did not include order_id');
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
    if ((swapStarted && classification.kind === 'uncertain')
        || ['STRATEGY_CANCEL_UNCERTAIN', 'STRATEGY_CANCEL_UNVERIFIED',
          'STRATEGY_TRIGGERED_DURING_CANCEL'].includes(error.code)) {
      await repository.markSellUncertain(attempt.id, intent.position_id, error);
      await walletWriteLane.quarantine(attempt, error.code || classification.code, {
        error: error.message,
        retry: true
      });
    } else {
      await walletWriteLane.release(attempt.id, 'CLOSE_RETRY_REJECTED_OR_NOT_STARTED');
      await repository.rejectSellAttempt(
        attempt.id,
        intent.position_id,
        error,
        strategiesCancelled ? 'open_unprotected' : 'open_protected'
      );
    }
    throw error;
  }
}

module.exports = {
  buildClosePrepared,
  CANCEL_VERIFY_DELAYS_MS,
  cancelConfirmed,
  cancellationFailureCode,
  closeRequestContext,
  closeSnapshotIdentity,
  execute,
  normalizeBalanceRaw,
  normalizeCancellationWriteError,
  prepare,
  retryIntent,
  resolveCloseSlippage,
  selectSellAmountRaw,
  sumRemainingRaw,
  waitForStrategyCancellation
};
