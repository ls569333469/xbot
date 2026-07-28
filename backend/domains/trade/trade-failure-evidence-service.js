const crypto = require('crypto');
const db = require('../../lib/db');
const gmgnHttp = require('../../lib/gmgn-http');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const { rawToDecimal } = require('../../lib/decimal-units');
const receiptService = require('./chain-receipt-service');
const repository = require('./trade-repository');
const intentRepository = require('./trade-intent-repository');
const { walletWriteLane } = require('./wallet-write-lane');

function evidenceHash(attemptId, snapshotVersion, type, evidence) {
  return crypto.createHash('sha256').update(JSON.stringify({
    attemptId, snapshotVersion, type, evidence
  })).digest('hex');
}

function activityRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.activities)) return value.activities;
  if (Array.isArray(value?.list)) return value.list;
  return [];
}

function tokenBalanceRaw(response, decimals) {
  const normalized = gmgnAdapter.normalizeWalletTokenBalance(response, decimals);
  return {
    amountRaw: normalized.amountRaw,
    amountDisplay: normalized.amountDisplay,
    decimals: normalized.decimals
  };
}

function solTokenDeltaRaw(receipt, walletAddress, tokenAddress) {
  const totals = (balances) => (balances || []).reduce((total, balance) => {
    if (String(balance.mint || '') !== String(tokenAddress || '')) return total;
    if (String(balance.owner || '') !== String(walletAddress || '')) return total;
    const raw = balance.uiTokenAmount?.amount ?? balance.amount;
    return /^\d+$/.test(String(raw || '')) ? total + BigInt(raw) : total;
  }, 0n);
  const before = totals(receipt?.transfers?.preTokenBalances);
  const after = totals(receipt?.transfers?.postTokenBalances);
  return (after - before).toString();
}

function evmHasTokenTransfer(receipt, walletAddress, tokenAddress) {
  const wallet = String(walletAddress || '').toLowerCase();
  const token = String(tokenAddress || '').toLowerCase();
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  return (receipt?.transfers || []).some((log) => {
    if (String(log.address || '').toLowerCase() !== token) return false;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (String(topics[0] || '').toLowerCase() !== transferTopic) return false;
    const from = `0x${String(topics[1] || '').slice(-40)}`.toLowerCase();
    const to = `0x${String(topics[2] || '').slice(-40)}`.toLowerCase();
    return from === wallet || to === wallet;
  });
}

function receiptProvesNoFill(attempt, receipt) {
  const token = attempt.side === 'sell' ? attempt.input_token : attempt.output_token;
  if (attempt.chain === 'sol') {
    return solTokenDeltaRaw(receipt, attempt.wallet_address, token) === '0';
  }
  return !evmHasTokenTransfer(receipt, attempt.wallet_address, token);
}

function actualFeeNative(chain, receipt) {
  if (chain === 'sol') {
    const fee = receipt?.raw?.meta?.fee;
    return Number.isSafeInteger(fee) ? Number(rawToDecimal(String(fee), 9, 9)) : null;
  }
  const rawReceipt = receipt?.raw?.receipt || {};
  const gasUsed = rawReceipt.gasUsed;
  const gasPrice = rawReceipt.effectiveGasPrice;
  try {
    if (gasUsed !== undefined && gasPrice !== undefined) {
      return Number(rawToDecimal((BigInt(gasUsed) * BigInt(gasPrice)).toString(), 18, 18));
    }
  } catch {
    return null;
  }
  return null;
}

class TradeFailureEvidenceService {
  constructor(options = {}) {
    this.db = options.db || db;
    this.gmgnHttp = options.gmgnHttp || gmgnHttp;
    this.receiptService = options.receiptService || receiptService;
    this.repository = options.repository || repository;
    this.intentRepository = options.intentRepository || intentRepository;
    this.walletLane = options.walletLane || walletWriteLane;
    this.stateProvider = options.stateProvider || {
      capture: receiptService.captureWalletState,
      scan: receiptService.scanWalletSinceSnapshot
    };
  }

  async append(attempt, type, status, evidence) {
    const hash = evidenceHash(attempt.id, attempt.snapshot_version || 1, type, evidence);
    const result = await this.db.query(
      `INSERT INTO trade_failure_evidence(
         attempt_id, snapshot_version, evidence_type, status,
         evidence_json, evidence_hash
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (evidence_hash) DO NOTHING RETURNING *`,
      [attempt.id, attempt.snapshot_version || 1, type, status, evidence, hash]
    );
    return result.rows[0] || null;
  }

