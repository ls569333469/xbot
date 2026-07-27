const db = require('../../lib/db');
const { CHAIN_REGISTRY } = require('../../lib/chain-config');
const { normalizedWallet, laneKey, walletWriteLane } = require('./wallet-write-lane');
const { ledgerUsdAmount, unusedFeeEnvelope } = require('./budget-accounting');
const { tradeCircuitBreaker } = require('./trade-circuit-breaker');
const { codeVersion } = require('../../lib/code-version');

const ACTIVE_INTENT_STATUSES = [
  'created', 'submitting', 'awaiting_result', 'retry_verifying',
  'retry_scheduled', 'uncertain'
];

function normalizedContract(chain, address) {
  const value = String(address || '').trim();
  return chain === 'sol' ? value : value.toLowerCase();
}

function buyKeys({ signalId, chain, walletAddress, contractAddress }) {
  const wallet = normalizedWallet(chain, walletAddress);
  const contract = normalizedContract(chain, contractAddress);
  return {
    sourceKey: `buy:signal:${signalId}`,
    scopeKey: `buy:${chain}:${wallet}:${contract}`,
    wallet,
    contract,
    walletLaneKey: laneKey(chain, wallet)
  };
}

function sellScopeKey(positionId) {
  return `sell:${Number(positionId)}`;
}

function retryDelayMs(chain, nextAttemptNo) {
  const delays = chain === 'eth' ? [500, 1000] : [250, 500];
  return delays[Math.max(0, Math.min(delays.length - 1, Number(nextAttemptNo) - 2))];
}

function retryPolicy(chain, chainConfig = {}) {
  const defaults = CHAIN_REGISTRY[chain]?.retryDefault || {
    enabled: false, maxRetries: 0, retryWindowMs: 30000, failureEvidenceWindowMs: 30000
  };
  return {
    retryEnabled: Boolean(chainConfig.retryEnabled),
    maxRetries: Math.max(0, Math.min(2, Number(chainConfig.maxRetries ?? defaults.maxRetries) || 0)),
    retryWindowMs: Math.max(1000, Number(chainConfig.retryWindowMs ?? defaults.retryWindowMs)),
    failureEvidenceWindowMs: Math.max(
      5000,
      Number(chainConfig.failureEvidenceWindowMs ?? defaults.failureEvidenceWindowMs)
    ),
    feeEscalationEnabled: Boolean(chainConfig.feeEscalationEnabled),
    maxRetryFeeNative: Math.max(0, Number(chainConfig.maxRetryFeeNative || 0)),
    exitGasReserve: Math.max(0, Number(chainConfig.exitGasReserve || 0))
  };
}

async function recordSource(executor, intent, sourceKey, signalId, merged, source = {}) {
  await executor.query(
    `INSERT INTO trade_intent_sources(intent_id, source_key, signal_id, source_json, merged)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (source_key) DO NOTHING`,
    [intent.id, sourceKey, signalId || null, source, Boolean(merged)]
  );
}

