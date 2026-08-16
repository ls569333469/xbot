const db = require('../../lib/db');
const logger = require('../../lib/logger');
const crypto = require('crypto');
const defaultGmgnAccess = require('../../lib/gmgn-access-service').accessFor('trade_reconciliation');
const { scopeKey } = require('../../lib/gmgn-shared-rate-limit');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const receiptService = require('./chain-receipt-service');
const repository = require('./trade-repository');
const { requireChain } = require('./chain-adapters');
const { PRIORITIES, parseResetAt } = require('../../lib/gmgn-rate-scheduler');
const { decimalToRaw } = require('../../lib/decimal-units');
const { tradeFailureEvidenceService } = require('./trade-failure-evidence-service');

const RECONCILER_LOCK = 'xbot:trade-reconciler';
const DEFAULT_STRATEGY_BATCH_GROUP_BUDGET = 1;

function recoveryRequest(row, stage, options = {}) {
  const requestContext = options.requestContext || {};
  const signalId = Number(options.signalId || row?.signal_id || 0) || null;
  const attemptId = Number(options.attemptId || row?.attempt_id || 0) || null;
  const positionId = Number(options.positionId || row?.position_id || 0) || null;
  const executionSessionId = options.executionSessionId
    || (signalId ? `signal:${signalId}`
      : attemptId ? `attempt:${attemptId}:recovery`
        : positionId ? `position:${positionId}:recovery` : null);
  const { requestContext: _ignored, ...requestOptions } = options;
  return {
    ...requestOptions,
    requestContext: {
      source: 'trade_reconciliation',
      stage,
      signalId,
      policyId: Number(options.policyId || row?.policy_id || 0) || null,
      whitelistId: Number(options.whitelistId || row?.whitelist_id || 0) || null,
      traceId: options.traceId || row?.trace_id || null,
      executionSessionId,
      rateScope: scopeKey(),
      ...requestContext
    }
  };
}

function pollingIntervalMs(submittedAt, state, random = Math.random) {
  if (['closing', 'triggered'].includes(state)) return 1000;
  if (state === 'definitive_failed_no_fill') {
    return Math.round(15 * 60_000 + random() * 15 * 60_000);
  }
  const ageMs = Math.max(0, Date.now() - new Date(submittedAt).getTime());
  if (ageMs < 10_000) return 1000;
  if (ageMs < 30_000) return 2000;
  if (ageMs < 120_000) return 5000;
  return Math.round(15_000 + random() * 15_000);
}

function nextQueryAt(order, state, random) {
  return new Date(Date.now() + pollingIntervalMs(order.submitted_at, state, random));
}

function strategyPollingIntervalMs(state, random = Math.random) {
  if (['triggered', 'cancelling'].includes(state)) return 1000;
  if (state === 'unknown') return 60_000;
  // GMGN executes protection orders remotely. Open-order polling only keeps
  // local position state fresh, so it must not become a continuous rate load.
  return Math.round(5 * 60_000 + random() * 5 * 60_000);
}

function nextStrategyQueryAt(state, random) {
  return new Date(Date.now() + strategyPollingIntervalMs(state, random));
}

function strategyFailureRetryAt(rows, error, random = Math.random, now = Date.now()) {
  const states = new Set((rows || []).map((row) => String(row.status || '').toLowerCase()));
  const urgent = states.has('triggered') || states.has('cancelling');
  const unknown = states.has('unknown');
  const normalDelayMs = urgent
    ? 30_000
    : unknown
      ? 60_000
      : Math.round(5 * 60_000 + random() * 5 * 60_000);
  const code = String(error?.code || '').toUpperCase();
  const rateLimited = Number(error?.status) === 429 || code.includes('RATE_LIMIT');
  if (!rateLimited) return new Date(now + normalDelayMs);

  const explicitRetryTimes = [];
  if (error?.resetAt != null) explicitRetryTimes.push(parseResetAt(error.resetAt, now));
  const retryAfterSeconds = Number(error?.retryAfterSeconds);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    explicitRetryTimes.push(now + retryAfterSeconds * 1000);
  }
  const explicitRetryAt = explicitRetryTimes.length ? Math.max(...explicitRetryTimes) : null;
  if (Number.isFinite(explicitRetryAt) && explicitRetryAt > now) {
    const jitterMs = Math.round(1000 + random() * 4000);
    return new Date(explicitRetryAt + jitterMs);
  }
  return new Date(now + Math.max(normalDelayMs, 5 * 60_000));
}

function strategyBatchKey(row = {}) {
  return `${String(row.chain_id || '').toLowerCase()}:${String(row.wallet_address || '').toLowerCase()}`;
}