  async capturePreSubmitSnapshot(attempt, context = {}) {
    const tokenAddress = attempt.side === 'sell' ? attempt.input_token : attempt.output_token;
    const tokenDecimals = Number(context.tokenDecimals ?? context.token?.decimals);
    const [chainState, tokenBalance, activity] = await Promise.all([
      this.stateProvider.capture(attempt.chain, attempt.wallet_address),
      this.gmgnHttp.getWalletTokenBalance(
        attempt.chain,
        attempt.wallet_address,
        tokenAddress,
        context.rateLease ? { rateLease: context.rateLease, deadlineAt: context.deadlineAt } : {}
      ),
      this.gmgnHttp.getWalletActivity(attempt.chain, attempt.wallet_address, {
        token_address: tokenAddress,
        limit: 20
      }, context.rateLease ? { rateLease: context.rateLease, deadlineAt: context.deadlineAt } : {})
    ]);
    const activities = activityRows(activity);
    return {
      captured_at: new Date().toISOString(),
      chain_state: chainState,
      token: {
        address: tokenAddress,
        ...tokenBalanceRaw(tokenBalance, tokenDecimals)
      },
      activity_cursor: activities.slice(0, 20).map((item) => ({
        tx_hash: item.tx_hash || item.hash || null,
        timestamp: item.timestamp || item.time || null,
        event_type: item.event_type || item.type || null
      })),
      quote: context.quote?.raw || context.quote || {},
      gas: context.gas || {},
      native_usd_price: Number.isFinite(Number(context.nativeUsd))
        ? Number(context.nativeUsd)
        : Number.isFinite(Number(context.gas?.native_token_usd_price))
          ? Number(context.gas.native_token_usd_price)
          : null,
      config: context.config || {}
    };
  }

  async beginVerification(attempt, normalizedOrder) {
    await this.db.query(
      `UPDATE trade_attempts
       SET status = 'failure_verifying', failure_evidence_started_at = COALESCE(failure_evidence_started_at, NOW()),
           error_code = $2, last_reconciled_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status IN('submitted','confirming','reconciliation_required','failure_verifying')`,
      [attempt.id, normalizedOrder.errorCode || `GMGN_ORDER_${String(normalizedOrder.status).toUpperCase()}`]
    );
    await this.db.query(
      `UPDATE trade_orders SET normalized_status = 'failure_verifying', updated_at = NOW()
       WHERE attempt_id = $1`,
      [attempt.id]
    );
    await this.append(attempt, 'provider_terminal', 'observed', {
      provider_status: normalizedOrder.providerStatus,
      normalized_status: normalizedOrder.status,
      tx_hash: normalizedOrder.txHash || null,
      query_count: attempt.query_count || 0
    });
  }

  async uncertain(attempt, reasonCode, evidence) {
    await this.append(attempt, 'uncertainty', 'conflict', { reason_code: reasonCode, ...evidence });
    await this.intentRepository.markUncertain(attempt, reasonCode, evidence, this.db);
    await this.walletLane.quarantine(attempt, reasonCode, evidence);
    return { status: 'uncertain', reasonCode };
  }

  async verifyWithHash(attempt, normalizedOrder) {
    const receipt = await this.receiptService.verify(attempt.chain, normalizedOrder.txHash, {
      walletAddress: attempt.wallet_address,
      tradedToken: attempt.side === 'sell' ? attempt.input_token : attempt.output_token,
      expectedInputAmountRaw: normalizedOrder.report?.inputAmountRaw || attempt.input_amount_raw,
      expectedOutputAmountRaw: normalizedOrder.report?.outputAmountRaw || attempt.output_amount_raw
    });
    await this.repository.saveChainReceipt(attempt.order_id, attempt.chain, normalizedOrder.txHash, receipt);
    const noFill = receiptProvesNoFill(attempt, receipt);
    await this.append(attempt, 'chain_receipt_failure', receipt.status === 'failed' && noFill ? 'passed' : 'conflict', {
      tx_hash: normalizedOrder.txHash,
      receipt_status: receipt.status,
      confirmations: receipt.confirmations,
      no_token_fill: noFill,
      block_ref: receipt.blockRef
    });
    if (receipt.status !== 'failed' || !noFill) {
      return this.uncertain(attempt, 'FAILED_ORDER_CHAIN_EVIDENCE_CONFLICT', {
        tx_hash: normalizedOrder.txHash,
        receipt_status: receipt.status,
        no_token_fill: noFill
      });
    }
    const fee = actualFeeNative(attempt.chain, receipt);
    return this.intentRepository.scheduleAfterDefinitiveFailure(attempt.id, {
      failureClass: 'CHAIN_RECEIPT_FAILED_NO_FILL',
      errorCode: normalizedOrder.errorCode || 'CHAIN_DEFINITIVE_FAILED_NO_FILL',
      actualFeeNative: fee,
      actualFeeUsd: Number.isFinite(Number(normalizedOrder.report?.gasUsd))
        ? Number(normalizedOrder.report.gasUsd)
        : Number.isFinite(Number(attempt.pre_submit_snapshot_json?.native_usd_price)) && fee !== null
          ? fee * Number(attempt.pre_submit_snapshot_json.native_usd_price)
          : null,
      evidence: {
        kind: 'tx_hash_receipt',
        tx_hash: normalizedOrder.txHash,
        receipt_status: receipt.status,
        no_token_fill: true,
        actual_fee_native: fee
      }
    });
  }