async function createBuyIntent(executor, prepared, signal, chainConfig) {
  const chain = prepared.chain.id;
  const keys = buyKeys({
    signalId: signal.signal_id,
    chain,
    walletAddress: prepared.wallet.address,
    contractAddress: signal.contract_address
  });
  const policy = retryPolicy(chain, chainConfig);
  const inserted = await executor.query(
    `INSERT INTO trade_intents(
       source_key, scope_key, side, signal_id, whitelist_id, chain,
       wallet_address, contract_address, wallet_lane_key, status,
       max_retries, expires_at, principal_amount_raw, principal_amount_display,
       slippage_cap, config_snapshot_json
     ) VALUES (
       $1,$2,'buy',$3,$4,$5,$6,$7,$8,'created',$9,
       NOW() + ($10::double precision * interval '1 millisecond'),
       $11,$12,$13,$14
     ) ON CONFLICT DO NOTHING RETURNING *`,
    [
      keys.sourceKey, keys.scopeKey, signal.signal_id, signal.whitelist_id, chain,
      keys.wallet, keys.contract, keys.walletLaneKey,
      policy.retryEnabled ? policy.maxRetries : 0,
      policy.retryWindowMs,
      prepared.inputAmountRaw,
      prepared.budgetNative,
      Number(signal.slippage),
      {
        chain_config: { ...chainConfig, ...policy },
        snapshot_hash: prepared.snapshotHash,
        code_version: codeVersion()
      }
    ]
  );
  const created = Boolean(inserted.rows[0]);
  let intent = inserted.rows[0];
  let merged = false;
  if (!intent) {
    const existing = await executor.query(
      `SELECT * FROM trade_intents
       WHERE source_key = $1
          OR (scope_key = $2 AND status = ANY($3::text[]))
       ORDER BY (source_key = $1) DESC, id DESC LIMIT 1`,
      [keys.sourceKey, keys.scopeKey, ACTIVE_INTENT_STATUSES]
    );
    intent = existing.rows[0];
    if (!intent) {
      const error = new Error('Trade intent conflicted but could not be recovered');
      error.code = 'TRADE_INTENT_CONFLICT';
      throw error;
    }
    merged = String(intent.source_key) !== keys.sourceKey;
  }
  await recordSource(executor, intent, keys.sourceKey, signal.signal_id, merged, {
    provider: signal.provider || null,
    activity_type: signal.activity_type || null,
    kol_handle: signal.kol_handle || null
  });
  if (merged) {
    await executor.query(
      `UPDATE trade_signals SET status = 'rejected',
       reject_reason = 'MERGED_INTO_ACTIVE_TRADE_INTENT', updated_at = NOW()
       WHERE id = $1`,
      [signal.signal_id]
    );
  }
  return {
    intent,
    created,
    merged,
    duplicate: !created && !merged
  };
}

async function createSellIntent(executor, prepared, chainConfig) {
  const positionId = Number(prepared.position.id);
  const scopeKey = sellScopeKey(positionId);
  const active = await executor.query(
    `SELECT * FROM trade_intents
     WHERE scope_key = $1 AND status = ANY($2::text[])
     ORDER BY id DESC LIMIT 1`,
    [scopeKey, ACTIVE_INTENT_STATUSES]
  );
  if (active.rows[0]) return { intent: active.rows[0], merged: true };

  const generation = await executor.query(
    `SELECT COALESCE(MAX(close_generation), 0)::int + 1 AS generation
     FROM trade_intents WHERE position_id = $1 AND side = 'sell'`,
    [positionId]
  );
  const closeGeneration = Number(generation.rows[0].generation);
  const sourceKey = `sell:position:${positionId}:close:${closeGeneration}`;
  const chain = prepared.chain.id;
  const wallet = normalizedWallet(chain, prepared.wallet.address);
  const contract = normalizedContract(chain, prepared.position.contract_address);
  const policy = retryPolicy(chain, chainConfig);
  const inserted = await executor.query(
    `INSERT INTO trade_intents(
       source_key, scope_key, side, signal_id, position_id, whitelist_id,
       close_generation, chain, wallet_address, contract_address,
       wallet_lane_key, status, max_retries, expires_at,
       principal_amount_raw, principal_amount_display, slippage_cap,
       config_snapshot_json
     ) VALUES (
       $1,$2,'sell',$3,$4,$5,$6,$7,$8,$9,$10,'created',$11,
       NOW() + ($12::double precision * interval '1 millisecond'),
       $13,$14,$15,$16
     ) RETURNING *`,
    [
      sourceKey, scopeKey, prepared.position.signal_id, positionId,
      prepared.position.whitelist_id, closeGeneration, chain, wallet, contract,
      laneKey(chain, wallet), policy.retryEnabled ? policy.maxRetries : 0,
      policy.retryWindowMs, prepared.inputAmountRaw, prepared.inputAmountDisplay,
      prepared.slippage,
      {
        chain_config: { ...chainConfig, ...policy },
        snapshot_hash: prepared.snapshotHash,
        code_version: codeVersion()
      }
    ]
  );
  await recordSource(executor, inserted.rows[0], sourceKey, prepared.position.signal_id, false, {
    position_id: positionId,
    close_generation: closeGeneration
  });
  return { intent: inserted.rows[0], merged: false };
}

