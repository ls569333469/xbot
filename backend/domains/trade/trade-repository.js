const crypto = require('crypto');
const db = require('../../lib/db');
const { decimalToRaw, rawToDecimal } = require('../../lib/decimal-units');
const { requireChain } = require('./chain-adapters');

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function strategyLegAmountRaw(totalAmountRaw, condition = {}) {
  const total = BigInt(String(totalAmountRaw || '0'));
  const ratioValue = String(condition.sell_ratio ?? '100');
  if (!/^\d+(?:\.\d+)?$/.test(ratioValue)) return total.toString();
  const [whole, fraction = ''] = ratioValue.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const ratio = BigInt(`${whole}${fraction}`);
  return (total * ratio / (100n * scale)).toString();
}

function principalUsdCost(inputDisplay, reservation = {}) {
  const input = Number(inputDisplay);
  const principal = Number(reservation.amount_native);
  const fee = Number(reservation.fee_native || 0);
  const totalUsd = Number(reservation.amount_usd_snapshot);
  const reservedTotal = principal + fee;
  if (![input, principal, fee, totalUsd, reservedTotal].every(Number.isFinite)
      || input < 0 || principal <= 0 || fee < 0 || totalUsd <= 0 || reservedTotal <= 0) {
    return null;
  }
  return input * totalUsd / reservedTotal;
}

async function getSignalForExecution(signalId, executor = db) {
  const result = await executor.query(
    `SELECT signal.id AS signal_id,
            signal.status AS signal_status,
            signal.execution_mode AS signal_execution_mode,
            signal.created_at AS signal_created_at,
            signal.activity_id,
            signal.whitelist_id,
            signal.signal_type,
            signal.kol_handle,
            signal.matched_relation_ids,
            activity.provider,
            activity.activity_type,
            whitelist.symbol,
            whitelist.project_name,
            whitelist.contract_address,
            whitelist.chain_id,
            whitelist.budget_per_trade,
            whitelist.total_budget,
            whitelist.spent_budget,
            whitelist.slippage,
            whitelist.auto_tp_pct,
            whitelist.auto_sl_pct,
            whitelist.current_buy_count,
            whitelist.status AS whitelist_status
     FROM trade_signals AS signal
     JOIN ca_whitelist AS whitelist ON whitelist.id = signal.whitelist_id
     LEFT JOIN x_activities AS activity ON activity.id = signal.activity_id
     WHERE signal.id = $1`,
    [signalId]
  );
  return result.rows[0] || null;
}

