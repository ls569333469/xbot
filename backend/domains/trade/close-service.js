const gmgnHttp = require('../../lib/gmgn-http');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const { assertLiveExitMode } = require('../../lib/runtime-mode');
const { decimalToRaw, minRaw, rawToDecimal } = require('../../lib/decimal-units');
const { buildSwapParams, requireChain } = require('./chain-adapters');
const prepareTokens = require('./prepare-token-service');
const repository = require('./trade-repository');

const CLOSABLE_STATUSES = new Set(['open', 'open_protected', 'open_unprotected', 'partially_closed']);
const ACTIVE_STRATEGY_STATUSES = new Set(['pending', 'running', 'partially_filled']);
const UNSAFE_STRATEGY_STATUSES = new Set(['triggered', 'cancelling', 'unknown']);
const CANCEL_VERIFY_DELAYS_MS = Object.freeze([0, 1000, 2000, 5000, 5000, 5000, 5000, 5000]);

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

function isDefinitiveWriteRejection(error) {
  return error.name === 'GmgnOpenApiError'
    && Number.isFinite(error.status)
    && error.status >= 400
    && error.status < 500;
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
    const raw = await gmgnHttp.queryStrategyOrder(
      position.chain_id,
      group.provider_order_id,
      group.wallet_address || position.lots?.[0]?.wallet_address,
      { baseToken: position.contract_address }
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
  const balanceRawResponse = await gmgnHttp.getWalletTokenBalance(
    chain.id,
    walletAddress,
    position.contract_address
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
  const quoteRaw = await gmgnHttp.quoteOrder(
    chain.id,
    walletAddress,
    position.contract_address,
    chain.nativeToken,
    inputAmountRaw,
    slippage,
    options.rateLease ? { rateLease: options.rateLease, deadlineAt: options.deadlineAt } : {}
  );
  const quote = gmgnAdapter.normalizeQuote(quoteRaw);
  const gas = ['bsc', 'base'].includes(chain.id)
    ? await gmgnHttp.getGasPrice(chain.id)
    : null;
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
    await repository.updateStrategyGroupStatus(
      item.group.id,
      ['pending', 'running', 'partially_filled'],
      'cancelling'
    );
    let response;
    try {
      response = await gmgnHttp.cancelStrategyOrder(prepared.chain.id, {
        chain: prepared.chain.id,
        from_address: prepared.wallet.address,
        order_id: item.group.provider_order_id,
        order_type: 'smart_trade'
      }, { deadlineAt: options.deadlineAt });
    } catch (error) {
      if (isDefinitiveWriteRejection(error)) {
        await repository.updateStrategyGroupStatus(item.group.id, ['cancelling'], 'running', {
          cancel_error: error.code || error.message
        });
      }
      throw normalizeCancellationWriteError(error);
    }
    const verification = await waitForStrategyCancellation({
      response,
      deadlineAt: options.deadlineAt,
      verify: async () => {
        const verificationRaw = await gmgnHttp.queryStrategyOrder(
          prepared.chain.id,
          item.group.provider_order_id,
          prepared.wallet.address,
          { baseToken: prepared.position.contract_address },
          { deadlineAt: options.deadlineAt }
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
  const rateLease = await gmgnHttp.scheduler.reserveTrade({ deadlineAt });
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
    attempt = await repository.createSellAttempt({
      ...prepared,
      closeIntentId: consumed.id,
      operatorId
    });
    await repository.transitionAttempt(attempt.id, ['reserved'], 'preparing', { actor: operatorId });
    await cancelStrategies(prepared, { deadlineAt });
    strategiesCancelled = true;
    await repository.transitionAttempt(attempt.id, ['preparing'], 'submitting', { actor: operatorId });
    swapStarted = true;
    const response = await gmgnHttp.swap(buildSwapParams({
      chain: prepared.chain.id,
      walletAddress: prepared.wallet.address,
      inputToken: prepared.position.contract_address,
      outputToken: prepared.chain.nativeToken,
      inputAmountRaw: prepared.inputAmountRaw,
      slippage: consumed.snapshot_json?.slippage ?? 0,
      conditionOrders: [],
      gas: prepared.gas
    }), { rateLease, returnMeta: true, deadlineAt });
    const normalizedOrder = gmgnAdapter.normalizeOrder(response.data);
    if (!normalizedOrder.providerOrderId) {
      const error = new Error('GMGN sell response did not include order_id');
      error.code = 'GMGN_ORDER_ID_MISSING';
      throw error;
    }
    const order = await repository.recordSubmittedOrder(attempt.id, normalizedOrder, prepared.quote, response.meta);
    return { attempt_id: attempt.id, order, status: normalizedOrder.status };
  } catch (error) {
    rateLease.release();
    if (!attempt) throw error;
    if ((swapStarted && !isDefinitiveWriteRejection(error))
        || ['STRATEGY_CANCEL_UNCERTAIN', 'STRATEGY_CANCEL_UNVERIFIED',
          'STRATEGY_TRIGGERED_DURING_CANCEL'].includes(error.code)) {
      await repository.markSellUncertain(attempt.id, positionId, error);
    } else {
      const fallback = !strategiesCancelled && prepared?.cancellableStrategies?.length > 0
        ? 'open_protected'
        : 'open_unprotected';
      await repository.rejectSellAttempt(attempt.id, positionId, error, fallback);
    }
    throw error;
  }
}

module.exports = {
  buildClosePrepared,
  CANCEL_VERIFY_DELAYS_MS,
  cancelConfirmed,
  cancellationFailureCode,
  closeSnapshotIdentity,
  execute,
  normalizeBalanceRaw,
  normalizeCancellationWriteError,
  prepare,
  resolveCloseSlippage,
  selectSellAmountRaw,
  sumRemainingRaw,
  waitForStrategyCancellation
};
