const crypto = require('crypto');
const { codeVersion } = require('../../lib/code-version');

const MIGRATION_NAME = '016_p14_chain_approval_and_acceptance_scope.sql';

function evidenceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pathComplete(path) {
  return Boolean(
    path
    && path.intent_status === 'confirmed'
    && path.attempt_status === 'confirmed'
    && path.order_status === 'confirmed'
    && path.receipt_status === 'confirmed'
    && path.tx_hash
    && path.receipt_tx_hash === path.tx_hash
  );
}

function summarizeManualE2e(facts) {
  const missing = [];
  if (facts.position?.status !== 'closed') missing.push('POSITION_NOT_CLOSED');
  if (number(facts.position?.lot_count) < 1) missing.push('POSITION_LOT_MISSING');
  if (number(facts.position?.remaining_raw) !== 0) missing.push('POSITION_LOT_NOT_ZERO');
  if (!pathComplete(facts.buy)) missing.push('BUY_PATH_INCOMPLETE');
  if (!pathComplete(facts.sell)) missing.push('SELL_PATH_INCOMPLETE');
  if (number(facts.strategy?.strategy_count) < 1) missing.push('STRATEGY_EVIDENCE_MISSING');
  if (number(facts.strategy?.active_count) > 0) missing.push('STRATEGY_NOT_TERMINAL');

  const reservation = facts.budget || null;
  if (reservation?.reservation_status !== 'committed') {
    missing.push('BUDGET_RESERVATION_NOT_COMMITTED');
  }
  const ledgerTypes = new Set(reservation?.ledger_types || []);
  if (!ledgerTypes.has('reserve')) missing.push('BUDGET_RESERVE_LEDGER_MISSING');
  if (!ledgerTypes.has('commit')) missing.push('BUDGET_COMMIT_LEDGER_MISSING');
  const unusedFee = Math.max(0,
    number(reservation?.fee_native) - number(reservation?.fee_used_native));
  if (unusedFee > 1e-18 && number(reservation?.released_fee_native) + 1e-18 < unusedFee) {
    missing.push('BUDGET_FEE_RELEASE_INCOMPLETE');
  }

  return {
    complete: missing.length === 0,
    missing,
    code_version: codeVersion(),
    position: facts.position ? {
      id: Number(facts.position.id),
      status: facts.position.status,
      lot_count: number(facts.position.lot_count),
      remaining_raw: String(facts.position.remaining_raw || '0')
    } : null,
    buy: facts.buy ? {
      intent_id: Number(facts.buy.intent_id),
      attempt_id: Number(facts.buy.attempt_id),
      order_id: Number(facts.buy.order_id),
      tx_hash: facts.buy.tx_hash,
      receipt_id: Number(facts.buy.receipt_id),
      receipt_status: facts.buy.receipt_status
    } : null,
    sell: facts.sell ? {
      intent_id: Number(facts.sell.intent_id),
      attempt_id: Number(facts.sell.attempt_id),
      order_id: Number(facts.sell.order_id),
      tx_hash: facts.sell.tx_hash,
      receipt_id: Number(facts.sell.receipt_id),
      receipt_status: facts.sell.receipt_status
    } : null,
    strategy: {
      count: number(facts.strategy?.strategy_count),
      active_count: number(facts.strategy?.active_count),
      groups: facts.strategy?.groups || []
    },
    budget: reservation ? {
      reservation_id: Number(reservation.reservation_id),
      status: reservation.reservation_status,
      fee_native: String(reservation.fee_native || '0'),
      fee_used_native: String(reservation.fee_used_native || '0'),
      ledger_types: reservation.ledger_types || [],
      released_fee_native: String(reservation.released_fee_native || '0')
    } : null
  };
}