async function insertAttempt(executor, intent, values = {}) {
  const sequence = await executor.query(
    `SELECT COALESCE(MAX(attempt_no), 0)::int + 1 AS attempt_no
     FROM trade_attempts WHERE intent_id = $1`,
    [intent.id]
  );
  const attemptNo = Number(sequence.rows[0].attempt_no);
  const previous = attemptNo > 1
    ? (await executor.query(
      'SELECT id FROM trade_attempts WHERE intent_id = $1 AND attempt_no = $2',
      [intent.id, attemptNo - 1]
    )).rows[0]
    : null;
  const result = await executor.query(
    `INSERT INTO trade_attempts(
       intent_id, attempt_no, retry_of_attempt_id, signal_id, whitelist_id,
       position_id, side, idempotency_key, chain, wallet_address,
       input_token, output_token, input_amount_raw, input_amount_display,
       status, request_fingerprint, metadata, fee_escalation_level
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
     ) RETURNING *`,
    [
      intent.id, attemptNo, previous?.id || null,
      values.signalId || intent.signal_id, values.whitelistId || intent.whitelist_id,
      values.positionId || intent.position_id, intent.side,
      `intent:${intent.id}:attempt:${attemptNo}`,
      intent.chain, intent.wallet_address, values.inputToken, values.outputToken,
      values.inputAmountRaw, values.inputAmountDisplay, values.status || 'reserved',
      values.requestFingerprint, values.metadata || {}, Math.max(0, attemptNo - 1)
    ]
  );
  return result.rows[0];
}

async function savePreSubmitSnapshot(attemptId, snapshot, estimatedFeeNative = null, executor = db) {
  const result = await executor.query(
    `UPDATE trade_attempts
     SET pre_submit_snapshot_json = $2, estimated_fee_native = $3,
         updated_at = NOW()
     WHERE id = $1 AND pre_submit_snapshot_json = '{}'::jsonb
       AND status IN('reserved','preparing')
     RETURNING *`,
    [attemptId, snapshot, estimatedFeeNative]
  );
  if (!result.rows[0]) {
    const error = new Error('Pre-submit snapshot is already sealed or attempt is not writable');
    error.code = 'PRE_SUBMIT_SNAPSHOT_SEALED';
    throw error;
  }
  return result.rows[0];
}

async function setIntentStatusForAttempt(executor, attemptId, expected, status, details = {}) {
  const result = await executor.query(
    `UPDATE trade_intents AS intent
     SET status = $3, last_error_code = COALESCE($4, last_error_code),
         next_retry_at = CASE
           WHEN $3 = 'retry_scheduled' THEN $5::timestamptz
           ELSE NULL::timestamptz
         END,
         retry_claimed_at = CASE WHEN $3 = 'retry_verifying' THEN NOW() ELSE NULL END,
         completed_at = CASE WHEN $3 = ANY($6::text[]) THEN NOW() ELSE NULL END,
         updated_at = NOW()
     FROM trade_attempts AS attempt
     WHERE attempt.id = $1 AND attempt.intent_id = intent.id
       AND intent.status = ANY($2::text[])
     RETURNING intent.*`,
    [
      attemptId, expected, status, details.errorCode || null, details.nextRetryAt || null,
      ['confirmed', 'exhausted', 'rejected', 'cancelled']
    ]
  );
  return result.rows[0] || null;
}

async function releaseIntentBudget(executor, intentId, attemptId, reason) {
  const released = await executor.query(
    `UPDATE budget_reservations
     SET status = 'released', released_at = NOW(), updated_at = NOW()
     WHERE intent_id = $1 AND status = 'reserved' RETURNING *`,
    [intentId]
  );
  if (released.rows[0]) {
    const item = released.rows[0];
    const unusedFee = unusedFeeEnvelope(item);
    await executor.query(
      `INSERT INTO budget_ledger(
         reservation_id, intent_id, attempt_id, whitelist_id, chain, entry_type,
         amount_native, fee_native, amount_usd_snapshot, reason
       ) VALUES ($1,$2,$3,$4,$5,'release',$6,$7,$8,$9)`,
      [
        item.id, intentId, attemptId, item.whitelist_id, item.chain,
        item.amount_native, unusedFee,
        ledgerUsdAmount(item, item.amount_native, unusedFee), reason
      ]
    );
  }
  return released.rows[0] || null;
}