function groupStrategyRows(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = strategyBatchKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

function strategyBatchGroupBudget(value = process.env.XBOT_STRATEGY_SYNC_GROUP_BUDGET) {
  const budget = Number(value || DEFAULT_STRATEGY_BATCH_GROUP_BUDGET);
  return Number.isInteger(budget) ? Math.min(4, Math.max(1, budget)) : DEFAULT_STRATEGY_BATCH_GROUP_BUDGET;
}

function orderFromStoredRow(row) {
  return gmgnAdapter.normalizeOrder({
    order_id: row.provider_order_id,
    status: 'confirmed',
    hash: row.tx_hash,
    strategy_order_id: row.last_response_json?.strategy_order_id,
    report: row.report_json || {}
  });
}

function receiptContainsTradedToken(row, receipt) {
  const chain = requireChain(row.chain);
  const tradedToken = row.side === 'sell' ? row.input_token : row.output_token;
  if (!tradedToken || tradedToken === chain.nativeToken) return false;
  if (chain.id === 'sol') {
    const balances = [
      ...(receipt.transfers?.preTokenBalances || []),
      ...(receipt.transfers?.postTokenBalances || [])
    ];
    return balances.some((balance) => String(balance.mint || '') === String(tradedToken));
  }
  return (Array.isArray(receipt.transfers) ? receipt.transfers : [])
    .some((log) => String(log.address || '').toLowerCase() === String(tradedToken).toLowerCase());
}

function solTokenAmount(balance) {
  const raw = balance?.uiTokenAmount?.amount ?? balance?.amount;
  return /^\d+$/.test(String(raw || '')) ? BigInt(raw) : 0n;
}

function receiptTradedAmountRaw(row, receipt) {
  const chain = requireChain(row.chain);
  const wallet = String(row.wallet_address || '').toLowerCase();
  const tradedToken = row.side === 'sell' ? row.input_token : row.output_token;
  if (!tradedToken || tradedToken === chain.nativeToken) return null;
  if (chain.id === 'sol') {
    const totals = (balances) => (balances || []).reduce((total, balance) => {
      if (String(balance.mint || '') !== String(tradedToken)) return total;
      if (String(balance.owner || '').toLowerCase() !== wallet) return total;
      return total + solTokenAmount(balance);
    }, 0n);
    const before = totals(receipt.transfers?.preTokenBalances);
    const after = totals(receipt.transfers?.postTokenBalances);
    const delta = row.side === 'sell' ? before - after : after - before;
    return delta >= 0n ? delta.toString() : null;
  }
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  let total = 0n;
  let matched = false;
  for (const log of Array.isArray(receipt.transfers) ? receipt.transfers : []) {
    if (String(log.address || '').toLowerCase() !== String(tradedToken).toLowerCase()) continue;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (String(topics[0] || '').toLowerCase() !== transferTopic || topics.length < 3) continue;
    const from = `0x${String(topics[1]).slice(-40)}`.toLowerCase();
    const to = `0x${String(topics[2]).slice(-40)}`.toLowerCase();
    if ((row.side === 'sell' && from !== wallet) || (row.side !== 'sell' && to !== wallet)) continue;
    if (!/^0x[0-9a-f]+$/i.test(String(log.data || ''))) continue;
    total += BigInt(log.data);
    matched = true;
  }
  return matched ? total.toString() : null;
}

function receiptMatchesTradedAmount(row, normalizedOrder, receipt) {
  const expected = row.side === 'sell'
    ? normalizedOrder.report.inputAmountRaw || row.input_amount_raw
    : normalizedOrder.report.outputAmountRaw || row.output_amount_raw;
  if (!/^\d+$/.test(String(expected || ''))) return false;
  const actual = receiptTradedAmountRaw(row, receipt);
  if (!/^\d+$/.test(String(actual || ''))) return false;
  if (row.side === 'sell') return BigInt(actual) === BigInt(expected);
  if (BigInt(actual) >= BigInt(expected)) return true;

  // Robinhood may report an aggregate swap output rounded up by one raw unit.
  // The managed-wallet ERC-20 Transfer remains the settlement authority.
  return row.chain === 'robinhood' && BigInt(expected) - BigInt(actual) <= 1n;
}

function orderWithReceiptTradedAmount(row, normalizedOrder, receipt) {
  if (row.side === 'sell') return normalizedOrder;
  const actual = receiptTradedAmountRaw(row, receipt);
  if (!/^\d+$/.test(String(actual || ''))) return normalizedOrder;
  const reported = normalizedOrder.report.outputAmountRaw || row.output_amount_raw || null;
  return {
    ...normalizedOrder,
    report: {
      ...normalizedOrder.report,
      outputAmountRaw: actual
    },
    raw: {
      ...(normalizedOrder.raw || {}),
      xbot_receipt_settlement: {
        source: 'managed_wallet_token_transfer',
        provider_output_amount_raw: reported,
        receipt_output_amount_raw: actual
      }
    }
  };
}

function receiptHasVerifiableNativeProceeds(row, receipt) {
  const chain = requireChain(row.chain);
  if (row.side !== 'sell' || String(row.output_token) !== String(chain.nativeToken)) return true;
  const delta = String(receipt.nativeBalanceDeltaRaw ?? '');
  const routerProceeds = String(receipt.nativeProceedsRaw ?? '');
  return (/^-?\d+$/.test(delta) && BigInt(delta) > 0n)
    || (/^\d+$/.test(routerProceeds) && BigInt(routerProceeds) > 0n);
}

function strategyRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.list)) return value.list;
  if (Array.isArray(value?.orders)) return value.orders;
  return value && typeof value === 'object' ? [value] : [];
}

function providerTimeMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function sameAddress(chain, left, right) {
  const leftValue = String(left || '').trim();
  const rightValue = String(right || '').trim();
  if (!leftValue || !rightValue) return false;
  return chain === 'sol'
    ? leftValue === rightValue
    : leftValue.toLowerCase() === rightValue.toLowerCase();
}