async function addAttemptEvent(executor, attemptId, fromStatus, toStatus, details = {}) {
  await executor.query(
    `INSERT INTO trade_attempt_events
      (attempt_id, from_status, to_status, reason, actor, provider_request_id,
       http_status, latency_ms, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      attemptId,
      fromStatus,
      toStatus,
      details.reason || null,
      details.actor || 'system',
      details.providerRequestId || null,
      details.httpStatus || null,
      details.latencyMs || null,
      details.summary || {}
    ]
  );
}

async function writeOutbox(executor, topic, aggregateType, aggregateId, payload) {
  await executor.query(
    `INSERT INTO notification_outbox(topic, aggregate_type, aggregate_id, payload)
     VALUES ($1,$2,$3,$4)`,
    [topic, aggregateType, String(aggregateId), payload]
  );
}

async function createBuyAttempt(prepared) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('xbot:budget:global'))");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`xbot:budget:${prepared.chain.id}`]);
    const signal = await getSignalForExecution(prepared.signal.signal_id, client);
    if (!signal || signal.whitelist_status !== 'active') {
      const error = new Error('Signal or active whitelist not found');
      error.code = 'WHITELIST_NOT_ACTIVE';
      throw error;
    }
    const lockedWhitelist = await client.query(
      'SELECT * FROM ca_whitelist WHERE id = $1 FOR UPDATE',
      [signal.whitelist_id]
    );
    const whitelist = lockedWhitelist.rows[0];
    if (String(process.env.EMERGENCY_STOP || 'false').toLowerCase() === 'true') {
      const error = new Error('Emergency stop is active');
      error.code = 'EMERGENCY_STOP_ACTIVE';
      throw error;
    }
    const activeBuyAttempts = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM trade_attempts
       WHERE whitelist_id = $1 AND side = 'buy'
         AND status IN ('reserved','preparing','submitting','submitted','confirming',
                        'submission_uncertain','reconciliation_required')`,
      [signal.whitelist_id]
    );
    const completedBuys = Number(whitelist.current_buy_count || 0);
    const pendingBuys = Number(activeBuyAttempts.rows[0].count || 0);
    const maximumBuys = whitelist.allow_repeat_buy
      ? Math.max(1, Number(whitelist.max_repeat_buys || 1))
      : 1;
    if (completedBuys + pendingBuys >= maximumBuys) {
      const error = new Error('Whitelist CA buy limit reached');
      error.code = 'CA_BUY_LIMIT_REACHED';
      throw error;
    }
    const chainConfigResult = await client.query(
      "SELECT value_json FROM config WHERE key = 'chain_configs' FOR SHARE"
    );
    const chainConfig = chainConfigResult.rows[0]?.value_json?.[prepared.chain.id];
    if (!chainConfig?.enabled) {
      const error = new Error('Chain budget configuration is disabled');
      error.code = 'CHAIN_BUDGET_DISABLED';
      throw error;
    }
    const idempotencyKey = `signal:${signal.signal_id}:buy`;
    const existing = await client.query(
      'SELECT * FROM trade_attempts WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    if (existing.rows.length > 0) {
      const error = new Error(`Signal already has buy attempt #${existing.rows[0].id}`);
      error.code = 'TRADE_ATTEMPT_EXISTS';
      error.attempt = existing.rows[0];
      throw error;
    }

    const activeReservations = await client.query(
      `SELECT COALESCE(SUM(amount_native), 0) AS principal_total
       FROM budget_reservations
       WHERE whitelist_id = $1 AND status = 'reserved'`,
      [signal.whitelist_id]
    );
    const principal = Number(prepared.budgetNative);
    const planned = principal + Number(prepared.feeReserveNative || 0);
    const plannedUsd = Number(prepared.budgetUsdSnapshot);
    const committed = Number(whitelist.spent_budget || 0);
    const reservedPrincipal = Number(activeReservations.rows[0].principal_total || 0);
    if (!Number.isFinite(principal) || principal <= 0
        || committed + reservedPrincipal + principal > Number(whitelist.total_budget)) {
      const error = new Error('Whitelist lifetime budget exceeded');
      error.code = 'WHITELIST_BUDGET_EXCEEDED';
      throw error;
    }
    if (!Number.isFinite(plannedUsd) || plannedUsd <= 0) {
      const error = new Error('USD budget snapshot is required');
      error.code = 'USD_BUDGET_SNAPSHOT_REQUIRED';
      throw error;
    }
    const maxPerTrade = Number(chainConfig.maxPerTrade);
    const dailyBudget = Number(chainConfig.dailyBudget);
    const weeklyBudget = Number(chainConfig.weeklyBudget);
    const maxOpenPositions = Number(chainConfig.maxOpenPositions);
    const dailyLossLimit = Number(chainConfig.dailyLossLimit);
    if (![maxPerTrade, dailyBudget, weeklyBudget, maxOpenPositions, dailyLossLimit].every((value) => Number.isFinite(value) && value > 0)) {
      const error = new Error('Chain hard limits are missing or invalid');
      error.code = 'CHAIN_HARD_LIMIT_INVALID';
      throw error;
    }
    if (principal > maxPerTrade) {
      const error = new Error('Per-trade chain limit exceeded');
      error.code = 'CHAIN_PER_TRADE_LIMIT_EXCEEDED';
      throw error;
    }
    const activePositions = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM positions
       WHERE chain_id = $1 AND execution_mode = 'live'
         AND status IN ('open','open_unprotected','open_protected','partially_closed','closing','close_uncertain')`,
      [prepared.chain.id]
    );
    if (Number(activePositions.rows[0].count) >= maxOpenPositions) {
      const error = new Error('Maximum open positions reached for chain');
      error.code = 'MAX_OPEN_POSITIONS_REACHED';
      throw error;
    }
    const dailyLoss = await client.query(
      `SELECT COALESCE(SUM(pnl), 0) AS pnl
       FROM positions
       WHERE chain_id = $1 AND execution_mode = 'live' AND closed_at >= date_trunc('day', NOW())`,
      [prepared.chain.id]
    );
    if (Number(dailyLoss.rows[0].pnl || 0) <= -dailyLossLimit) {
      const error = new Error('Daily chain loss limit reached');
      error.code = 'CHAIN_DAILY_LOSS_LIMIT_REACHED';
      throw error;
    }
    const periodUsage = await client.query(
      `SELECT
         COALESCE((SELECT SUM(amount_native + fee_native) FROM budget_ledger
           WHERE chain = $1 AND entry_type = 'commit' AND created_at >= date_trunc('day', NOW())), 0) AS daily_committed,
         COALESCE((SELECT SUM(amount_native + fee_native) FROM budget_ledger
           WHERE chain = $1 AND entry_type = 'commit' AND created_at >= date_trunc('week', NOW())), 0) AS weekly_committed,
         COALESCE((SELECT SUM(amount_native + fee_native) FROM budget_reservations
           WHERE chain = $1 AND status = 'reserved'), 0) AS reserved_native,
         COALESCE((SELECT SUM(amount_usd_snapshot) FROM budget_ledger
           WHERE entry_type = 'commit' AND created_at >= date_trunc('day', NOW())), 0) AS global_daily_usd,
         COALESCE((SELECT SUM(amount_usd_snapshot) FROM budget_ledger
           WHERE entry_type = 'commit' AND created_at >= date_trunc('week', NOW())), 0) AS global_weekly_usd,
         COALESCE((SELECT SUM(amount_usd_snapshot) FROM budget_reservations
           WHERE status = 'reserved'), 0) AS global_reserved_usd`,
      [prepared.chain.id]
    );
    const usage = periodUsage.rows[0];
    const reservedNative = Number(usage.reserved_native || 0);
    if (Number(usage.daily_committed || 0) + reservedNative + planned > dailyBudget) {
      const error = new Error('Daily chain budget exceeded');
      error.code = 'CHAIN_DAILY_BUDGET_EXCEEDED';
      throw error;
    }
    if (Number(usage.weekly_committed || 0) + reservedNative + planned > weeklyBudget) {
      const error = new Error('Weekly chain budget exceeded');
      error.code = 'CHAIN_WEEKLY_BUDGET_EXCEEDED';
      throw error;
    }
    const globalDailyUsdLimit = Number(process.env.GMGN_GLOBAL_DAILY_USD_LIMIT || 0);
    const globalWeeklyUsdLimit = Number(process.env.GMGN_GLOBAL_WEEKLY_USD_LIMIT || 0);
    if (globalDailyUsdLimit <= 0 || globalWeeklyUsdLimit <= 0) {
      const error = new Error('Global USD hard limits are not configured');
      error.code = 'GLOBAL_USD_LIMIT_INVALID';
      throw error;
    }
    const globalReservedUsd = Number(usage.global_reserved_usd || 0);
    if (Number(usage.global_daily_usd || 0) + globalReservedUsd + plannedUsd > globalDailyUsdLimit) {
      const error = new Error('Global daily USD budget exceeded');
      error.code = 'GLOBAL_DAILY_USD_BUDGET_EXCEEDED';
      throw error;
    }
    if (Number(usage.global_weekly_usd || 0) + globalReservedUsd + plannedUsd > globalWeeklyUsdLimit) {
      const error = new Error('Global weekly USD budget exceeded');
      error.code = 'GLOBAL_WEEKLY_USD_BUDGET_EXCEEDED';
      throw error;
    }
    const minimumGasReserve = Number(process.env[`GMGN_MIN_GAS_RESERVE_${prepared.chain.id.toUpperCase()}`] || 0);
    if (!Number.isFinite(minimumGasReserve) || minimumGasReserve < 0
        || Number(prepared.walletNativeBalance) - planned < minimumGasReserve) {
      const error = new Error('Minimum native gas reserve would be breached');
      error.code = 'MINIMUM_GAS_RESERVE_BREACH';
      throw error;
    }

    const requestFingerprint = fingerprint({
      signalId: signal.signal_id,
      chain: prepared.chain.id,
      wallet: prepared.wallet.address,
      inputToken: prepared.chain.nativeToken,
      outputToken: signal.contract_address,
      inputAmountRaw: prepared.inputAmountRaw,
      slippage: Number(signal.slippage),
      snapshotHash: prepared.snapshotHash
    });
    const attemptResult = await client.query(
      `INSERT INTO trade_attempts
        (signal_id, whitelist_id, side, idempotency_key, chain, wallet_address,
         input_token, output_token, input_amount_raw, input_amount_display,
         status, request_fingerprint, metadata)
       VALUES ($1,$2,'buy',$3,$4,$5,$6,$7,$8,$9,'reserved',$10,$11)
       RETURNING *`,
      [
        signal.signal_id,
        signal.whitelist_id,
        idempotencyKey,
        prepared.chain.id,
        prepared.wallet.address,
        prepared.chain.nativeToken,
        signal.contract_address,
        prepared.inputAmountRaw,
        prepared.budgetNative,
        requestFingerprint,
        {
          snapshot_hash: prepared.snapshotHash,
          cache: prepared.cacheMeta,
          condition_orders: prepared.conditionOrders,
          token_decimals: prepared.token.decimals,
          token_symbol: prepared.token.symbol
        }
      ]
    );
    const attempt = attemptResult.rows[0];
    const reservationResult = await client.query(
      `INSERT INTO budget_reservations
        (attempt_id, whitelist_id, chain, native_symbol, amount_native,
         fee_native, amount_usd_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        attempt.id,
        signal.whitelist_id,
        prepared.chain.id,
        prepared.chain.nativeSymbol,
        prepared.budgetNative,
        prepared.feeReserveNative || 0,
        prepared.budgetUsdSnapshot
      ]
    );
    await client.query(
      `INSERT INTO budget_ledger
        (reservation_id, attempt_id, whitelist_id, chain, entry_type,
         amount_native, fee_native, amount_usd_snapshot, reason)
       VALUES ($1,$2,$3,$4,'reserve',$5,$6,$7,'PRE_SUBMIT_RESERVATION')`,
      [
        reservationResult.rows[0].id,
        attempt.id,
        signal.whitelist_id,
        prepared.chain.id,
        prepared.budgetNative,
        prepared.feeReserveNative || 0,
        prepared.budgetUsdSnapshot
      ]
    );
    await client.query(
      `UPDATE trade_signals
       SET status = 'execution_reserved', risk_check = $1, reject_reason = NULL, updated_at = NOW()
       WHERE id = $2`,
      [prepared.riskSnapshot, signal.signal_id]
    );
    await addAttemptEvent(client, attempt.id, null, 'reserved', {
      summary: { reservation_id: reservationResult.rows[0].id }
    });
    await client.query('COMMIT');
    return { attempt, reservation: reservationResult.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createSellAttempt(prepared) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const positionResult = await client.query(
      `SELECT * FROM positions WHERE id = $1 FOR UPDATE`,
      [prepared.position.id]
    );
    const position = positionResult.rows[0];
    if (!position || !['open','open_protected','open_unprotected','partially_closed'].includes(position.status)) {
      const error = new Error('Position is not available for closing');
      error.code = 'POSITION_NOT_CLOSABLE';
      throw error;
    }
    const active = await client.query(
      `SELECT id FROM trade_attempts
       WHERE position_id = $1 AND side = 'sell'
         AND status IN ('reserved','preparing','submitting','submitted','confirming','submission_uncertain')
       LIMIT 1`,
      [position.id]
    );
    if (active.rows.length > 0) {
      const error = new Error(`Position already has active sell attempt #${active.rows[0].id}`);
      error.code = 'SELL_ATTEMPT_EXISTS';
      throw error;
    }
    if (!prepared.closeIntentId) {
      const error = new Error('Close attempt requires a consumed prepare intent');
      error.code = 'CLOSE_INTENT_MISSING';
      throw error;
    }
    const idempotencyKey = `position:${position.id}:sell:prepare:${prepared.closeIntentId}`;
    const attemptResult = await client.query(
      `INSERT INTO trade_attempts
        (signal_id, whitelist_id, position_id, side, idempotency_key, chain,
         wallet_address, input_token, output_token, input_amount_raw,
         input_amount_display, status, request_fingerprint, metadata)
       VALUES ($1,$2,$3,'sell',$4,$5,$6,$7,$8,$9,$10,'reserved',$11,$12)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        position.signal_id,
        position.whitelist_id,
        position.id,
        idempotencyKey,
        position.chain_id,
        prepared.wallet.address,
        position.contract_address,
        prepared.chain.nativeToken,
        prepared.inputAmountRaw,
        prepared.inputAmountDisplay,
        fingerprint({ position: position.id, amount: prepared.inputAmountRaw, snapshot: prepared.snapshotHash }),
        { snapshot_hash: prepared.snapshotHash, token_decimals: prepared.tokenDecimals }
      ]
    );
    if (attemptResult.rows.length === 0) {
      const error = new Error('This position amount already has a sell attempt');
      error.code = 'SELL_ATTEMPT_EXISTS';
      throw error;
    }
    const attempt = attemptResult.rows[0];
    await client.query(
      `UPDATE positions SET status = 'closing', updated_at = NOW() WHERE id = $1`,
      [position.id]
    );
    await addAttemptEvent(client, attempt.id, null, 'reserved', { actor: prepared.operatorId });
    await client.query('COMMIT');
    return attempt;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function transitionAttempt(attemptId, expectedStatuses, nextStatus, details = {}) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE trade_attempts
       SET status = $1,
           error_code = COALESCE($2, error_code),
           error_class = COALESCE($3, error_class),
           requires_manual_review = COALESCE($4, requires_manual_review),
           submit_started_at = CASE WHEN $1 = 'submitting' THEN NOW() ELSE submit_started_at END,
           submitted_at = CASE WHEN $1 = 'submitted' THEN NOW() ELSE submitted_at END,
           confirmed_at = CASE WHEN $1 = 'confirmed' THEN NOW() ELSE confirmed_at END,
           last_reconciled_at = CASE WHEN $1 IN ('confirming','confirmed','failed','reconciliation_required') THEN NOW() ELSE last_reconciled_at END,
           updated_at = NOW()
       WHERE id = $5 AND status = ANY($6::text[])
       RETURNING *`,
      [
        nextStatus,
        details.errorCode || null,
        details.errorClass || null,
        details.requiresManualReview,
        attemptId,
        expectedStatuses
      ]
    );
    if (result.rows.length === 0) {
      const error = new Error(`Trade attempt ${attemptId} state changed concurrently`);
      error.code = 'TRADE_ATTEMPT_CAS_FAILED';
      throw error;
    }
    const attempt = result.rows[0];
    if (nextStatus === 'submitting' && attempt.signal_id) {
      await client.query(
        `UPDATE x_provider_events AS provider_event
         SET swap_started_at = NOW(),
             receive_to_swap_ms = GREATEST(0, ROUND(EXTRACT(EPOCH FROM
               (NOW() - COALESCE(provider_event.transport_received_at, provider_event.received_at))) * 1000)::int),
             updated_at = NOW()
         FROM trade_signals AS signal
         WHERE signal.id = $1
           AND signal.activity_id = ANY(COALESCE(provider_event.activity_ids, '{}'::int[]))`,
        [attempt.signal_id]
      );
    }
    await addAttemptEvent(client, attemptId, expectedStatuses.join('|'), nextStatus, details);
    if (details.alertTopic) {
      await writeOutbox(client, details.alertTopic, 'trade_attempt', attemptId, {
        attempt_id: attemptId,
        status: nextStatus,
        code: details.errorCode || null
      });
    }
    await client.query('COMMIT');
    return attempt;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recordSubmittedOrder(attemptId, normalizedOrder, quote, responseMeta) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const attemptResult = await client.query(
      `UPDATE trade_attempts
       SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'submitting'
       RETURNING *`,
      [attemptId]
    );
    if (attemptResult.rows.length === 0) {
      const error = new Error('Attempt is not in submitting state');
      error.code = 'TRADE_ATTEMPT_CAS_FAILED';
      throw error;
    }
    const orderResult = await client.query(
      `INSERT INTO trade_orders
        (attempt_id, provider_order_id, auth_client_id, tx_hash, provider_status,
         normalized_status, input_token, output_token, input_amount_raw,
         output_amount_raw, quote_json, report_json, last_response_json,
         submitted_at, next_query_at)
       SELECT id,$2,$3,$4,$5,$6,input_token,output_token,input_amount_raw,$7,$8,$9,$10,NOW(),NOW()
       FROM trade_attempts WHERE id = $1
       RETURNING *`,
      [
        attemptId,
        normalizedOrder.providerOrderId,
        responseMeta?.authClientId || null,
        normalizedOrder.txHash,
        normalizedOrder.providerStatus,
        normalizedOrder.status === 'confirmed' ? 'chain_verifying' : normalizedOrder.status,
        normalizedOrder.report.outputAmountRaw,
        quote.raw || {},
        normalizedOrder.report.raw || {},
        normalizedOrder.raw || {}
      ]
    );
    await addAttemptEvent(client, attemptId, 'submitting', 'submitted', {
      providerRequestId: normalizedOrder.providerOrderId,
      httpStatus: responseMeta?.status,
      latencyMs: responseMeta?.latencyMs
    });
    await client.query('COMMIT');
    return orderResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function markSubmissionUncertain(attemptId, error) {
  return transitionAttempt(attemptId, ['submitting'], 'submission_uncertain', {
    errorCode: error.code || 'GMGN_SUBMISSION_UNCERTAIN',
    errorClass: error.name || 'Error',
    requiresManualReview: true,
    alertTopic: 'trade.submission_uncertain',
    reason: error.message
  });
}

async function releaseRejectedAttempt(attemptId, error) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const attemptResult = await client.query(
      `UPDATE trade_attempts
       SET status = 'rejected', error_code = $2, error_class = $3, updated_at = NOW()
       WHERE id = $1 AND status IN ('reserved','preparing','submitting')
       RETURNING *`,
      [attemptId, error.code || 'TRADE_REJECTED', error.name || 'Error']
    );
    if (attemptResult.rows.length === 0) {
      const stateError = new Error('Attempt cannot be released from its current state');
      stateError.code = 'TRADE_ATTEMPT_CAS_FAILED';
      throw stateError;
    }
    const reservation = await client.query(
      `UPDATE budget_reservations
       SET status = 'released', released_at = NOW(), updated_at = NOW()
       WHERE attempt_id = $1 AND status = 'reserved'
       RETURNING *`,
      [attemptId]
    );
    if (reservation.rows[0]) {
      const row = reservation.rows[0];
      await client.query(
        `INSERT INTO budget_ledger
          (reservation_id, attempt_id, whitelist_id, chain, entry_type,
           amount_native, fee_native, amount_usd_snapshot, reason)
         VALUES ($1,$2,$3,$4,'release',$5,$6,$7,$8)`,
        [row.id, attemptId, row.whitelist_id, row.chain, row.amount_native, row.fee_native,
          row.amount_usd_snapshot, error.code || 'TRADE_REJECTED']
      );
    }
    await client.query(
      `UPDATE trade_signals SET status = 'rejected', reject_reason = $2, updated_at = NOW()
       WHERE id = $1`,
      [attemptResult.rows[0].signal_id, error.code || 'TRADE_REJECTED']
    );
    await addAttemptEvent(client, attemptId, 'submitting', 'rejected', {
      reason: error.message,
      errorCode: error.code
    });
    await client.query('COMMIT');
    return attemptResult.rows[0];
  } catch (transactionError) {
    await client.query('ROLLBACK');
    throw transactionError;
  } finally {
    client.release();
  }
}