async function scheduleAfterDefinitiveFailure(attemptId, failure, executor = db) {
  const client = executor.pool ? await executor.pool.connect() : executor;
  const ownsClient = Boolean(executor.pool);
  try {
    if (ownsClient) await client.query('BEGIN');
    const result = await client.query(
      `SELECT attempt.*, intent.status AS intent_status, intent.max_retries,
              intent.retry_count, intent.expires_at, intent.side AS intent_side,
              (intent.expires_at IS NOT NULL AND intent.expires_at > NOW()) AS within_window
       FROM trade_attempts AS attempt
       JOIN trade_intents AS intent ON intent.id = attempt.intent_id
       WHERE attempt.id = $1 FOR UPDATE OF attempt, intent`,
      [attemptId]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Trade attempt not found');
    if (row.status === 'definitive_failed_no_fill') {
      if (ownsClient) await client.query('COMMIT');
      return { status: row.intent_status, duplicate: true };
    }
    await client.query(
      `UPDATE trade_attempts
       SET status = 'definitive_failed_no_fill', failure_class = $2,
           failure_evidence_json = $3, retry_eligible = true,
           retry_decided_at = NOW(), actual_fee_native = COALESCE($4, actual_fee_native),
           last_reconciled_at = NOW(), next_reconcile_at = NOW() + INTERVAL '30 seconds',
           terminal_audit_until = COALESCE(terminal_audit_until, NOW() + INTERVAL '7 days'),
           updated_at = NOW()
       WHERE id = $1`,
      [attemptId, failure.failureClass || 'CHAIN_DEFINITIVE_FAILURE', failure.evidence || {}, failure.actualFeeNative]
    );
    await client.query(
      `UPDATE trade_orders SET normalized_status = 'definitive_failed_no_fill',
       updated_at = NOW() WHERE attempt_id = $1`,
      [attemptId]
    );
    const riskConfigResult = await client.query(
      "SELECT value_json FROM config WHERE key = 'risk_config'"
    );
    const failureCircuit = await tradeCircuitBreaker.recordDefinitiveFailure(
      row.chain,
      attemptId,
      riskConfigResult.rows[0]?.value_json?.consecutive_failure_lock,
      client
    );
    let feeEnvelopeAvailable = true;
    const actualFee = Number(failure.actualFeeNative || 0);
    if (actualFee > 0) {
      const reservation = await client.query(
        `UPDATE budget_reservations
         SET fee_used_native = fee_used_native + $2, updated_at = NOW()
         WHERE intent_id = $1 RETURNING *`,
        [row.intent_id, actualFee]
      );
      if (reservation.rows[0]) {
        const item = reservation.rows[0];
        feeEnvelopeAvailable = Number(item.fee_used_native) <= Number(item.fee_native);
        await client.query(
          `INSERT INTO budget_ledger(
             reservation_id, intent_id, attempt_id, whitelist_id, chain,
             entry_type, amount_native, fee_native, amount_usd_snapshot, reason
           ) VALUES ($1,$2,$3,$4,$5,'fee_commit',0,$6,$7,'FAILED_ATTEMPT_GAS')`,
          [
            item.id,
            row.intent_id,
            attemptId,
            item.whitelist_id,
            item.chain,
            actualFee,
            ledgerUsdAmount(item, 0, actualFee)
          ]
        );
      } else {
        await client.query(
          `INSERT INTO budget_ledger(
             reservation_id, intent_id, attempt_id, whitelist_id, chain,
             entry_type, amount_native, fee_native, amount_usd_snapshot, reason
           ) VALUES (NULL,$1,$2,$3,$4,'fee_commit',0,$5,$6,'FAILED_ATTEMPT_GAS')`,
          [
            row.intent_id,
            attemptId,
            row.whitelist_id,
            row.chain,
            actualFee,
            failure.actualFeeUsd ?? null
          ]
        );
      }
    }
    const circuitAllowsRetry = row.intent_side === 'sell' || failureCircuit.state !== 'tripped';
    const canRetry = Number(row.retry_count) < Number(row.max_retries)
      && Boolean(row.within_window) && feeEnvelopeAvailable && circuitAllowsRetry;
    const decision = canRetry ? 'retry_scheduled' : 'exhausted';
    const decisionReason = failure.errorCode || (!feeEnvelopeAvailable
      ? 'RETRY_FEE_ENVELOPE_EXHAUSTED'
      : !circuitAllowsRetry
        ? 'CHAIN_CONSECUTIVE_FAILURE_LOCK'
        : 'DEFINITIVE_FAILED_NO_FILL');
    await client.query(
      `UPDATE trade_attempts SET retry_eligible = $2 WHERE id = $1`,
      [attemptId, canRetry]
    );
    const intentUpdate = await client.query(
      `UPDATE trade_intents
       SET status = $2,
           next_retry_at = CASE WHEN $2 = 'retry_scheduled'
             THEN NOW() + ($3::double precision * interval '1 millisecond') ELSE NULL END,
           last_error_code = $4,
           completed_at = CASE WHEN $2 = 'exhausted' THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1 RETURNING next_retry_at`,
      [
        row.intent_id,
        decision,
        retryDelayMs(row.chain, Number(row.attempt_no) + 1),
        decisionReason
      ]
    );
    const nextRetryAt = intentUpdate.rows[0]?.next_retry_at || null;
    await client.query(
      `INSERT INTO trade_retry_decisions(
         intent_id, attempt_id, decision, reason_code, evidence_json, code_version
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        row.intent_id, attemptId, decision,
        decisionReason, failure.evidence || {},
        codeVersion()
      ]
    );
    if (!canRetry) {
      if (row.intent_side === 'buy') {
        await releaseIntentBudget(client, row.intent_id, attemptId, 'RETRY_EXHAUSTED');
      } else if (row.position_id) {
        await client.query(
          `UPDATE positions SET status = 'open_unprotected', updated_at = NOW()
           WHERE id = $1 AND status IN('closing','close_uncertain')`,
          [row.position_id]
        );
      }
    }
    await walletWriteLane.resolveEvidenceQuarantine(attemptId, client);
    if (ownsClient) await client.query('COMMIT');
    return { status: decision, nextRetryAt, intentId: row.intent_id };
  } catch (error) {
    if (ownsClient) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

async function markUncertain(attempt, reasonCode, evidence = {}, executor = db) {
  await executor.query(
    `UPDATE trade_attempts
     SET status = CASE WHEN status = 'submission_uncertain' THEN status ELSE 'reconciliation_required' END,
         failure_class = 'UNCERTAIN', failure_evidence_json = $2,
         retry_eligible = false, requires_manual_review = true,
         error_code = $3, last_reconciled_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [attempt.id, evidence, reasonCode]
  );
  await executor.query(
    `UPDATE trade_intents SET status = 'uncertain', last_error_code = $2,
     next_retry_at = NULL, updated_at = NOW() WHERE id = $1`,
    [attempt.intent_id, reasonCode]
  );
  await executor.query(
    `INSERT INTO trade_retry_decisions(
       intent_id, attempt_id, decision, reason_code, evidence_json, code_version
     ) VALUES ($1,$2,'uncertain',$3,$4,$5)`,
    [
      attempt.intent_id, attempt.id, reasonCode, evidence,
      codeVersion()
    ]
  );
}

async function restoreAbandonedClaims(executor = db) {
  const result = await executor.query(
    `UPDATE trade_intents
     SET status = 'retry_scheduled', retry_claimed_at = NULL,
         next_retry_at = NOW(), updated_at = NOW()
     WHERE status = 'retry_verifying' AND retry_claimed_at < NOW() - INTERVAL '30 seconds'
       AND NOT EXISTS (
         SELECT 1 FROM trade_attempts AS attempt
         WHERE attempt.intent_id = trade_intents.id
           AND attempt.status IN('reserved','preparing','submitting')
       )
     RETURNING id`
  );
  return result.rows;
}

async function recoverStalePreSubmitAttempts(staleAfterSeconds = 90, limit = 50, executor = db) {
  const client = await executor.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT attempt.*, intent.side AS intent_side,
              intent.position_id AS intent_position_id
       FROM trade_attempts AS attempt
       JOIN trade_intents AS intent ON intent.id = attempt.intent_id
       WHERE attempt.status IN('reserved','preparing')
         AND attempt.funds_write_started_at IS NULL
         AND attempt.updated_at < NOW() - ($1::double precision * interval '1 second')
         AND intent.status IN('created','submitting','retry_verifying')
       ORDER BY attempt.updated_at ASC
       FOR UPDATE OF attempt, intent SKIP LOCKED
       LIMIT $2`,
      [Math.max(30, Number(staleAfterSeconds) || 90), Math.min(100, Math.max(1, Number(limit) || 50))]
    );
    for (const attempt of result.rows) {
      await client.query(
        `UPDATE trade_attempts
         SET status = 'superseded', error_code = 'PRE_SUBMIT_PROCESS_INTERRUPTED',
             retry_eligible = false, updated_at = NOW()
         WHERE id = $1`,
        [attempt.id]
      );
      await client.query(
        `UPDATE trade_intents
         SET status = 'cancelled', last_error_code = 'PRE_SUBMIT_PROCESS_INTERRUPTED',
             next_retry_at = NULL, retry_claimed_at = NULL,
             completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [attempt.intent_id]
      );
      await client.query(
        `INSERT INTO trade_attempt_events(
           attempt_id, from_status, to_status, reason, actor, summary
         ) VALUES ($1,$2,'superseded','PRE_SUBMIT_PROCESS_INTERRUPTED','recovery',$3)`,
        [attempt.id, attempt.status, { funds_write_started: false }]
      );
      if (attempt.intent_side === 'buy') {
        await releaseIntentBudget(
          client,
          attempt.intent_id,
          attempt.id,
          'PRE_SUBMIT_PROCESS_INTERRUPTED'
        );
        if (attempt.signal_id) {
          await client.query(
            `UPDATE trade_signals
             SET status = 'rejected', reject_reason = 'PRE_SUBMIT_PROCESS_INTERRUPTED',
                 updated_at = NOW()
             WHERE id = $1`,
            [attempt.signal_id]
          );
        }
      } else if (attempt.intent_position_id) {
        await client.query(
          `UPDATE positions
           SET status = CASE WHEN EXISTS (
             SELECT 1 FROM strategy_groups
             WHERE position_id = $1
               AND status IN('pending','running','partially_filled','triggered')
           ) THEN 'open_protected' ELSE 'open_unprotected' END,
           updated_at = NOW()
           WHERE id = $1 AND status IN('closing','close_uncertain')`,
          [attempt.intent_position_id]
        );
      }
    }
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function expireScheduledRetries(limit = 50, executor = db) {
  const client = await executor.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT intent.*,
              (SELECT id FROM trade_attempts
               WHERE intent_id = intent.id ORDER BY attempt_no DESC LIMIT 1) AS attempt_id
       FROM trade_intents AS intent
       WHERE intent.status = 'retry_scheduled'
         AND intent.expires_at IS NOT NULL AND intent.expires_at <= NOW()
       ORDER BY intent.expires_at ASC
       FOR UPDATE OF intent SKIP LOCKED LIMIT $1`,
      [Math.min(100, Math.max(1, Number(limit) || 50))]
    );
    for (const intent of result.rows) {
      await client.query(
        `UPDATE trade_intents
         SET status = 'exhausted', last_error_code = 'RETRY_WINDOW_EXPIRED',
             next_retry_at = NULL, retry_claimed_at = NULL,
             completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [intent.id]
      );
      if (intent.attempt_id) {
        await client.query(
          `INSERT INTO trade_retry_decisions(
             intent_id, attempt_id, decision, reason_code, evidence_json, code_version
           ) VALUES ($1,$2,'exhausted','RETRY_WINDOW_EXPIRED','{}',$3)`,
          [intent.id, intent.attempt_id, codeVersion()]
        );
      }
      if (intent.side === 'buy') {
        await releaseIntentBudget(
          client,
          intent.id,
          intent.attempt_id,
          'RETRY_WINDOW_EXPIRED'
        );
      } else if (intent.position_id) {
        await client.query(
          `UPDATE positions SET status = 'open_unprotected', updated_at = NOW()
           WHERE id = $1 AND status IN('closing','close_uncertain')`,
          [intent.position_id]
        );
      }
    }
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function claimDueRetries(limit = 10, executor = db) {
  const client = await executor.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `WITH due AS (
       SELECT id FROM trade_intents
       WHERE status = 'retry_scheduled' AND next_retry_at <= NOW()
         AND (expires_at IS NULL OR expires_at > NOW())
         AND NOT EXISTS (
           SELECT 1 FROM wallet_write_lanes AS lane
           WHERE lane.chain = trade_intents.chain
             AND lane.wallet_address = trade_intents.wallet_address
             AND lane.state <> 'idle'
         )
         AND NOT EXISTS (
           SELECT 1 FROM chain_trade_circuits AS circuit
           WHERE trade_intents.side = 'buy'
             AND circuit.chain = trade_intents.chain
             AND circuit.state = 'tripped'
         )
       ORDER BY next_retry_at ASC FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE trade_intents AS intent
       SET status = 'retry_verifying', retry_claimed_at = NOW(), updated_at = NOW()
       FROM due WHERE intent.id = due.id RETURNING intent.*`,
      [Math.min(50, Math.max(1, Number(limit)))]
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createRetryAttempt(intentId, values, executor = db) {
  const client = await executor.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT * FROM trade_intents WHERE id = $1 FOR UPDATE`,
      [intentId]
    );
    const intent = result.rows[0];
    if (!intent || intent.status !== 'retry_verifying') {
      const error = new Error('Trade intent is not claimed for retry');
      error.code = 'RETRY_INTENT_NOT_CLAIMED';
      throw error;
    }
    if (Number(intent.retry_count) >= Number(intent.max_retries)) {
      const error = new Error('Trade intent retry count is exhausted');
      error.code = 'RETRY_COUNT_EXHAUSTED';
      throw error;
    }
    const attempt = await insertAttempt(client, intent, values);
    await client.query(
      `INSERT INTO trade_attempt_events(
         attempt_id, from_status, to_status, reason, actor, summary
       ) VALUES ($1,NULL,'reserved','DEFINITIVE_FAILURE_RETRY',$2,$3)`,
      [attempt.id, values.actor || 'retry-worker', {
        intent_id: intent.id,
        attempt_no: attempt.attempt_no,
        retry_of_attempt_id: attempt.retry_of_attempt_id
      }]
    );
    await client.query(
      `UPDATE trade_intents SET retry_count = $2, updated_at = NOW()
       WHERE id = $1`,
      [intent.id, Number(attempt.attempt_no) - 1]
    );
    await client.query('COMMIT');
    return attempt;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function finishRetryClaim(intentId, status, reasonCode, executor = db) {
  const client = await executor.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE trade_intents SET status = $2, last_error_code = $3,
       next_retry_at = NULL, retry_claimed_at = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'retry_verifying' RETURNING *`,
      [intentId, status, reasonCode]
    );
    if (result.rows[0]?.side === 'buy') {
      const attempt = await client.query(
        'SELECT id FROM trade_attempts WHERE intent_id = $1 ORDER BY attempt_no DESC LIMIT 1',
        [intentId]
      );
      await releaseIntentBudget(client, intentId, attempt.rows[0]?.id, reasonCode);
    }
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getIntent(intentId, executor = db) {
  const result = await executor.query('SELECT * FROM trade_intents WHERE id = $1', [intentId]);
  return result.rows[0] || null;
}

module.exports = {
  ACTIVE_INTENT_STATUSES,
  buyKeys,
  claimDueRetries,
  createBuyIntent,
  createRetryAttempt,
  createSellIntent,
  expireScheduledRetries,
  finishRetryClaim,
  getIntent,
  insertAttempt,
  markUncertain,
  normalizedContract,
  recordSource,
  recoverStalePreSubmitAttempts,
  releaseIntentBudget,
  restoreAbandonedClaims,
  retryDelayMs,
  retryPolicy,
  savePreSubmitSnapshot,
  scheduleAfterDefinitiveFailure,
  sellScopeKey,
  setIntentStatusForAttempt
};