function strategyMatchesConfirmedOrder(row, normalizedOrder, strategy, windowMs = 10 * 60_000) {
  if (!strategy.providerOrderId
      || !sameAddress(row.chain, strategy.walletAddress, row.wallet_address)
      || !sameAddress(row.chain, strategy.baseToken, row.output_token)) return false;
  const outputAmountRaw = String(normalizedOrder.report.outputAmountRaw || row.output_amount_raw || '');
  if (!/^\d+$/.test(outputAmountRaw) || String(strategy.openAmountRaw || '') !== outputAmountRaw) {
    return false;
  }
  const inputAmountRaw = String(normalizedOrder.report.inputAmountRaw || row.input_amount_raw || '');
  if (strategy.quoteInvestmentRaw && /^\d+$/.test(inputAmountRaw)
      && String(strategy.quoteInvestmentRaw) !== inputAmountRaw) return false;
  const submittedAt = new Date(row.submitted_at).getTime();
  const createdAt = providerTimeMs(strategy.createdAt);
  return Number.isFinite(submittedAt) && createdAt !== null
    && Math.abs(createdAt - submittedAt) <= windowMs;
}

class TradeReconciler {
  constructor(options = {}) {
    this.db = options.db || db;
    // Keep the injection seam for unit tests while production uses the guarded access object.
    this.gmgnAccess = options.gmgnAccess || options.gmgnHttp || defaultGmgnAccess;
    this.receiptService = options.receiptService || receiptService;
    this.repository = options.repository || repository;
    this.failureEvidenceService = options.failureEvidenceService || tradeFailureEvidenceService;
    this.logger = options.logger || logger;
    this.random = options.random || Math.random;
    this.timer = null;
    this.running = false;
    this.startedAt = null;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.processed = 0;
    this.hotProcessed = 0;
    this.hotTimers = new Set();
    this.wsBroadcast = null;
    this.strategyDeferredGroups = 0;
    this.lastStrategyBacklogWarnAt = 0;
  }

  async reconcileOrder(row) {
    if (typeof this.repository.claimOrderReconciliation !== 'function') {
      return this.reconcileClaimedOrder(row);
    }
    const token = crypto.randomUUID();
    const claimed = await this.repository.claimOrderReconciliation(row.id, token);
    if (!claimed) return { orderId: row.id, status: 'reconciliation_claimed_elsewhere' };
    try {
      return await this.reconcileClaimedOrder(row);
    } finally {
      await this.repository.releaseOrderReconciliation(row.id, token).catch(() => {});
    }
  }