async function listDueOrders(limit = 20) {
  const result = await db.query(
    `SELECT orders.*, attempts.chain, attempts.wallet_address, attempts.signal_id,
            attempts.side,
            attempts.whitelist_id, attempts.position_id,
            attempts.metadata AS attempt_metadata,
            attempts.status AS attempt_status
     FROM trade_orders AS orders
     JOIN trade_attempts AS attempts ON attempts.id = orders.attempt_id
     WHERE orders.normalized_status IN ('submitted','pending','chain_verifying','unknown')
       AND orders.next_query_at <= NOW()
     ORDER BY orders.next_query_at ASC
     LIMIT $1`,
    [Math.min(100, Math.max(1, Number(limit)))]
  );
  return result.rows;
}

async function listUncertainAttempts(limit = 10) {
  const result = await db.query(
    `SELECT attempt.*
     FROM trade_attempts AS attempt
     WHERE attempt.status IN ('submission_uncertain','reconciliation_required')
       AND NOT EXISTS (SELECT 1 FROM trade_orders WHERE attempt_id = attempt.id)
       AND (attempt.last_reconciled_at IS NULL OR attempt.last_reconciled_at < NOW() - INTERVAL '30 seconds')
     ORDER BY attempt.created_at ASC LIMIT $1`,
    [Math.min(50, Math.max(1, Number(limit)))]
  );
  return result.rows;
}

async function touchAttemptReconciliation(attemptId) {
  await db.query(
    `UPDATE trade_attempts SET last_reconciled_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [attemptId]
  );
}

async function updateOrderAfterQuery(orderId, normalizedOrder, nextQueryAt) {
  const result = await db.query(
    `UPDATE trade_orders
     SET provider_status = $2, normalized_status = $3, tx_hash = COALESCE($4, tx_hash),
         output_amount_raw = COALESCE($5, output_amount_raw),
         input_amount_raw = COALESCE($6, input_amount_raw),
         input_decimals = COALESCE($7, input_decimals),
         output_decimals = COALESCE($8, output_decimals),
         price_usd = COALESCE($9, price_usd),
         gas_native = COALESCE($10, gas_native),
         gas_usd = COALESCE($11, gas_usd),
         report_json = $12, last_response_json = $13,
         last_queried_at = NOW(), next_query_at = $14,
         query_count = query_count + 1, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      orderId,
      normalizedOrder.providerStatus,
      normalizedOrder.status,
      normalizedOrder.txHash,
      normalizedOrder.report.outputAmountRaw,
      normalizedOrder.report.inputAmountRaw,
      normalizedOrder.report.inputDecimals,
      normalizedOrder.report.outputDecimals,
      normalizedOrder.report.priceUsd,
      normalizedOrder.report.gasNative,
      normalizedOrder.report.gasUsd,
      normalizedOrder.report.raw || {},
      normalizedOrder.raw || {},
      nextQueryAt
    ]
  );
  return result.rows[0];
}

async function saveChainReceipt(orderId, chain, txHash, receipt) {
  const transferEvidence = {
    ...(receipt.transfers || {}),
    nativeBalanceDeltaRaw: receipt.nativeBalanceDeltaRaw ?? null,
    nativeProceedsRaw: receipt.nativeProceedsRaw ?? null,
    closedTokenAccountRentRaw: receipt.closedTokenAccountRentRaw ?? '0'
  };
  const result = await db.query(
    `INSERT INTO chain_receipts
      (order_id, chain, tx_hash, block_ref, receipt_status, confirmations,
       transfer_json, raw_receipt_json, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $5 = 'confirmed' THEN NOW() ELSE NULL END)
     ON CONFLICT (chain, tx_hash)
     DO UPDATE SET block_ref = EXCLUDED.block_ref,
                   receipt_status = EXCLUDED.receipt_status,
                   confirmations = EXCLUDED.confirmations,
                   transfer_json = EXCLUDED.transfer_json,
                   raw_receipt_json = EXCLUDED.raw_receipt_json,
                   verified_at = EXCLUDED.verified_at,
                   updated_at = NOW()
     RETURNING *`,
    [
      orderId,
      chain,
      txHash,
      receipt.blockRef,
      receipt.status,
      receipt.confirmations || 0,
      transferEvidence,
      receipt.raw || {}
    ]
  );
  return result.rows[0];
}

function sellSettlementOutputRaw(chain, receipt, reportOutputRaw, storedOutputRaw) {
  const routerProceeds = String(receipt?.nativeProceedsRaw || '');
  if (chain !== 'sol' && /^\d+$/.test(routerProceeds) && BigInt(routerProceeds) > 0n) {
    return routerProceeds;
  }
  const nativeDelta = String(receipt?.nativeBalanceDeltaRaw || '');
  if (/^\d+$/.test(nativeDelta) && BigInt(nativeDelta) > 0n) {
    if (chain === 'sol') {
      const rentRaw = /^\d+$/.test(String(receipt?.closedTokenAccountRentRaw || ''))
        ? BigInt(receipt.closedTokenAccountRentRaw)
        : 0n;
      const adjusted = BigInt(nativeDelta) - rentRaw;
      if (adjusted > 0n) return adjusted.toString();
    } else {
      return nativeDelta;
    }
  }
  return String(reportOutputRaw || storedOutputRaw || '');
}