  async verifyWithoutHash(attempt, normalizedOrder) {
    const lane = await this.walletLane.quarantine(
      attempt,
      'NO_HASH_FAILURE_EVIDENCE_PENDING',
      { provider_order_id: normalizedOrder.providerOrderId || null }
    );
    if (lane?.owner_attempt_id
        && Number(lane.owner_attempt_id) !== Number(attempt.id)) {
      return this.uncertain(attempt, 'WALLET_ALREADY_QUARANTINED', {
        conflicting_attempt_id: lane.owner_attempt_id
      });
    }
    const window = await this.db.query(
      `SELECT NOW() >= failure_evidence_started_at
          + ($2::double precision * interval '1 millisecond') AS elapsed
       FROM trade_attempts WHERE id = $1`,
      [attempt.id, Number(attempt.config_snapshot_json?.chain_config?.failureEvidenceWindowMs || 30000)]
    );
    if (!window.rows[0]?.elapsed) return { status: 'failure_verifying' };
    const before = attempt.pre_submit_snapshot_json;
    if (!before || Object.keys(before).length === 0) {
      return this.uncertain(attempt, 'PRE_SUBMIT_SNAPSHOT_MISSING', {});
    }
    let after;
    let addressHistory;
    try {
      const tokenAddress = attempt.side === 'sell' ? attempt.input_token : attempt.output_token;
      const tokenDecimals = Number(before.token?.decimals);
      const [chainState, balance, activity] = await Promise.all([
        this.stateProvider.capture(attempt.chain, attempt.wallet_address),
        this.gmgnHttp.getWalletTokenBalance(attempt.chain, attempt.wallet_address, tokenAddress),
        this.gmgnHttp.getWalletActivity(attempt.chain, attempt.wallet_address, {
          token_address: tokenAddress,
          limit: 100
        })
      ]);
      addressHistory = await this.stateProvider.scan(
        attempt.chain,
        attempt.wallet_address,
        before.chain_state
      );
      after = {
        chain_state: chainState,
        token: tokenBalanceRaw(balance, tokenDecimals),
        activities: activityRows(activity)
      };
    } catch (error) {
      return this.uncertain(attempt, 'NO_HASH_EVIDENCE_UNAVAILABLE', {
        error: error.code || error.message
      });
    }
    const providerObservations = await this.db.query(
      `SELECT COUNT(*)::int AS count FROM trade_failure_evidence
       WHERE attempt_id = $1 AND evidence_type = 'provider_terminal'`,
      [attempt.id]
    );
    const nonceStable = before.chain_state?.kind !== 'evm'
      || (Number(before.chain_state.latestNonce) === Number(after.chain_state.latestNonce)
        && Number(before.chain_state.pendingNonce) === Number(after.chain_state.pendingNonce));
    const tokenStable = String(before.token?.amountRaw) === String(after.token?.amountRaw);
    const nativeStable = String(before.chain_state?.nativeBalanceRaw)
      === String(after.chain_state?.nativeBalanceRaw);
    const knownActivityHashes = new Set((before.activity_cursor || []).map((item) => item.tx_hash).filter(Boolean));
    const newActivities = after.activities.filter((item) => {
      const hash = item.tx_hash || item.hash;
      return hash && !knownActivityHashes.has(hash);
    });
    const evidence = {
      provider_observations: Number(providerObservations.rows[0].count),
      nonce_stable: nonceStable,
      token_balance_stable: tokenStable,
      native_balance_stable: nativeStable,
      address_history_available: Boolean(addressHistory?.available),
      address_history_transactions: addressHistory?.transactions || [],
      new_wallet_activities: newActivities.length
    };
    await this.append(attempt, 'no_hash_observation_window', 'observed', evidence);
    const complete = evidence.provider_observations >= 2
      && nonceStable && tokenStable && nativeStable
      && addressHistory?.available
      && addressHistory.transactions.length === 0
      && newActivities.length === 0;
    if (!complete) return this.uncertain(attempt, 'NO_HASH_FAILURE_NOT_PROVEN', evidence);
    return this.intentRepository.scheduleAfterDefinitiveFailure(attempt.id, {
      failureClass: 'NO_HASH_PROVEN_NO_FILL',
      errorCode: normalizedOrder.errorCode || 'NO_HASH_DEFINITIVE_FAILED_NO_FILL',
      evidence: { kind: 'no_hash_observation_window', ...evidence }
    });
  }

  async verifyFailedOrder(attempt, normalizedOrder) {
    await this.beginVerification(attempt, normalizedOrder);
    return normalizedOrder.txHash
      ? this.verifyWithHash(attempt, normalizedOrder)
      : this.verifyWithoutHash(attempt, normalizedOrder);
  }
}

const tradeFailureEvidenceService = new TradeFailureEvidenceService();

module.exports = {
  TradeFailureEvidenceService,
  actualFeeNative,
  evidenceHash,
  receiptProvesNoFill,
  tradeFailureEvidenceService
};