  async reconcileClaimedOrder(row) {
    let normalized;
    if (row.normalized_status === 'chain_verifying') {
      normalized = orderFromStoredRow(row);
    } else {
      const response = await this.gmgnAccess.queryOrder(
        row.provider_order_id,
        row.chain,
        recoveryRequest(row, 'order_query')
      );
      normalized = gmgnAdapter.normalizeOrder(response);
      normalized = await this.resolveProtectionStrategy(row, normalized);
      const terminalAudit = row.normalized_status === 'definitive_failed_no_fill';
      const persistedStatus = normalized.status === 'confirmed'
        ? 'chain_verifying'
        : ['failed', 'expired'].includes(normalized.status)
          ? terminalAudit ? 'definitive_failed_no_fill' : 'failure_verifying'
          : terminalAudit ? 'definitive_failed_no_fill' : normalized.status;
      await this.repository.updateOrderAfterQuery(
        row.id,
        { ...normalized, status: persistedStatus },
        nextQueryAt(row, persistedStatus, this.random)
      );
      if (['failed', 'expired'].includes(normalized.status)) {
        if (terminalAudit) {
          return { orderId: row.id, status: 'terminal_audit_no_change' };
        }
        const result = await this.failureEvidenceService.verifyFailedOrder({
          ...row,
          id: row.attempt_id,
          order_id: row.id,
          input_amount_raw: row.attempt_input_amount_raw || row.input_amount_raw,
          output_amount_raw: row.attempt_output_amount_raw || row.output_amount_raw,
          status: row.attempt_status
        }, normalized);
        return { orderId: row.id, status: result.status, intentId: result.intentId || row.intent_id };
      }
      if (normalized.status !== 'confirmed') {
        return { orderId: row.id, status: normalized.status };
      }
    }

    const receipt = await this.receiptService.verify(row.chain, normalized.txHash, {
      walletAddress: row.wallet_address,
      tradedToken: row.side === 'sell' ? row.input_token : row.output_token,
      expectedInputAmountRaw: normalized.report.inputAmountRaw || row.input_amount_raw,
      expectedOutputAmountRaw: normalized.report.outputAmountRaw || row.output_amount_raw,
      verifyNativeBalanceDelta: row.side === 'sell'
        && String(row.output_token) === String(requireChain(row.chain).nativeToken)
    });
    if (normalized.txHash) {
      await this.repository.saveChainReceipt(row.id, row.chain, normalized.txHash, receipt);
    }
    if (receipt.status === 'dropped' && row.chain !== 'sol') {
      const replacement = await this.recoverEvmReplacement(row, normalized, receipt);
      if (replacement) return replacement;
    }
    if (receipt.status === 'confirmed') {
      await this.repository.markReceiptAvailable?.(row.id);
      if (!receiptContainsTradedToken(row, receipt)
          || !receiptMatchesTradedAmount(row, normalized, receipt)
          || !receiptHasVerifiableNativeProceeds(row, receipt)) {
        const errorCode = !receiptHasVerifiableNativeProceeds(row, receipt)
          ? 'CHAIN_NATIVE_PROCEEDS_UNVERIFIED'
          : 'CHAIN_TOKEN_TRANSFER_AMOUNT_MISMATCH';
        if (row.attempt_status !== 'reconciliation_required') {
          await this.repository.transitionAttempt(
            row.attempt_id,
            ['submitted', 'confirming'],
            'reconciliation_required',
            {
              errorCode,
              requiresManualReview: true,
              alertTopic: errorCode === 'CHAIN_NATIVE_PROCEEDS_UNVERIFIED'
                ? 'trade.chain_native_proceeds_unverified'
                : 'trade.chain_transfer_mismatch'
            }
          );
        }
        return {
          orderId: row.id,
          status: errorCode === 'CHAIN_NATIVE_PROCEEDS_UNVERIFIED'
            ? 'native_proceeds_unverified'
            : 'transfer_mismatch'
        };
      }
      const settledOrder = orderWithReceiptTradedAmount(row, normalized, receipt);
      const position = await this.repository.finalizeConfirmedOrder(row.id, settledOrder, receipt);
      await this.repository.recordConfirmationTiming?.(row.id);
      return { orderId: row.id, status: 'confirmed', positionId: position.id };
    }
    if (['failed', 'reorged', 'replaced', 'dropped'].includes(receipt.status)) {
      await this.repository.transitionAttempt(
        row.attempt_id,
        ['submitted', 'confirming', 'reconciliation_required'],
        'reconciliation_required',
        {
          errorCode: `CHAIN_RECEIPT_${receipt.status.toUpperCase()}`,
          requiresManualReview: true,
          alertTopic: 'trade.chain_receipt_mismatch'
        }
      );
    }
    await this.db.query(
      `UPDATE trade_orders
       SET normalized_status = 'chain_verifying', next_query_at = $2,
           last_queried_at = NOW(), query_count = query_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [row.id, nextQueryAt(row, 'chain_verifying', this.random)]
    );
    return { orderId: row.id, status: `chain_${receipt.status}` };
  }

  wakeOrder(orderId) {
    const delays = [0];
    for (const delay of delays) {
      const timer = setTimeout(() => {
        this.hotTimers.delete(timer);
        void (async () => {
          const row = await this.repository.getOrderForReconciliation?.(orderId);
          if (!row || row.normalized_status === 'confirmed') return;
          const result = await this.reconcileOrder(row);
          this.hotProcessed += 1;
          this.wsBroadcast?.({ type: 'trade:order-updated', payload: result });
        })().catch((error) => {
          this.lastError = error.message;
          this.logger.error('trade-reconciler', `Hot order ${orderId} reconciliation failed: ${error.message}`);
        });
      }, delay);
      timer.unref?.();
      this.hotTimers.add(timer);
    }
  }

  async recoverEvmReplacement(row, previousOrder, previousReceipt) {
    if (!row.provider_order_id || !previousOrder.txHash) return null;
    const response = await this.gmgnAccess.queryOrder(
      row.provider_order_id,
      row.chain,
      recoveryRequest(row, 'replacement_order_query')
    );
    let refreshed = gmgnAdapter.normalizeOrder(response);
    refreshed = await this.resolveProtectionStrategy(row, refreshed);
    const oldHash = String(previousOrder.txHash).toLowerCase();
    const newHash = String(refreshed.txHash || '').toLowerCase();
    if (refreshed.status !== 'confirmed' || !newHash || newHash === oldHash) return null;

    await this.repository.saveChainReceipt(row.id, row.chain, previousOrder.txHash, {
      ...previousReceipt,
      status: 'replaced',
      raw: {
        ...(previousReceipt.raw || {}),
        replacement: {
          source: 'gmgn_order_report',
          replacement_tx_hash: refreshed.txHash
        }
      }
    });
    await this.repository.updateOrderAfterQuery(
      row.id,
      { ...refreshed, status: 'chain_verifying' },
      new Date()
    );
    return {
      orderId: row.id,
      status: 'chain_replaced',
      previousTxHash: previousOrder.txHash,
      replacementTxHash: refreshed.txHash
    };
  }

  async resolveProtectionStrategy(row, normalizedOrder) {
    const conditions = row.attempt_metadata?.condition_orders;
    if (normalizedOrder.status !== 'confirmed' || normalizedOrder.strategyOrderId
        || !Array.isArray(conditions) || conditions.length === 0) {
      return normalizedOrder;
    }
    const filters = {
      from_address: row.wallet_address,
      group_tag: 'STMix',
      base_token: row.output_token,
      limit: 100
    };
    const candidates = new Map();
    for (const type of ['open', 'history']) {
      const response = await this.gmgnAccess.getStrategyOrders(
        row.chain,
        { ...filters, type },
        recoveryRequest(row, 'strategy_association', {
          priority: PRIORITIES.STRATEGY_ACTION
        })
      );
      for (const item of strategyRows(response)) {
        const strategy = gmgnAdapter.normalizeStrategy(item);
        if (strategyMatchesConfirmedOrder(row, normalizedOrder, strategy)) {
          candidates.set(strategy.providerOrderId, strategy);
        }
      }
      if (candidates.size > 0) break;
    }
    const matches = [...candidates.values()];
    const association = matches.length === 1
      ? { status: 'matched', candidate_count: 1, order_id: matches[0].providerOrderId }
      : { status: matches.length === 0 ? 'missing' : 'ambiguous', candidate_count: matches.length };
    return {
      ...normalizedOrder,
      strategyOrderId: matches.length === 1 ? matches[0].providerOrderId : null,
      raw: {
        ...(normalizedOrder.raw || {}),
        ...(matches.length === 1 ? { strategy_order_id: matches[0].providerOrderId } : {}),
        xbot_strategy_association: association
      }
    };
  }

  async fetchStrategy(row) {
    if (!this.gmgnAccess.getStrategyOrders && this.gmgnAccess.queryStrategyOrder) {
      const raw = await this.gmgnAccess.queryStrategyOrder(
        row.chain_id,
        row.provider_order_id,
        row.wallet_address,
        {},
        recoveryRequest(row, 'strategy_query', {
          executionSessionId: `strategy:${Number(row.id)}:recovery`
        })
      );
      return strategyRows(raw)
        .map((item) => gmgnAdapter.normalizeStrategy(item))
        .find((item) => item.providerOrderId === String(row.provider_order_id)) || null;
    }
    const filters = {
      from_address: row.wallet_address,
      group_tag: 'STMix',
      base_token: row.contract_address,
      limit: 100
    };
    const requestOptions = {
      priority: ['triggered', 'cancelling', 'unknown'].includes(row.status)
        ? PRIORITIES.STRATEGY_ACTION
        : PRIORITIES.STABLE_RECONCILIATION
    };
    for (const type of ['open', 'history']) {
      const raw = await this.gmgnAccess.getStrategyOrders(
        row.chain_id,
        { ...filters, type },
        recoveryRequest(row, 'strategy_query', {
          ...requestOptions,
          executionSessionId: `strategy:${Number(row.id)}:recovery`
        })
      );
      const found = strategyRows(raw)
        .map((item) => gmgnAdapter.normalizeStrategy(item))
        .find((item) => item.providerOrderId === String(row.provider_order_id));
      if (found) return found;
    }
    return null;
  }

  async fetchStrategyBatch(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return new Map();
    if (!this.gmgnAccess.getStrategyOrders) {
      const error = new Error('GMGN strategy batch query is unavailable');
      error.code = 'GMGN_STRATEGY_BATCH_UNAVAILABLE';
      throw error;
    }
    const first = rows[0];
    const expected = new Set(rows.map((row) => String(row.provider_order_id)));
    const found = new Map();
    const filters = {
      from_address: first.wallet_address,
      group_tag: 'STMix',
      limit: 100
    };
    const urgent = rows.some((row) => ['triggered', 'cancelling', 'unknown'].includes(row.status));
    const batchIdentity = crypto.createHash('sha256')
      .update(strategyBatchKey(first)).digest('hex').slice(0, 16);
    for (const type of ['open', 'history']) {
      const raw = await this.gmgnAccess.getStrategyOrders(
        first.chain_id,
        { ...filters, type },
        recoveryRequest(null, 'strategy_batch_query', {
          priority: urgent ? PRIORITIES.STRATEGY_ACTION : PRIORITIES.STABLE_RECONCILIATION,
          executionSessionId: `strategy-batch:${batchIdentity}`,
          traceId: `strategy-batch:${batchIdentity}`,
          requestContext: {
            context: {
              category: 'protection_strategy_sync',
              query_type: type,
              strategy_group_ids: rows.map((row) => Number(row.id))
            }
          }
        })
      );
      for (const item of strategyRows(raw)) {
        const normalized = gmgnAdapter.normalizeStrategy(item);
        if (expected.has(String(normalized.providerOrderId))) {
          found.set(String(normalized.providerOrderId), normalized);
        }
      }
      if (found.size === expected.size) break;
    }
    return found;
  }

  async reconcileStrategy(row, options = {}) {
    const normalized = options.prefetched ? options.strategy : await this.fetchStrategy(row);
    if (!normalized) {
      const missing = {
        raw: { reason: 'not_found_in_open_or_history' },
        providerStatus: null,
        strategyStatus: null,
        status: 'unknown',
        closeAmountRaw: null,
        closeOutputAmountRaw: null,
        closeTxHash: null,
        closePrice: null,
        closeTime: null,
        conditionOrders: []
      };
      await this.repository.persistStrategySnapshot(
        row.id,
        missing,
        nextStrategyQueryAt('unknown', this.random)
      );
      return { strategyGroupId: row.id, status: 'unknown' };
    }
    await this.repository.persistStrategySnapshot(
      row.id,
      normalized,
      nextStrategyQueryAt(normalized.status, this.random)
    );
    if (normalized.status !== 'triggered') {
      return { strategyGroupId: row.id, status: normalized.status };
    }
    const claimed = await this.repository.claimStrategyClose(row.id, normalized);
    return {
      strategyGroupId: row.id,
      status: claimed.conflict ? 'manual_close_conflict' : 'chain_verifying',
      orderId: claimed.orderId || null,
      existing: Boolean(claimed.existing)
    };
  }

  async reconcilePositionBalance(row) {
    const state = await this.repository.getPositionBalanceState(row.id);
    if (!state || BigInt(state.remaining_amount_raw.split('.')[0]) === 0n) {
      return { positionId: row.id, status: 'no_open_lot' };
    }
    const balanceResponse = await this.gmgnAccess.getWalletTokenBalance(
      state.chain_id,
      state.wallet_address,
      state.contract_address,
      recoveryRequest({ ...row, ...state }, 'position_balance_recovery', {
        positionId: row.id,
        signalId: state.signal_id,
        traceId: state.trace_id,
        executionSessionId: `position:${Number(row.id)}:recovery`
      })
    );
    const normalizedBalance = gmgnAdapter.normalizeWalletTokenBalance(
      balanceResponse,
      state.token_decimals
    );
    if (Number(normalizedBalance.decimals) !== Number(state.token_decimals)) {
      const error = new Error('Wallet balance decimals differ from the verified position lot');
      error.code = 'POSITION_BALANCE_DECIMALS_MISMATCH';
      throw error;
    }
    const actualRaw = normalizedBalance.amountRaw
      || decimalToRaw(normalizedBalance.amountDisplay, state.token_decimals);
    const observation = await this.repository.observePositionBalance(row.id, actualRaw);
    if (BigInt(observation.deficitRaw) === 0n) {
      return {
        positionId: row.id,
        status: BigInt(observation.externalRaw) > 0n ? 'external_balance_present' : 'matched'
      };
    }
    if (Number(state.active_strategy_count) > 0) {
      await this.repository.markPositionBalanceMismatch(row.id, {
        reason: 'ACTIVE_STRATEGY_BALANCE_DEFICIT',
        deficit_raw: observation.deficitRaw,
        active_strategy_count: Number(state.active_strategy_count)
      });
      return { positionId: row.id, status: 'active_strategy_conflict' };
    }

    const activityResponse = await this.gmgnAccess.getWalletActivity(
      state.chain_id,
      state.wallet_address,
      { token_address: state.contract_address, limit: 100 },
      recoveryRequest({ ...row, ...state }, 'position_activity_recovery', {
        positionId: row.id,
        signalId: state.signal_id,
        traceId: state.trace_id,
        executionSessionId: `position:${Number(row.id)}:recovery`
      })
    );
    const candidates = (activityResponse.activities || []).filter((activity) => {
      if (String(activity.event_type || '').toLowerCase() !== 'sell') return false;
      if (String(activity.token?.address || '').toLowerCase()
          !== String(state.contract_address).toLowerCase()) return false;
      if (Number(activity.timestamp || 0) * 1000 < new Date(state.opened_at).getTime()) return false;
      try {
        return decimalToRaw(activity.token_amount, state.token_decimals) === observation.deficitRaw;
      } catch {
        return false;
      }
    });
    if (candidates.length !== 1) {
      await this.repository.markPositionBalanceMismatch(row.id, {
        reason: 'EXTERNAL_SELL_NOT_UNIQUE',
        deficit_raw: observation.deficitRaw,
        candidate_count: candidates.length
      });
      return { positionId: row.id, status: 'manual_reconciliation_required' };
    }
    const activity = candidates[0];
    const outputDecimals = Number(activity.quote_token?.decimals);
    if (!Number.isInteger(outputDecimals)) {
      const error = new Error('Wallet activity lacks quote token decimals');
      error.code = 'GMGN_SCHEMA_INVALID';
      throw error;
    }
    const claimed = await this.repository.claimExternalClose(row.id, {
      txHash: String(activity.tx_hash),
      inputAmountRaw: observation.deficitRaw,
      outputAmountRaw: decimalToRaw(activity.quote_amount, outputDecimals),
      outputDecimals,
      priceUsd: Number(activity.price_usd || 0) || null,
      gasNative: Number(activity.gas_native || 0) || null,
      submittedAt: new Date(Number(activity.timestamp) * 1000),
      raw: activity
    });
    return {
      positionId: row.id,
      status: 'chain_verifying',
      orderId: claimed.orderId,
      existing: Boolean(claimed.existing)
    };
  }

  async reconcileCancelledCloseAttempt(attempt) {
    if (attempt.side !== 'sell') return null;
    const details = await this.repository.getAttemptDetails(attempt.id);
    if (!details || details.orders.length > 0) return null;
    const deterministicPreSubmitCodes = new Set([
      'GMGN_RATE_RESERVATION_INVALID',
      'GMGN_RATE_DEADLINE_EXPIRED',
      'GMGN_RATE_LIMIT_COOLDOWN',
      'GMGN_RATE_WEIGHT_INVALID'
    ]);
    const preSubmitEvent = details.events.find((event) => (
      String(event.reason || '').toLowerCase().includes('gmgn rate reservation')
        || String(event.reason || '').toLowerCase().includes('gmgn rate queue')
    ));
    const preSubmitReason = deterministicPreSubmitCodes.has(attempt.error_code)
      ? attempt.error_code
      : preSubmitEvent ? 'GMGN_RATE_RESERVATION_INVALID' : null;
    if (preSubmitReason && typeof this.repository.recoverDeterministicPreSubmitSellAttempt === 'function') {
      const recovered = await this.repository.recoverDeterministicPreSubmitSellAttempt(
        attempt.id,
        attempt.position_id,
        preSubmitReason
      );
      if (recovered) return { ...recovered, status: 'pre_submit_failure_recovered' };
    }
    const cancellationUncertainty = [
      'STRATEGY_CANCEL_UNCERTAIN',
      'STRATEGY_CANCEL_UNVERIFIED'
    ].includes(attempt.error_code) || details.events.some((event) => (
      event.to_status === 'submission_uncertain'
        && String(event.reason || '').toLowerCase().includes('strategy cancellation')
    ));
    if (!cancellationUncertainty) return null;
    const groups = details.strategy_groups.filter((group) => group.provider_order_id);
    const lots = details.position_lots.filter((lot) => BigInt(String(lot.remaining_amount_raw || '0')) > 0n);
    if (groups.length === 0 || lots.length === 0) return null;
    const tokenDecimals = Number(lots[0].token_decimals);
    const walletAddress = String(lots[0].wallet_address || '');
    if (!Number.isInteger(tokenDecimals)
        || !walletAddress
        || !lots.every((lot) => Number(lot.token_decimals) === tokenDecimals
          && String(lot.wallet_address) === walletAddress)) return null;

    const strategyEvidence = [];
    for (const group of groups) {
      const response = await this.gmgnAccess.queryStrategyOrder(
        attempt.chain,
        group.provider_order_id,
        walletAddress,
        { baseToken: attempt.input_token },
        recoveryRequest(attempt, 'cancelled_close_strategy_recovery', {
          attemptId: attempt.id,
          positionId: attempt.position_id,
          executionSessionId: `attempt:${Number(attempt.id)}:recovery`
        })
      );
      const normalized = strategyRows(response)
        .map((item) => gmgnAdapter.normalizeStrategy(item))
        .find((item) => item.providerOrderId === String(group.provider_order_id));
      if (!normalized || normalized.status !== 'cancelled' || normalized.closeTxHash) return null;
      strategyEvidence.push({ groupId: group.id, normalized });
    }

    const balanceResponse = await this.gmgnAccess.getWalletTokenBalance(
      attempt.chain,
      walletAddress,
      attempt.input_token,
      recoveryRequest(attempt, 'cancelled_close_balance_recovery', {
        attemptId: attempt.id,
        positionId: attempt.position_id,
        executionSessionId: `attempt:${Number(attempt.id)}:recovery`
      })
    );
    const balance = gmgnAdapter.normalizeWalletTokenBalance(balanceResponse, tokenDecimals);
    if (Number(balance.decimals) !== tokenDecimals) return null;
    const walletRaw = balance.amountRaw || decimalToRaw(balance.amountDisplay, tokenDecimals);
    const remainingRaw = lots.reduce(
      (total, lot) => total + BigInt(String(lot.remaining_amount_raw)),
      0n
    );
    if (BigInt(walletRaw) < remainingRaw) return null;

    const recovered = await this.repository.resolveCancelledCloseAttempt(
      attempt.id,
      attempt.position_id,
      strategyEvidence
    );
    return { ...recovered, status: 'cancelled_before_swap_recovered' };
  }

  async runOnce() {
    if (this.running) return { status: 'skipped', reason: 'already_running' };
    this.running = true;
    this.lastRunAt = new Date();
    this.lastError = null;
    let lockClient = null;
    try {
      if (this.db.pool?.connect) {
        lockClient = await this.db.pool.connect();
        const lock = await lockClient.query(
          'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
          [RECONCILER_LOCK]
        );
        if (!lock.rows[0].locked) return { status: 'skipped', reason: 'another_instance_is_active' };
      }
      const orders = await this.repository.listDueOrders(20);
      const results = [];
      for (const order of orders) {
        try {
          const result = await this.reconcileOrder(order);
          results.push(result);
          this.processed += 1;
          this.wsBroadcast?.({ type: 'trade:order-updated', payload: result });
        } catch (error) {
          this.lastError = error.message;
          this.logger.error('trade-reconciler', `Order ${order.id} reconciliation failed: ${error.message}`);
          results.push({ orderId: order.id, status: 'error', error: error.code || error.message });
        }
      }
      const strategies = await this.repository.listDueStrategyGroups(20);
      const strategyGroups = groupStrategyRows(strategies);
      const strategyBudget = strategyBatchGroupBudget();
      const selectedStrategyGroups = strategyGroups.slice(0, strategyBudget);
      this.strategyDeferredGroups = Math.max(0, strategyGroups.length - selectedStrategyGroups.length);
      if (this.strategyDeferredGroups > 0
          && Date.now() - this.lastStrategyBacklogWarnAt >= 60_000) {
        this.lastStrategyBacklogWarnAt = Date.now();
        this.logger.warn(
          'trade-reconciler',
          `${this.strategyDeferredGroups} strategy wallet groups deferred by the per-cycle GMGN budget`
        );
      }
      for (const strategyGroup of selectedStrategyGroups) {
        let prefetched;
        try {
          prefetched = await this.fetchStrategyBatch(strategyGroup);
        } catch (error) {
          this.lastError = error.message;
          const retryAt = strategyFailureRetryAt(strategyGroup, error, this.random);
          try {
            await this.repository.deferStrategyGroups(
              strategyGroup.map((strategy) => strategy.id),
              retryAt
            );
          } catch (deferError) {
            this.logger.error(
              'trade-reconciler',
              `Strategy batch ${strategyBatchKey(strategyGroup[0])} retry deferral failed: ${deferError.message}`
            );
          }
          this.logger.error(
            'trade-reconciler',
            `Strategy batch ${strategyBatchKey(strategyGroup[0])} failed: ${error.message}; retry after ${retryAt.toISOString()}`
          );
          for (const strategy of strategyGroup) {
            results.push({
              strategyGroupId: strategy.id,
              status: 'error',
              error: error.code || error.message,
              retryAt
            });
          }
          continue;
        }
        for (const strategy of strategyGroup) {
          try {
            const result = await this.reconcileStrategy(strategy, {
              prefetched: true,
              strategy: prefetched.get(String(strategy.provider_order_id)) || null
            });
            results.push(result);
            this.processed += 1;
            this.wsBroadcast?.({ type: 'trade:strategy-updated', payload: result });
          } catch (error) {
            this.lastError = error.message;
            this.logger.error(
              'trade-reconciler',
              `Strategy ${strategy.id} reconciliation failed: ${error.message}`
            );
            results.push({ strategyGroupId: strategy.id, status: 'error', error: error.code || error.message });
          }
        }
      }
      // Position balance checks are explicit recovery work. Running them for
      // every open position creates a background GMGN stream unrelated to an
      // active order or exit event.
      const balanceChecks = [];
      const uncertainAttempts = await this.repository.listUncertainAttempts(10);
      for (const attempt of uncertainAttempts) {
        try {
          const recovered = await this.reconcileCancelledCloseAttempt(attempt);
          if (recovered) {
            results.push(recovered);
            this.processed += 1;
            this.wsBroadcast?.({ type: 'trade:attempt-recovered', payload: recovered });
            continue;
          }
          await this.repository.touchAttemptReconciliation(attempt.id);
          if (Date.now() - new Date(attempt.created_at).getTime() >= 120_000) {
            await this.repository.transitionAttempt(
              attempt.id,
              ['submission_uncertain'],
              'reconciliation_required',
              {
                errorCode: 'SUBMISSION_COULD_NOT_BE_UNIQUELY_RECONCILED',
                requiresManualReview: true,
                alertTopic: 'trade.manual_reconciliation_required'
              }
            );
          }
        } catch (error) {
          await this.repository.touchAttemptReconciliation(attempt.id);
          this.logger.warn('trade-reconciler', `Uncertain attempt ${attempt.id} lookup failed: ${error.message}`);
        }
      }
      const uncertain = await this.db.query(
        `SELECT COUNT(*)::int AS count, MIN(created_at) AS oldest
         FROM trade_attempts WHERE status = 'submission_uncertain'`
      );
      this.lastSuccessAt = new Date();
      await this.db.query(
        `INSERT INTO trade_runtime_state(key, value_json)
         VALUES ('reconciler', $1)
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
        [{
          heartbeat_at: this.lastSuccessAt,
          processed: this.processed,
          due_orders: orders.length,
          due_strategies: strategies.length,
          due_balance_checks: balanceChecks.length,
          uncertain_count: uncertain.rows[0].count,
          oldest_uncertain_at: uncertain.rows[0].oldest
        }]
      );
      return {
        status: 'completed',
        processed: results.length,
        dueOrders: orders.length,
        dueStrategies: strategies.length,
        dueBalanceChecks: balanceChecks.length,
        results
      };
    } finally {
      if (lockClient) {
        await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [RECONCILER_LOCK]).catch(() => {});
        lockClient.release();
      }
      this.running = false;
    }
  }

  start(options = {}) {
    if (this.timer) return;
    this.wsBroadcast = options.wsBroadcast || this.wsBroadcast;
    this.startedAt = new Date();
    const intervalMs = Math.max(500, Number(options.intervalMs || 1000));
    void this.runOnce().catch((error) => {
      this.lastError = error.message;
      this.logger.error('trade-reconciler', `Startup reconciliation failed: ${error.message}`);
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.lastError = error.message;
        this.logger.error('trade-reconciler', `Reconciliation failed: ${error.message}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.hotTimers) clearTimeout(timer);
    this.hotTimers.clear();
  }

  async getStatus() {
    const [backlog, strategyBacklog] = await Promise.all([
      this.db.query(
      `SELECT normalized_status AS status, COUNT(*)::int AS count,
              MIN(submitted_at) AS oldest
       FROM trade_orders
       WHERE normalized_status IN ('submitted','pending','chain_verifying','failure_verifying',
                                    'definitive_failed_no_fill','unknown')
       GROUP BY normalized_status`
      ),
      this.db.query(
        `SELECT status, COUNT(*)::int AS count, MIN(next_query_at) AS oldest
         FROM strategy_groups
         WHERE status IN ('pending','running','partially_filled','triggered','cancelling','unknown')
         GROUP BY status`
      )
    ]);
    return {
      running: Boolean(this.timer),
      active: this.running,
      startedAt: this.startedAt,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      processed: this.processed,
      hotProcessed: this.hotProcessed,
      strategyDeferredGroups: this.strategyDeferredGroups,
      backlog: backlog.rows,
      strategyBacklog: strategyBacklog.rows,
      pollingPolicy: [
        { fromSeconds: 0, toSeconds: 10, intervalMs: 1000 },
        { fromSeconds: 10, toSeconds: 30, intervalMs: 2000 },
        { fromSeconds: 30, toSeconds: 120, intervalMs: 5000 },
        { fromSeconds: 120, toSeconds: null, intervalMs: [15000, 30000] }
      ]
    };
  }
}

const reconciler = new TradeReconciler();

module.exports = {
  DEFAULT_STRATEGY_BATCH_GROUP_BUDGET,
  RECONCILER_LOCK,
  TradeReconciler,
  groupStrategyRows,
  nextQueryAt,
  nextStrategyQueryAt,
  pollingIntervalMs,
  receiptContainsTradedToken,
  receiptHasVerifiableNativeProceeds,
  receiptMatchesTradedAmount,
  receiptTradedAmountRaw,
  orderWithReceiptTradedAmount,
  strategyPollingIntervalMs,
  strategyFailureRetryAt,
  strategyBatchGroupBudget,
  strategyBatchKey,
  strategyMatchesConfirmedOrder,
  reconciler
};