async function finalizeConfirmedOrder(orderId, normalizedOrder, receipt) {
  if (receipt.status !== 'confirmed') {
    const error = new Error('Chain receipt is not confirmed');
    error.code = 'CHAIN_RECEIPT_NOT_CONFIRMED';
    throw error;
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT orders.*, attempt.signal_id, attempt.whitelist_id, attempt.chain,
              attempt.wallet_address, attempt.input_token, attempt.output_token, attempt.side,
              attempt.input_amount_display AS planned_input_display,
              attempt.metadata, attempt.status AS attempt_status,
              whitelist.symbol, whitelist.auto_tp_pct, whitelist.auto_sl_pct,
              reservation.amount_native AS reserved_principal_native,
              reservation.fee_native AS reserved_fee_native,
              reservation.amount_usd_snapshot AS reserved_usd_snapshot
       FROM trade_orders AS orders
       JOIN trade_attempts AS attempt ON attempt.id = orders.attempt_id
       LEFT JOIN ca_whitelist AS whitelist ON whitelist.id = attempt.whitelist_id
       LEFT JOIN budget_reservations AS reservation ON reservation.attempt_id = attempt.id
       WHERE orders.id = $1 FOR UPDATE OF orders, attempt`,
      [orderId]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Trade order not found');
    if (row.side === 'sell') {
      await client.query('ROLLBACK');
      return finalizeConfirmedSellOrder(orderId, normalizedOrder, receipt);
    }
    const existing = await client.query('SELECT * FROM positions WHERE signal_id = $1 FOR UPDATE', [row.signal_id]);
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return existing.rows[0];
    }

    const report = normalizedOrder.report;
    const inputRaw = report.inputAmountRaw || row.input_amount_raw;
    const outputRaw = report.outputAmountRaw || row.output_amount_raw;
    const inputDecimals = Number(report.inputDecimals ?? row.input_decimals);
    const outputDecimals = Number(report.outputDecimals ?? row.output_decimals ?? row.metadata?.token_decimals);
    if (!/^\d+$/.test(String(inputRaw || '')) || !/^\d+$/.test(String(outputRaw || ''))
        || !Number.isInteger(inputDecimals) || !Number.isInteger(outputDecimals)) {
      const error = new Error('Confirmed GMGN report lacks exact raw amounts or decimals');
      error.code = 'CONFIRMED_REPORT_INCOMPLETE';
      throw error;
    }
    const inputDisplay = rawToDecimal(inputRaw, inputDecimals, 18);
    const outputDisplay = rawToDecimal(outputRaw, outputDecimals, 18);
    const conditions = Array.isArray(row.metadata?.condition_orders) ? row.metadata.condition_orders : [];
    const protectionRequested = conditions.length > 0;
    const protectedPosition = Boolean(normalizedOrder.strategyOrderId);
    const protectionAssociation = normalizedOrder.raw?.xbot_strategy_association || null;
    const protectionErrorCode = protectionRequested && !protectedPosition
      ? protectionAssociation?.status === 'ambiguous'
        ? 'PROTECTION_STRATEGY_AMBIGUOUS'
        : 'PROTECTION_STRATEGY_MISSING'
      : null;
    const positionResult = await client.query(
      `INSERT INTO positions
        (signal_id, whitelist_id, contract_address, chain_id, symbol,
         amount_in, amount_out, entry_price, buy_tx_hash, buy_order_id,
         tp_pct, sl_pct, tp_order_id, sl_order_id, tpsl_status,
         execution_mode, status, opened_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,'live',$15,NOW())
       RETURNING *`,
      [
        row.signal_id,
        row.whitelist_id,
        row.output_token,
        row.chain,
        row.symbol || row.metadata?.token_symbol || null,
        inputDisplay,
        outputDisplay,
        report.priceUsd || row.price_usd || 0,
        normalizedOrder.txHash || row.tx_hash,
        normalizedOrder.providerOrderId || row.provider_order_id,
        row.auto_tp_pct,
        row.auto_sl_pct,
        normalizedOrder.strategyOrderId,
        protectedPosition ? 'ok' : 'failed',
        protectedPosition ? 'open_protected' : 'open_unprotected'
      ]
    );
    const position = positionResult.rows[0];
    await client.query(
      `INSERT INTO position_lots
        (position_id, buy_order_id, chain, wallet_address, token_address,
         token_decimals, opened_amount_raw, remaining_amount_raw,
         reserved_by_strategy_raw, cost_native, cost_usd, fee_native)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11)`,
      [
        position.id,
        row.id,
        row.chain,
        row.wallet_address,
        row.output_token,
        outputDecimals,
        outputRaw,
        protectedPosition ? outputRaw : '0',
        inputDisplay,
        principalUsdCost(inputDisplay, {
          amount_native: row.reserved_principal_native,
          fee_native: row.reserved_fee_native,
          amount_usd_snapshot: row.reserved_usd_snapshot
        }),
        report.gasNative
      ]
    );
    if (protectedPosition) {
      const groupResult = await client.query(
        `INSERT INTO strategy_groups
          (position_id, attempt_id, provider_order_id, total_amount_raw,
           status, requested_params, provider_params)
         VALUES ($1,$2,$3,$4,'running',$5,$6)
         RETURNING id`,
        [
          position.id,
          row.attempt_id,
          normalizedOrder.strategyOrderId,
          outputRaw,
          { sell_ratio_type: 'buy_amount', condition_orders: row.metadata?.condition_orders || [] },
          normalizedOrder.raw || {}
        ]
      );
      for (let index = 0; index < conditions.length; index += 1) {
        const condition = conditions[index];
        await client.query(
          `INSERT INTO strategy_legs
            (group_id, leg_index, order_type, amount_raw, trigger_value,
             status, strategy_status, requested_params)
           VALUES ($1,$2,$3,$4,$5,'running','running',$6)`,
          [groupResult.rows[0].id, index, condition.order_type,
            strategyLegAmountRaw(outputRaw, condition),
            condition.price_scale || null, condition]
        );
      }
    } else {
      await writeOutbox(client, 'position.unprotected', 'position', position.id, {
        position_id: position.id,
        chain: row.chain,
        token: row.output_token,
        protection_requested: protectionRequested,
        strategy_association: protectionAssociation
      });
    }

    await client.query(
      `UPDATE trade_orders
       SET normalized_status = 'confirmed', confirmed_at = NOW(),
           input_amount_raw = $2, output_amount_raw = $3,
           input_decimals = $4, output_decimals = $5,
           input_amount_display = $6, output_amount_display = $7,
           price_usd = COALESCE($8, price_usd), gas_native = COALESCE($9, gas_native),
           gas_usd = COALESCE($10, gas_usd), updated_at = NOW()
       WHERE id = $1`,
      [orderId, inputRaw, outputRaw, inputDecimals, outputDecimals, inputDisplay,
        outputDisplay, report.priceUsd, report.gasNative, report.gasUsd]
    );
    await client.query(
      `UPDATE trade_attempts
       SET status = 'confirmed', position_id = $2, output_amount_raw = $3,
           output_amount_display = $4, error_code = $5,
           error_class = NULL, requires_manual_review = $6,
           confirmed_at = NOW(), last_reconciled_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [row.attempt_id, position.id, outputRaw, outputDisplay,
        protectionErrorCode, Boolean(protectionErrorCode)]
    );
    const reservationResult = await client.query(
      `UPDATE budget_reservations
       SET status = 'committed', amount_native = $2,
           fee_native = COALESCE($3, fee_native), committed_at = NOW(), updated_at = NOW()
       WHERE attempt_id = $1 AND status = 'reserved'
       RETURNING *`,
      [row.attempt_id, inputDisplay, report.gasNative]
    );
    if (reservationResult.rows[0]) {
      const reservation = reservationResult.rows[0];
      await client.query(
        `INSERT INTO budget_ledger
          (reservation_id, attempt_id, whitelist_id, chain, entry_type,
           amount_native, fee_native, amount_usd_snapshot, reason)
         VALUES ($1,$2,$3,$4,'commit',$5,$6,$7,'ORDER_AND_CHAIN_CONFIRMED')`,
        [reservation.id, row.attempt_id, row.whitelist_id, row.chain, inputDisplay,
          report.gasNative || 0, reservation.amount_usd_snapshot]
      );
    }
    await client.query(
      `UPDATE ca_whitelist
       SET spent_budget = spent_budget + $1,
           current_buy_count = current_buy_count + 1,
           updated_at = NOW()
       WHERE id = $2`,
      [inputDisplay, row.whitelist_id]
    );
    await client.query(
      `UPDATE trade_signals SET execution_mode = 'live', status = 'executed',
       reject_reason = NULL, updated_at = NOW() WHERE id = $1`,
      [row.signal_id]
    );
    await addAttemptEvent(client, row.attempt_id, row.attempt_status, 'confirmed', {
      providerRequestId: normalizedOrder.providerOrderId,
      summary: {
        position_id: position.id,
        chain_receipt: receipt.status,
        strategy_association: protectionAssociation,
        protection_error: protectionErrorCode
      }
    });
    await client.query('COMMIT');
    return position;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeConfirmedSellOrder(orderId, normalizedOrder, receipt) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT orders.*, attempt.position_id, attempt.status AS attempt_status,
              attempt.input_amount_raw AS planned_input_raw, attempt.chain,
              attempt.metadata
       FROM trade_orders AS orders
       JOIN trade_attempts AS attempt ON attempt.id = orders.attempt_id
       WHERE orders.id = $1 FOR UPDATE`,
      [orderId]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Sell order not found');
    if (row.normalized_status === 'confirmed' && row.attempt_status === 'confirmed') {
      const existingPosition = await client.query('SELECT * FROM positions WHERE id = $1', [row.position_id]);
      await client.query('COMMIT');
      return existingPosition.rows[0];
    }
    const report = normalizedOrder.report;
    const soldRaw = String(report.inputAmountRaw || row.input_amount_raw || row.planned_input_raw || '');
    const outputRaw = sellSettlementOutputRaw(
      row.chain,
      receipt,
      report.outputAmountRaw,
      row.output_amount_raw
    );
    if (!/^\d+$/.test(soldRaw) || !/^\d+$/.test(outputRaw)) {
      const error = new Error('Confirmed sell report lacks exact raw amounts');
      error.code = 'CONFIRMED_REPORT_INCOMPLETE';
      throw error;
    }
    const chain = requireChain(row.chain);
    const outputDecimals = Number(report.outputDecimals ?? row.output_decimals ?? chain.decimals);
    const outputDisplay = rawToDecimal(outputRaw, outputDecimals, 18);
    let remainingToApply = BigInt(soldRaw);
    const lotsResult = await client.query(
      `SELECT * FROM position_lots WHERE position_id = $1 ORDER BY id ASC FOR UPDATE`,
      [row.position_id]
    );
    for (const lot of lotsResult.rows) {
      if (remainingToApply === 0n) break;
      const available = BigInt(lot.remaining_amount_raw);
      const applied = available < remainingToApply ? available : remainingToApply;
      await client.query(
        `UPDATE position_lots
         SET remaining_amount_raw = $2::text,
             reserved_by_strategy_raw = LEAST(reserved_by_strategy_raw::numeric, $2::numeric)::text,
             realized_cost_native = realized_cost_native
               + COALESCE(cost_native, 0) * $3::numeric / NULLIF(opened_amount_raw::numeric, 0),
             realized_proceeds_native = realized_proceeds_native
               + $4::numeric * $3::numeric / $5::numeric,
             last_reconciled_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [lot.id, (available - applied).toString(), applied.toString(), outputDisplay, soldRaw]
      );
      remainingToApply -= applied;
    }
    if (remainingToApply > 0n) {
      const error = new Error('Sell amount exceeds position lot remaining amount');
      error.code = 'POSITION_LOT_UNDERFLOW';
      throw error;
    }
    const remainingResult = await client.query(
      `SELECT COALESCE(SUM(remaining_amount_raw::numeric), 0)::text AS remaining
       FROM position_lots WHERE position_id = $1`,
      [row.position_id]
    );
    const positionStatus = BigInt(remainingResult.rows[0].remaining.split('.')[0]) === 0n
      ? 'closed'
      : 'partially_closed';
    const realized = await client.query(
      `SELECT COALESCE(SUM(realized_cost_native), 0) AS cost,
              COALESCE(SUM(realized_proceeds_native), 0) AS proceeds
       FROM position_lots WHERE position_id = $1`,
      [row.position_id]
    );
    const realizedCost = Number(realized.rows[0].cost || 0);
    const realizedProceeds = Number(realized.rows[0].proceeds || 0);
    const pnl = realizedProceeds - realizedCost;
    const pnlPct = realizedCost > 0 ? (pnl / realizedCost) * 100 : null;
    await client.query(
      `UPDATE positions
       SET status = $2, sell_tx_hash = $3,
           pnl = $4, pnl_pct = $5,
           closed_at = CASE WHEN $2 = 'closed' THEN NOW() ELSE closed_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [row.position_id, positionStatus, normalizedOrder.txHash, pnl, pnlPct]
    );
    await client.query(
      `UPDATE trade_orders SET normalized_status = 'confirmed', confirmed_at = NOW(),
       input_amount_raw = $2, output_amount_raw = $3,
       output_decimals = $4, output_amount_display = $5, report_json = $6,
       updated_at = NOW() WHERE id = $1`,
      [orderId, soldRaw, outputRaw, outputDecimals, outputDisplay, report.raw || {}]
    );
    await client.query(
      `UPDATE trade_attempts SET status = 'confirmed', confirmed_at = NOW(),
       output_amount_raw = $2, output_amount_display = $3,
       error_code = NULL, error_class = NULL, requires_manual_review = false,
       last_reconciled_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [row.attempt_id, outputRaw, outputDisplay]
    );
    const strategyGroupId = Number(row.metadata?.strategy_group_id || 0);
    if (strategyGroupId > 0) {
      const strategyGroupStatus = row.metadata?.strategy_terminal ? 'completed' : 'partially_filled';
      await client.query(
        `UPDATE strategy_groups
         SET status = $5,
             strategy_status = CASE WHEN $5 = 'completed' THEN 'stopped' ELSE strategy_status END,
             close_amount_raw = $2, close_output_amount_raw = $3,
             close_tx_hash = $4, last_reconciled_at = NOW(),
             next_query_at = CASE WHEN $5 = 'partially_filled' THEN NOW() ELSE next_query_at END,
             updated_at = NOW()
         WHERE id = $1`,
        [strategyGroupId, soldRaw, outputRaw, normalizedOrder.txHash, strategyGroupStatus]
      );
      if (strategyGroupStatus === 'completed') {
        await client.query(
          `UPDATE strategy_legs
           SET status = CASE WHEN status = 'success' THEN status ELSE 'cancelled' END,
               last_reconciled_at = NOW(), updated_at = NOW()
           WHERE group_id = $1 AND status NOT IN ('failed','success')`,
          [strategyGroupId]
        );
      }
    }
    await addAttemptEvent(client, row.attempt_id, row.attempt_status, 'confirmed', {
      summary: {
        position_id: row.position_id,
        position_status: positionStatus,
        chain_receipt: receipt.status,
        realized_cost_native: realizedCost,
        realized_proceeds_native: realizedProceeds,
        pnl_native: pnl
      }
    });
    await writeOutbox(client, 'position.close_confirmed', 'position', row.position_id, {
      position_id: row.position_id,
      status: positionStatus,
      tx_hash: normalizedOrder.txHash,
      proceeds_native: outputDisplay,
      pnl_native: pnl
    });
    await client.query('COMMIT');
    return { id: row.position_id, status: positionStatus };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function markSellUncertain(attemptId, positionId, error) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const attempt = await client.query(
      `UPDATE trade_attempts SET status = 'submission_uncertain',
       error_code = $2, error_class = $3, requires_manual_review = true,
       updated_at = NOW() WHERE id = $1 AND status IN ('preparing','submitting') RETURNING *`,
      [attemptId, error.code || 'GMGN_SUBMISSION_UNCERTAIN', error.name || 'Error']
    );
    if (attempt.rows.length === 0) throw new Error('Sell attempt state changed concurrently');
    await client.query(
      `UPDATE positions SET status = 'close_uncertain', updated_at = NOW() WHERE id = $1`,
      [positionId]
    );
    await addAttemptEvent(client, attemptId, 'submitting', 'submission_uncertain', { reason: error.message });
    await writeOutbox(client, 'position.close_uncertain', 'position', positionId, {
      position_id: positionId,
      attempt_id: attemptId,
      code: error.code || 'GMGN_SUBMISSION_UNCERTAIN'
    });
    await client.query('COMMIT');
  } catch (transactionError) {
    await client.query('ROLLBACK');
    throw transactionError;
  } finally {
    client.release();
  }
}