async function loadManualE2eFacts(executor, positionId, sellOrderId) {
  const position = (await executor.query(
    `SELECT position.id, position.whitelist_id, position.chain_id, position.status,
            COUNT(lot.id)::int AS lot_count,
            COALESCE(SUM(lot.remaining_amount_raw::numeric), 0)::text AS remaining_raw
     FROM positions AS position
     LEFT JOIN position_lots AS lot ON lot.position_id = position.id
     WHERE position.id = $1
     GROUP BY position.id`,
    [positionId]
  )).rows[0] || null;

  const paths = (await executor.query(
    `SELECT intent.id AS intent_id, intent.status AS intent_status,
            attempt.id AS attempt_id, attempt.side, attempt.status AS attempt_status,
            orders.id AS order_id, orders.tx_hash,
            orders.normalized_status AS order_status,
            receipt.id AS receipt_id, receipt.tx_hash AS receipt_tx_hash,
            receipt.receipt_status
     FROM trade_attempts AS attempt
     JOIN trade_intents AS intent ON intent.id = attempt.intent_id
     JOIN trade_orders AS orders ON orders.attempt_id = attempt.id
     LEFT JOIN chain_receipts AS receipt ON receipt.order_id = orders.id
     WHERE attempt.position_id = $1
       AND ((attempt.side = 'buy' AND attempt.status = 'confirmed')
         OR (attempt.side = 'sell' AND orders.id = $2))
     ORDER BY CASE WHEN attempt.side = 'buy' THEN 0 ELSE 1 END,
              attempt.attempt_no, orders.id`,
    [positionId, sellOrderId]
  )).rows;
  const buy = paths.find((item) => item.side === 'buy') || null;
  const sell = paths.find((item) => item.side === 'sell' && Number(item.order_id) === Number(sellOrderId)) || null;

  const strategy = (await executor.query(
    `SELECT COUNT(*)::int AS strategy_count,
            COUNT(*) FILTER (WHERE status IN(
              'pending','running','partially_filled','triggered','cancelling','unknown'
            ))::int AS active_count,
            COALESCE(jsonb_agg(jsonb_build_object(
              'id', id, 'status', status, 'strategy_status', strategy_status,
              'provider_order_id', provider_order_id
            ) ORDER BY id), '[]'::jsonb) AS groups
     FROM strategy_groups WHERE position_id = $1`,
    [positionId]
  )).rows[0] || null;

  let budget = null;
  if (buy?.intent_id) {
    budget = (await executor.query(
      `SELECT reservation.id AS reservation_id,
              reservation.status AS reservation_status,
              reservation.fee_native, reservation.fee_used_native,
              COALESCE(array_agg(DISTINCT ledger.entry_type)
                FILTER (WHERE ledger.entry_type IS NOT NULL), ARRAY[]::text[]) AS ledger_types,
              COALESCE(SUM(ledger.fee_native)
                FILTER (WHERE ledger.entry_type = 'release'), 0) AS released_fee_native
       FROM budget_reservations AS reservation
       LEFT JOIN budget_ledger AS ledger ON ledger.reservation_id = reservation.id
       WHERE reservation.intent_id = $1
       GROUP BY reservation.id`,
      [buy.intent_id]
    )).rows[0] || null;
  }
  return { position, buy, sell, strategy, budget };
}

async function persistManualE2eEvidence(executor, positionId, sellOrderId) {
  const facts = await loadManualE2eFacts(executor, positionId, sellOrderId);
  const summary = summarizeManualE2e(facts);
  if (!facts.position) return { status: 'failed', summary };
  const status = summary.complete ? 'passed' : 'failed';
  const hash = evidenceHash({
    type: 'manual_e2e',
    chain: facts.position.chain_id,
    positionId: Number(positionId),
    sellOrderId: Number(sellOrderId),
    status,
    summary
  });
  await executor.query(
    `INSERT INTO chain_readiness_evidence(
       chain, evidence_type, whitelist_id, status, evidence_hash,
       summary_json, migration_name, code_version, created_by
     ) VALUES ($1,'manual_e2e',$2,$3,$4,$5,$6,$7,'confirmed_settlement')
     ON CONFLICT (evidence_hash) DO NOTHING`,
    [
      facts.position.chain_id,
      facts.position.whitelist_id,
      status,
      hash,
      summary,
      MIGRATION_NAME,
      codeVersion()
    ]
  );
  return { status, summary };
}

module.exports = {
  MIGRATION_NAME,
  loadManualE2eFacts,
  pathComplete,
  persistManualE2eEvidence,
  summarizeManualE2e
};