async function rejectSellAttempt(attemptId, positionId, error, fallbackStatus = 'open_unprotected') {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const rejected = await client.query(
      `UPDATE trade_attempts SET status = 'rejected', error_code = $2,
       error_class = $3, updated_at = NOW()
       WHERE id = $1 AND status IN ('reserved','preparing','submitting')
       RETURNING id`,
      [attemptId, error.code || 'SELL_REJECTED', error.name || 'Error']
    );
    if (rejected.rows.length > 0) {
      await client.query(
        `UPDATE positions SET status = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'closing'`,
        [positionId, fallbackStatus]
      );
      await addAttemptEvent(client, attemptId, 'submitting', 'rejected', { reason: error.message });
    }
    await client.query('COMMIT');
  } catch (transactionError) {
    await client.query('ROLLBACK');
    throw transactionError;
  } finally {
    client.release();
  }
}

async function resolveCancelledCloseAttempt(attemptId, positionId, strategyEvidence) {
  if (!Array.isArray(strategyEvidence) || strategyEvidence.length === 0) {
    const error = new Error('Cancelled strategy evidence is required');
    error.code = 'STRATEGY_CANCEL_EVIDENCE_REQUIRED';
    throw error;
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const attemptResult = await client.query(
      `SELECT * FROM trade_attempts
       WHERE id = $1 AND position_id = $2 AND side = 'sell'
         AND status IN ('submission_uncertain','reconciliation_required')
         AND (
           error_code IN ('STRATEGY_CANCEL_UNCERTAIN','STRATEGY_CANCEL_UNVERIFIED')
           OR EXISTS (
             SELECT 1 FROM trade_attempt_events AS event
             WHERE event.attempt_id = trade_attempts.id
               AND event.to_status = 'submission_uncertain'
               AND event.reason ILIKE '%strategy cancellation%'
           )
         )
       FOR UPDATE`,
      [attemptId, positionId]
    );
    if (attemptResult.rows.length === 0) {
      const error = new Error('Close attempt is not eligible for cancellation recovery');
      error.code = 'CLOSE_RECOVERY_NOT_ELIGIBLE';
      throw error;
    }
    const orderResult = await client.query(
      'SELECT id FROM trade_orders WHERE attempt_id = $1 LIMIT 1',
      [attemptId]
    );
    if (orderResult.rows.length > 0) {
      const error = new Error('Close attempt already has a submitted provider order');
      error.code = 'CLOSE_RECOVERY_ORDER_EXISTS';
      throw error;
    }
    for (const evidence of strategyEvidence) {
      const updated = await client.query(
        `UPDATE strategy_groups
         SET status = 'cancelled', provider_status = $2, strategy_status = $3,
             provider_params = $4, close_time = COALESCE($5, close_time),
             last_reconciled_at = NOW(), next_query_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND position_id = $6 AND provider_order_id = $7
         RETURNING id`,
        [
          evidence.groupId,
          evidence.normalized.providerStatus,
          evidence.normalized.strategyStatus,
          evidence.normalized.raw || {},
          providerTimestamp(evidence.normalized.closeTime),
          positionId,
          evidence.normalized.providerOrderId
        ]
      );
      if (updated.rows.length === 0) {
        const error = new Error(`Strategy group ${evidence.groupId} changed during recovery`);
        error.code = 'STRATEGY_RECOVERY_CAS_FAILED';
        throw error;
      }
    }
    await client.query(
      `UPDATE trade_attempts
       SET status = 'rejected', error_code = 'STRATEGY_CANCELLED_BEFORE_SWAP',
           error_class = NULL, requires_manual_review = false,
           last_reconciled_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [attemptId]
    );
    const positionResult = await client.query(
      `UPDATE positions
       SET status = 'open_unprotected', tpsl_status = 'failed', updated_at = NOW()
       WHERE id = $1 AND status = 'close_uncertain'
       RETURNING id, status`,
      [positionId]
    );
    if (positionResult.rows.length === 0) {
      const error = new Error('Position changed during cancellation recovery');
      error.code = 'POSITION_RECOVERY_CAS_FAILED';
      throw error;
    }
    await addAttemptEvent(
      client,
      attemptId,
      attemptResult.rows[0].status,
      'rejected',
      { reason: 'Provider history proves strategy cancellation before swap submission' }
    );
    await writeOutbox(client, 'position.close_recovered_unprotected', 'position', positionId, {
      position_id: positionId,
      attempt_id: attemptId,
      strategy_order_ids: strategyEvidence.map((item) => item.normalized.providerOrderId)
    });
    await client.query('COMMIT');
    return { attemptId: Number(attemptId), positionId: Number(positionId), status: 'open_unprotected' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getPositionForClose(positionId, executor = db) {
  const result = await executor.query(
    `SELECT position.*, whitelist.slippage AS whitelist_slippage,
            COALESCE((
              SELECT json_agg(lot ORDER BY lot.id)
              FROM position_lots AS lot
              WHERE lot.position_id = position.id
            ), '[]') AS lots,
            COALESCE((
              SELECT json_agg(strategy_group ORDER BY strategy_group.id DESC)
              FROM strategy_groups AS strategy_group
              WHERE strategy_group.position_id = position.id
            ), '[]') AS strategy_groups
     FROM positions AS position
     LEFT JOIN ca_whitelist AS whitelist ON whitelist.id = position.whitelist_id
     WHERE position.id = $1`,
    [positionId]
  );
  return result.rows[0] || null;
}

async function listDueStrategyGroups(limit = 20) {
  const result = await db.query(
    `SELECT strategy_group.*, position.chain_id, position.contract_address,
            position.signal_id, position.whitelist_id, position.status AS position_status,
            lot.wallet_address, lot.token_decimals
     FROM strategy_groups AS strategy_group
     JOIN positions AS position ON position.id = strategy_group.position_id
     LEFT JOIN LATERAL (
       SELECT wallet_address, token_decimals
       FROM position_lots
       WHERE position_id = position.id
       ORDER BY id ASC LIMIT 1
     ) AS lot ON true
     WHERE strategy_group.status IN (
       'pending','running','partially_filled','triggered','cancelling','unknown'
     )
       AND strategy_group.next_query_at <= NOW()
     ORDER BY CASE strategy_group.status
                WHEN 'triggered' THEN 0
                WHEN 'cancelling' THEN 1
                WHEN 'unknown' THEN 2
                ELSE 3
              END,
              strategy_group.next_query_at ASC
     LIMIT $1`,
    [Math.min(100, Math.max(1, Number(limit)))]
  );
  return result.rows;
}

function normalizeLegStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['cancel', 'cancelled', 'canceled'].includes(status)) return 'cancelled';
  if (['success', 'failed', 'running', 'pending', 'check'].includes(status)) return status;
  return status || 'unknown';
}

function providerTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
}

async function persistStrategySnapshot(groupId, normalized, nextQueryAt) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const storedStatus = normalized.status === 'expired' ? 'failed' : normalized.status;
    const result = await client.query(
      `UPDATE strategy_groups
       SET status = $2, provider_status = $3, strategy_status = $4,
           provider_params = $5, close_amount_raw = COALESCE($6, close_amount_raw),
           close_output_amount_raw = COALESCE($7, close_output_amount_raw),
           close_tx_hash = COALESCE($8, close_tx_hash),
           close_price = COALESCE($9, close_price),
           close_time = COALESCE($10, close_time),
           last_reconciled_at = NOW(), next_query_at = $11,
           query_count = query_count + 1, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        groupId,
        storedStatus,
        normalized.providerStatus,
        normalized.strategyStatus,
        normalized.raw || {},
        normalized.closeAmountRaw,
        normalized.closeOutputAmountRaw,
        normalized.closeTxHash,
        normalized.closePrice,
        providerTimestamp(normalized.closeTime),
        nextQueryAt
      ]
    );
    const group = result.rows[0];
    if (!group) {
      const error = new Error(`Strategy group ${groupId} not found`);
      error.code = 'STRATEGY_GROUP_NOT_FOUND';
      throw error;
    }
    for (let index = 0; index < normalized.conditionOrders.length; index += 1) {
      const condition = normalized.conditionOrders[index];
      await client.query(
        `INSERT INTO strategy_legs
          (group_id, provider_order_id, leg_index, order_type, amount_raw,
           trigger_value, status, strategy_status, requested_params, provider_params,
           filled_amount_raw, last_reconciled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,$10,NOW())
         ON CONFLICT (group_id, leg_index) DO UPDATE
         SET provider_order_id = COALESCE(EXCLUDED.provider_order_id, strategy_legs.provider_order_id),
             order_type = EXCLUDED.order_type,
             amount_raw = EXCLUDED.amount_raw,
             trigger_value = EXCLUDED.trigger_value,
             status = EXCLUDED.status,
             strategy_status = EXCLUDED.strategy_status,
             provider_params = EXCLUDED.provider_params,
             filled_amount_raw = EXCLUDED.filled_amount_raw,
             last_reconciled_at = NOW(), updated_at = NOW()`,
        [
          groupId,
          String(condition.cid || '').trim() || null,
          index,
          condition.order_type || 'unknown',
          strategyLegAmountRaw(group.total_amount_raw, condition),
          condition.check_price || condition.price_scale || null,
          normalizeLegStatus(condition.status),
          normalized.strategyStatus,
          condition,
          normalizeLegStatus(condition.status) === 'success'
            ? strategyLegAmountRaw(group.total_amount_raw, condition)
            : '0'
        ]
      );
    }
    if (['cancelled', 'failed'].includes(storedStatus) && !normalized.closeTxHash) {
      await client.query(
        `UPDATE position_lots SET reserved_by_strategy_raw = '0',
         last_reconciled_at = NOW(), updated_at = NOW() WHERE position_id = $1`,
        [group.position_id]
      );
      await client.query(
        `UPDATE positions SET status = 'open_unprotected', updated_at = NOW()
         WHERE id = $1 AND status = 'open_protected'`,
        [group.position_id]
      );
      if (storedStatus === 'failed') {
        await writeOutbox(client, 'strategy.failed', 'strategy_group', groupId, {
          strategy_group_id: groupId,
          position_id: group.position_id,
          provider_status: normalized.providerStatus
        });
      }
    }
    await client.query('COMMIT');
    return group;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function claimStrategyClose(groupId, normalized) {
  if (!normalized.closeTxHash || !/^\d+$/.test(String(normalized.closeAmountRaw || ''))
      || BigInt(normalized.closeAmountRaw) <= 0n) {
    const error = new Error('Triggered strategy lacks close_sign_hash or exact close_amount');
    error.code = 'STRATEGY_CLOSE_FACTS_INCOMPLETE';
    throw error;
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT strategy_group.*, position.chain_id, position.contract_address,
              position.signal_id, position.whitelist_id, position.status AS position_status,
              lot.wallet_address, lot.token_decimals
       FROM strategy_groups AS strategy_group
       JOIN positions AS position ON position.id = strategy_group.position_id
       JOIN LATERAL (
         SELECT wallet_address, token_decimals FROM position_lots
         WHERE position_id = position.id ORDER BY id ASC LIMIT 1
       ) AS lot ON true
       WHERE strategy_group.id = $1
       FOR UPDATE OF strategy_group, position`,
      [groupId]
    );
    const group = result.rows[0];
    if (!group) throw new Error(`Strategy group ${groupId} not found`);

    const idempotencyKey = `position:${group.position_id}:strategy-close:${groupId}:${normalized.closeTxHash}`;
    const existing = await client.query(
      `SELECT attempt.*, orders.id AS order_id
       FROM trade_attempts AS attempt
       LEFT JOIN trade_orders AS orders ON orders.attempt_id = attempt.id
       WHERE attempt.idempotency_key = $1`,
      [idempotencyKey]
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return { attempt: existing.rows[0], orderId: existing.rows[0].order_id, existing: true };
    }

    const active = await client.query(
      `SELECT * FROM trade_attempts
       WHERE position_id = $1 AND side = 'sell'
         AND status IN ('reserved','preparing','submitting','submitted','confirming','submission_uncertain')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [group.position_id]
    );
    if (active.rows.length > 0) {
      const attempt = active.rows[0];
      if (['reserved', 'preparing'].includes(attempt.status)) {
        await client.query(
          `UPDATE trade_attempts
           SET status = 'reconciliation_required', error_code = 'STRATEGY_TRIGGERED_DURING_MANUAL_CLOSE',
               requires_manual_review = true, last_reconciled_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [attempt.id]
        );
        await addAttemptEvent(client, attempt.id, attempt.status, 'reconciliation_required', {
          reason: 'Protection strategy triggered before manual close submitted'
        });
      }
      await client.query(
        `UPDATE positions SET status = 'close_uncertain', updated_at = NOW() WHERE id = $1`,
        [group.position_id]
      );
      await writeOutbox(client, 'strategy.manual_close_conflict', 'position', group.position_id, {
        position_id: group.position_id,
        strategy_group_id: groupId,
        manual_attempt_id: attempt.id,
        manual_attempt_status: attempt.status,
        close_tx_hash: normalized.closeTxHash
      });
      await client.query('COMMIT');
      return { conflict: true, activeAttemptId: attempt.id, activeAttemptStatus: attempt.status };
    }

    const chain = requireChain(group.chain_id);
    const closeOutputRaw = /^\d+$/.test(String(normalized.closeOutputAmountRaw || ''))
      ? String(normalized.closeOutputAmountRaw)
      : null;
    const closeAt = providerTimestamp(normalized.closeTime) || new Date();
    const attemptResult = await client.query(
      `INSERT INTO trade_attempts
        (signal_id, whitelist_id, position_id, side, idempotency_key, chain,
         wallet_address, input_token, output_token, input_amount_raw,
         input_amount_display, output_amount_raw, status, request_fingerprint,
         metadata, submitted_at, last_reconciled_at)
       VALUES ($1,$2,$3,'sell',$4,$5,$6,$7,$8,$9,$10,$11,'confirming',$12,$13,$14,NOW())
       RETURNING *`,
      [
        group.signal_id,
        group.whitelist_id,
        group.position_id,
        idempotencyKey,
        group.chain_id,
        group.wallet_address,
        group.contract_address,
        chain.nativeToken,
        normalized.closeAmountRaw,
        rawToDecimal(normalized.closeAmountRaw, group.token_decimals, 18),
        closeOutputRaw,
        fingerprint({ strategy_group_id: groupId, close_tx_hash: normalized.closeTxHash }),
        {
          source: 'gmgn_strategy',
          strategy_group_id: groupId,
          strategy_provider_order_id: group.provider_order_id,
          strategy_terminal: normalized.providerStatus === 'closed',
          token_decimals: group.token_decimals
        },
        closeAt
      ]
    );
    const attempt = attemptResult.rows[0];
    const report = {
      input_amount: normalized.closeAmountRaw,
      output_amount: closeOutputRaw,
      input_token_decimals: group.token_decimals,
      output_token_decimals: normalized.quoteDecimals ?? chain.decimals,
      price_usd: normalized.closePrice,
      strategy_order_id: group.provider_order_id,
      order_statistic: normalized.orderStatistic
    };
    const orderResult = await client.query(
      `INSERT INTO trade_orders
        (attempt_id, provider_order_id, tx_hash, provider_status, normalized_status,
         input_token, output_token, input_amount_raw, output_amount_raw,
         input_decimals, output_decimals, price_usd, report_json, last_response_json,
         submitted_at, next_query_at)
       VALUES ($1,$2,$3,$4,'chain_verifying',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       RETURNING *`,
      [
        attempt.id,
        `strategy:${group.provider_order_id || groupId}:${normalized.closeTxHash}`,
        normalized.closeTxHash,
        normalized.providerStatus || 'closed',
        group.contract_address,
        chain.nativeToken,
        normalized.closeAmountRaw,
        closeOutputRaw,
        group.token_decimals,
        normalized.quoteDecimals ?? chain.decimals,
        normalized.closePrice,
        report,
        normalized.raw || {},
        closeAt
      ]
    );
    await client.query(
      `UPDATE strategy_groups
       SET status = 'triggered', close_attempt_id = $2,
           close_amount_raw = $3, close_output_amount_raw = COALESCE($4, close_output_amount_raw),
           close_tx_hash = $5, close_time = $6,
           last_reconciled_at = NOW(), next_query_at = NOW() + INTERVAL '15 seconds', updated_at = NOW()
       WHERE id = $1`,
      [groupId, attempt.id, normalized.closeAmountRaw, closeOutputRaw, normalized.closeTxHash, closeAt]
    );
    await client.query(
      `UPDATE positions SET status = 'closing', updated_at = NOW() WHERE id = $1`,
      [group.position_id]
    );
    await addAttemptEvent(client, attempt.id, null, 'confirming', {
      providerRequestId: group.provider_order_id,
      summary: { strategy_group_id: groupId, close_tx_hash: normalized.closeTxHash }
    });
    await writeOutbox(client, 'strategy.triggered', 'strategy_group', groupId, {
      strategy_group_id: groupId,
      position_id: group.position_id,
      attempt_id: attempt.id,
      close_tx_hash: normalized.closeTxHash,
      close_amount_raw: normalized.closeAmountRaw
    });
    await client.query('COMMIT');
    return { attempt, orderId: orderResult.rows[0].id, existing: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function backfillLegacyPosition(positionId, facts) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const positionResult = await client.query(
      `SELECT * FROM positions WHERE id = $1 AND execution_mode = 'live' FOR UPDATE`,
      [positionId]
    );
    const position = positionResult.rows[0];
    if (!position) throw new Error(`Legacy live position ${positionId} not found`);
    const chain = requireChain(position.chain_id);
    const openedAmountRaw = decimalToRaw(position.amount_out, facts.tokenDecimals);
    const inputAmountRaw = decimalToRaw(position.amount_in, chain.decimals);
    const attemptResult = await client.query(
      `SELECT * FROM trade_attempts WHERE position_id = $1 AND side = 'buy'
       ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      [positionId]
    );
    const attempt = attemptResult.rows[0];
    if (!attempt) throw new Error(`Legacy position ${positionId} has no buy attempt`);
    const orderResult = await client.query(
      `SELECT * FROM trade_orders WHERE attempt_id = $1 ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      [attempt.id]
    );
    const order = orderResult.rows[0];
    if (!order) throw new Error(`Legacy position ${positionId} has no buy order`);

    await client.query(
      `UPDATE trade_attempts
       SET wallet_address = $2, input_token = $3, output_token = $4,
           input_amount_raw = $5, output_amount_raw = $6,
           metadata = metadata || $7::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [attempt.id, facts.walletAddress, chain.nativeToken, position.contract_address,
        inputAmountRaw, openedAmountRaw,
        { token_decimals: facts.tokenDecimals, legacy_backfill_verified: true }]
    );
    await client.query(
      `UPDATE trade_orders
       SET input_token = $2, output_token = $3,
           input_amount_raw = $4, output_amount_raw = $5,
           input_decimals = $6, output_decimals = $7,
           last_response_json = last_response_json || $8::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, chain.nativeToken, position.contract_address, inputAmountRaw,
        openedAmountRaw, chain.decimals, facts.tokenDecimals,
        { legacy_backfill_verified: true }]
    );
    await client.query(
      `INSERT INTO position_lots
        (position_id, buy_order_id, chain, wallet_address, token_address,
         token_decimals, opened_amount_raw, remaining_amount_raw,
         reserved_by_strategy_raw, cost_native, cost_usd, fee_native,
         opened_at, last_reconciled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'0',$8,$9,$10,$11,NOW())
       ON CONFLICT (buy_order_id) WHERE buy_order_id IS NOT NULL
       DO UPDATE SET wallet_address = EXCLUDED.wallet_address,
                     token_address = EXCLUDED.token_address,
                     token_decimals = EXCLUDED.token_decimals,
                     updated_at = NOW()`,
      [position.id, order.id, chain.id, facts.walletAddress, position.contract_address,
        facts.tokenDecimals, openedAmountRaw, position.amount_in,
        Number(position.entry_price || 0) * Number(position.amount_out || 0),
        facts.buyFeeNative || 0, position.opened_at]
    );

    const strategy = facts.strategy || null;
    if (strategy?.providerOrderId) {
      const storedStatus = strategy.status === 'expired' ? 'failed' : strategy.status;
      const groupResult = await client.query(
        `INSERT INTO strategy_groups
          (position_id, attempt_id, provider_order_id, total_amount_raw, status,
           requested_params, provider_params, provider_status, strategy_status,
           close_amount_raw, close_tx_hash, close_price, close_time,
           last_reconciled_at, next_query_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
         ON CONFLICT (provider_order_id) WHERE provider_order_id IS NOT NULL
         DO UPDATE SET provider_params = EXCLUDED.provider_params,
                       provider_status = EXCLUDED.provider_status,
                       strategy_status = EXCLUDED.strategy_status,
                       status = EXCLUDED.status,
                       last_reconciled_at = NOW(), updated_at = NOW()
         RETURNING *`,
        [
          position.id,
          attempt.id,
          strategy.providerOrderId,
          strategy.openAmountRaw || openedAmountRaw,
          storedStatus,
          { sell_ratio_type: 'buy_amount', legacy_backfill_verified: true },
          strategy.raw || {},
          strategy.providerStatus,
          strategy.strategyStatus,
          strategy.closeAmountRaw,
          strategy.closeTxHash,
          strategy.closePrice,
          providerTimestamp(strategy.closeTime)
        ]
      );
      const group = groupResult.rows[0];
      for (let index = 0; index < strategy.conditionOrders.length; index += 1) {
        const condition = strategy.conditionOrders[index];
        await client.query(
          `INSERT INTO strategy_legs
            (group_id, provider_order_id, leg_index, order_type, amount_raw,
             trigger_value, status, strategy_status, requested_params, provider_params,
             filled_amount_raw, last_reconciled_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,NOW())
           ON CONFLICT (group_id, leg_index) DO NOTHING`,
          [group.id, String(condition.cid || '').trim() || null, index,
            condition.order_type || 'unknown',
            strategyLegAmountRaw(group.total_amount_raw, condition),
            condition.check_price || condition.price_scale || null,
            normalizeLegStatus(condition.status), strategy.strategyStatus,
            condition,
            normalizeLegStatus(condition.status) === 'success'
              ? strategyLegAmountRaw(group.total_amount_raw, condition)
              : '0']
        );
      }
      if (storedStatus === 'running') {
        await client.query(
          `UPDATE position_lots SET reserved_by_strategy_raw = remaining_amount_raw,
           updated_at = NOW() WHERE position_id = $1`,
          [position.id]
        );
        await client.query(
          `UPDATE positions SET status = 'open_protected', tpsl_status = 'ok', updated_at = NOW()
           WHERE id = $1`,
          [position.id]
        );
      } else if (['cancelled', 'failed'].includes(storedStatus)) {
        await client.query(
          `UPDATE positions SET status = 'open_unprotected', tpsl_status = 'failed', updated_at = NOW()
           WHERE id = $1 AND status <> 'closed'`,
          [position.id]
        );
      }
    }
    await client.query('COMMIT');
    return { positionId: position.id, attemptId: attempt.id, orderId: order.id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getPositionBalanceState(positionId) {
  const result = await db.query(
    `SELECT position.id AS position_id, position.chain_id, position.contract_address,
            position.status AS position_status,
            position.opened_at,
            MIN(lot.wallet_address) AS wallet_address,
            MIN(lot.token_decimals) AS token_decimals,
            COALESCE(SUM(lot.remaining_amount_raw::numeric), 0)::text AS remaining_amount_raw,
            MAX(lot.last_reconciled_at) AS last_balance_checked_at,
            (SELECT COUNT(*)::int FROM strategy_groups AS strategy
             WHERE strategy.position_id = position.id
               AND strategy.status IN ('pending','running','partially_filled','triggered','cancelling','unknown'))
              AS active_strategy_count
     FROM positions AS position
     JOIN position_lots AS lot ON lot.position_id = position.id
     WHERE position.id = $1
     GROUP BY position.id`,
    [positionId]
  );
  return result.rows[0] || null;
}

async function listDuePositionBalances(limit = 10) {
  const result = await db.query(
    `SELECT position.id
     FROM positions AS position
     WHERE position.execution_mode = 'live'
       AND position.status IN ('open','open_protected','open_unprotected','partially_closed')
       AND EXISTS (
         SELECT 1 FROM position_lots AS lot
         WHERE lot.position_id = position.id
           AND (lot.last_reconciled_at IS NULL
             OR lot.last_reconciled_at < NOW() - INTERVAL '120 seconds')
       )
     ORDER BY position.updated_at ASC
     LIMIT $1`,
    [Math.min(100, Math.max(1, Number(limit)))]
  );
  return result.rows;
}

async function observePositionBalance(positionId, actualBalanceRaw) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const lots = await client.query(
      `SELECT * FROM position_lots WHERE position_id = $1 ORDER BY id ASC FOR UPDATE`,
      [positionId]
    );
    const remaining = lots.rows.reduce(
      (total, lot) => total + BigInt(lot.remaining_amount_raw),
      0n
    );
    const actual = BigInt(String(actualBalanceRaw));
    const external = actual > remaining ? actual - remaining : 0n;
    for (let index = 0; index < lots.rows.length; index += 1) {
      await client.query(
        `UPDATE position_lots
         SET externally_changed_amount_raw = $2,
             last_reconciled_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [lots.rows[index].id, index === 0 ? external.toString() : '0']
      );
    }
    await client.query('COMMIT');
    return {
      remainingRaw: remaining.toString(),
      actualRaw: actual.toString(),
      deficitRaw: actual < remaining ? (remaining - actual).toString() : '0',
      externalRaw: external.toString()
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function markPositionBalanceMismatch(positionId, details) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE positions SET status = 'close_uncertain', updated_at = NOW()
       WHERE id = $1 AND status IN ('open','open_protected','open_unprotected','partially_closed')`,
      [positionId]
    );
    await writeOutbox(client, 'position.wallet_balance_mismatch', 'position', positionId, {
      position_id: positionId,
      ...details
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function claimExternalClose(positionId, activity) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const positionResult = await client.query(
      `SELECT * FROM positions WHERE id = $1 FOR UPDATE`,
      [positionId]
    );
    const position = positionResult.rows[0];
    if (!position) throw new Error(`Position ${positionId} not found for external close`);
    const lotsResult = await client.query(
      `SELECT * FROM position_lots WHERE position_id = $1 ORDER BY id ASC FOR UPDATE`,
      [positionId]
    );
    if (lotsResult.rows.length === 0) throw new Error(`Position ${positionId} has no lots`);
    const walletAddress = lotsResult.rows[0].wallet_address;
    const tokenDecimals = Number(lotsResult.rows[0].token_decimals);
    if (!lotsResult.rows.every((lot) => lot.wallet_address === walletAddress
        && Number(lot.token_decimals) === tokenDecimals)) {
      const error = new Error('Position lots disagree on wallet or token decimals');
      error.code = 'POSITION_LOT_MISMATCH';
      throw error;
    }
    const remainingAmountRaw = lotsResult.rows.reduce(
      (total, lot) => total + BigInt(lot.remaining_amount_raw),
      0n
    );
    if (BigInt(activity.inputAmountRaw) > remainingAmountRaw) {
      const error = new Error('External sell exceeds tracked position lots');
      error.code = 'EXTERNAL_SELL_EXCEEDS_POSITION';
      throw error;
    }
    const idempotencyKey = `position:${positionId}:external-sell:${activity.txHash}`;
    const existing = await client.query(
      `SELECT attempt.*, orders.id AS order_id FROM trade_attempts AS attempt
       LEFT JOIN trade_orders AS orders ON orders.attempt_id = attempt.id
       WHERE attempt.idempotency_key = $1`,
      [idempotencyKey]
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return { attempt: existing.rows[0], orderId: existing.rows[0].order_id, existing: true };
    }
    const active = await client.query(
      `SELECT id FROM trade_attempts WHERE position_id = $1 AND side = 'sell'
       AND status IN ('reserved','preparing','submitting','submitted','confirming','submission_uncertain')
       LIMIT 1`,
      [positionId]
    );
    if (active.rows.length > 0) {
      const error = new Error(`Position already has active sell attempt #${active.rows[0].id}`);
      error.code = 'SELL_ATTEMPT_EXISTS';
      throw error;
    }
    const chain = requireChain(position.chain_id);
    const attemptResult = await client.query(
      `INSERT INTO trade_attempts
        (signal_id, whitelist_id, position_id, side, idempotency_key, chain,
         wallet_address, input_token, output_token, input_amount_raw,
         input_amount_display, output_amount_raw, output_amount_display,
         status, request_fingerprint, metadata, submitted_at, last_reconciled_at)
       VALUES ($1,$2,$3,'sell',$4,$5,$6,$7,$8,$9,$10,$11,$12,
               'confirming',$13,$14,$15,NOW()) RETURNING *`,
      [position.signal_id, position.whitelist_id, position.id, idempotencyKey,
        position.chain_id, walletAddress, position.contract_address,
        chain.nativeToken, activity.inputAmountRaw,
        rawToDecimal(activity.inputAmountRaw, tokenDecimals, 18),
        activity.outputAmountRaw,
        activity.outputAmountRaw
          ? rawToDecimal(activity.outputAmountRaw, activity.outputDecimals, 18)
          : null,
        fingerprint({ source: 'gmgn_wallet_activity', tx_hash: activity.txHash }),
        { source: 'gmgn_wallet_activity', provider_activity: activity.raw || {} },
        activity.submittedAt]
    );
    const attempt = attemptResult.rows[0];
    const report = {
      input_amount: activity.inputAmountRaw,
      output_amount: activity.outputAmountRaw,
      input_token_decimals: tokenDecimals,
      output_token_decimals: activity.outputDecimals,
      price_usd: activity.priceUsd,
      gas_native: activity.gasNative
    };
    const orderResult = await client.query(
      `INSERT INTO trade_orders
        (attempt_id, provider_order_id, tx_hash, provider_status, normalized_status,
         input_token, output_token, input_amount_raw, output_amount_raw,
         input_decimals, output_decimals, price_usd, gas_native,
         report_json, last_response_json, submitted_at, next_query_at)
       VALUES ($1,$2,$3,'confirmed','chain_verifying',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       RETURNING *`,
      [attempt.id, `activity:${activity.txHash}`, activity.txHash,
        position.contract_address, chain.nativeToken,
        activity.inputAmountRaw, activity.outputAmountRaw,
        tokenDecimals, activity.outputDecimals,
        activity.priceUsd, activity.gasNative, report, activity.raw || {}, activity.submittedAt]
    );
    await client.query(
      `UPDATE positions SET status = 'closing', updated_at = NOW() WHERE id = $1`,
      [positionId]
    );
    await addAttemptEvent(client, attempt.id, null, 'confirming', {
      summary: { source: 'gmgn_wallet_activity', tx_hash: activity.txHash }
    });
    await writeOutbox(client, 'position.external_sell_detected', 'position', positionId, {
      position_id: positionId,
      attempt_id: attempt.id,
      tx_hash: activity.txHash,
      input_amount_raw: activity.inputAmountRaw
    });
    await client.query('COMMIT');
    return { attempt, orderId: orderResult.rows[0].id, existing: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateStrategyGroupStatus(groupId, expectedStatuses, nextStatus, providerParams = {}) {
  const result = await db.query(
    `UPDATE strategy_groups
     SET status = $1,
         provider_params = provider_params || $2::jsonb,
         last_reconciled_at = NOW(), updated_at = NOW()
     WHERE id = $3 AND status = ANY($4::text[])
     RETURNING *`,
    [nextStatus, providerParams, groupId, expectedStatuses]
  );
  if (result.rows.length === 0) {
    const error = new Error(`Strategy group ${groupId} state changed concurrently`);
    error.code = 'STRATEGY_GROUP_CAS_FAILED';
    throw error;
  }
  return result.rows[0];
}

async function failOrder(orderId, normalizedOrder) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT orders.*, attempt.signal_id, attempt.whitelist_id, attempt.position_id,
              attempt.side, attempt.status AS attempt_status
       FROM trade_orders AS orders
       JOIN trade_attempts AS attempt ON attempt.id = orders.attempt_id
       WHERE orders.id = $1 FOR UPDATE`,
      [orderId]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Trade order not found');
    await client.query(
      `UPDATE trade_orders SET normalized_status = $2, provider_status = $3,
       last_response_json = $4, updated_at = NOW() WHERE id = $1`,
      [orderId, normalizedOrder.status, normalizedOrder.providerStatus, normalizedOrder.raw || {}]
    );
    await client.query(
      `UPDATE trade_attempts SET status = 'failed', error_code = $2,
       last_reconciled_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [row.attempt_id, normalizedOrder.errorCode || `GMGN_ORDER_${normalizedOrder.status.toUpperCase()}`]
    );
    const reservation = await client.query(
      `UPDATE budget_reservations SET status = 'released', released_at = NOW(), updated_at = NOW()
       WHERE attempt_id = $1 AND status = 'reserved' RETURNING *`,
      [row.attempt_id]
    );
    if (reservation.rows[0]) {
      const item = reservation.rows[0];
      await client.query(
        `INSERT INTO budget_ledger
          (reservation_id, attempt_id, whitelist_id, chain, entry_type,
           amount_native, fee_native, amount_usd_snapshot, reason)
         VALUES ($1,$2,$3,$4,'release',$5,$6,$7,$8)`,
        [item.id, row.attempt_id, item.whitelist_id, item.chain, item.amount_native,
          item.fee_native, item.amount_usd_snapshot, normalizedOrder.errorCode || 'ORDER_FAILED']
      );
    }
    if (row.side === 'sell') {
      await client.query(
        `UPDATE positions
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM strategy_groups
                 WHERE position_id = $1 AND status IN ('running','partially_filled','triggered')
               ) THEN 'open_protected'
               ELSE 'open_unprotected'
             END,
             updated_at = NOW()
         WHERE id = $1 AND status IN ('closing','close_uncertain')`,
        [row.position_id]
      );
      await writeOutbox(client, 'position.close_failed', 'position', row.position_id, {
        position_id: row.position_id,
        attempt_id: row.attempt_id,
        code: normalizedOrder.errorCode || 'ORDER_FAILED'
      });
    } else {
      await client.query(
        `UPDATE trade_signals SET status = 'rejected', reject_reason = $2, updated_at = NOW()
         WHERE id = $1`,
        [row.signal_id, normalizedOrder.errorCode || 'ORDER_FAILED']
      );
    }
    await addAttemptEvent(client, row.attempt_id, row.attempt_status, 'failed', {
      reason: normalizedOrder.errorCode || normalizedOrder.providerStatus
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getAttempt(attemptId) {
  const result = await db.query('SELECT * FROM trade_attempts WHERE id = $1', [attemptId]);
  return result.rows[0] || null;
}

async function getAttemptDetails(attemptId) {
  const result = await db.query(
    `SELECT attempt.*,
            COALESCE((
              SELECT json_agg(orders ORDER BY orders.id)
              FROM trade_orders AS orders WHERE orders.attempt_id = attempt.id
            ), '[]') AS orders,
            COALESCE((
              SELECT json_agg(events ORDER BY events.id)
              FROM trade_attempt_events AS events WHERE events.attempt_id = attempt.id
            ), '[]') AS events,
            COALESCE((
              SELECT json_agg(strategy_group ORDER BY strategy_group.id)
              FROM strategy_groups AS strategy_group
              WHERE strategy_group.attempt_id = attempt.id
                 OR strategy_group.position_id = attempt.position_id
            ), '[]') AS strategy_groups,
            COALESCE((
              SELECT json_agg(strategy_leg ORDER BY strategy_leg.group_id, strategy_leg.leg_index)
              FROM strategy_legs AS strategy_leg
              JOIN strategy_groups AS strategy_group ON strategy_group.id = strategy_leg.group_id
              WHERE strategy_group.attempt_id = attempt.id
                 OR strategy_group.position_id = attempt.position_id
            ), '[]') AS strategy_legs,
            COALESCE((
              SELECT json_agg(position_lot ORDER BY position_lot.id)
              FROM position_lots AS position_lot
              WHERE position_lot.position_id = attempt.position_id
            ), '[]') AS position_lots,
            COALESCE((
              SELECT json_agg(chain_receipt ORDER BY chain_receipt.id)
              FROM chain_receipts AS chain_receipt
              JOIN trade_orders AS receipt_order ON receipt_order.id = chain_receipt.order_id
              WHERE receipt_order.attempt_id = attempt.id
            ), '[]') AS chain_receipts
     FROM trade_attempts AS attempt
     WHERE attempt.id = $1`,
    [attemptId]
  );
  return result.rows[0] || null;
}

async function listAttempts(limit = 100) {
  const result = await db.query(
    `SELECT attempt.*,
            orders.id AS order_id, orders.provider_order_id, orders.tx_hash,
            orders.provider_status, orders.normalized_status AS order_status,
             orders.last_queried_at, orders.next_query_at, orders.query_count,
             CASE
               WHEN orders.normalized_status IN ('confirmed','failed','expired') THEN 'stopped'
               WHEN NOW() - orders.submitted_at < INTERVAL '10 seconds' THEN 'hot_1s'
               WHEN NOW() - orders.submitted_at < INTERVAL '30 seconds' THEN 'warm_2s'
               WHEN NOW() - orders.submitted_at < INTERVAL '120 seconds' THEN 'cool_5s'
               ELSE 'stable_15_30s'
             END AS query_stage
     FROM trade_attempts AS attempt
     LEFT JOIN LATERAL (
       SELECT * FROM trade_orders WHERE attempt_id = attempt.id ORDER BY id DESC LIMIT 1
     ) orders ON true
     ORDER BY attempt.created_at DESC LIMIT $1`,
    [Math.min(500, Math.max(1, Number(limit)))]
  );
  return result.rows;
}

module.exports = {
  addAttemptEvent,
  backfillLegacyPosition,
  claimExternalClose,
  claimStrategyClose,
  createBuyAttempt,
  createSellAttempt,
  fingerprint,
  getAttempt,
  getAttemptDetails,
  getPositionForClose,
  getPositionBalanceState,
  getSignalForExecution,
  failOrder,
  finalizeConfirmedOrder,
  listAttempts,
  listDueOrders,
  listDuePositionBalances,
  listDueStrategyGroups,
  listUncertainAttempts,
  markSubmissionUncertain,
  markSellUncertain,
  markPositionBalanceMismatch,
  observePositionBalance,
  recordSubmittedOrder,
  releaseRejectedAttempt,
  rejectSellAttempt,
  resolveCancelledCloseAttempt,
  saveChainReceipt,
  sellSettlementOutputRaw,
  persistStrategySnapshot,
  principalUsdCost,
  strategyLegAmountRaw,
  transitionAttempt,
  touchAttemptReconciliation,
  updateOrderAfterQuery,
  updateStrategyGroupStatus,
  writeOutbox
};
