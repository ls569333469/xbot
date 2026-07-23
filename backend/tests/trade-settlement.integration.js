const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');
const repository = require('../domains/trade/trade-repository');
const gmgnAdapter = require('../lib/gmgn-adapter');

const createdPositions = [];

async function createPosition(suffix, status = 'open_unprotected') {
  const result = await db.query(
    `INSERT INTO positions
      (contract_address, chain_id, symbol, amount_in, amount_out, entry_price,
       execution_mode, status, opened_at)
     VALUES ($1,'sol',$2,1,100,0.01,'live',$3,NOW()) RETURNING *`,
    [`SettlementToken${suffix}`, `SET${suffix}`, status]
  );
  createdPositions.push(result.rows[0].id);
  await db.query(
    `INSERT INTO position_lots
      (position_id, chain, wallet_address, token_address, token_decimals,
       opened_amount_raw, remaining_amount_raw, cost_native)
     VALUES ($1,'sol',$2,$3,6,'100000000','100000000',1)`,
    [result.rows[0].id, `Wallet${suffix}`, `SettlementToken${suffix}`]
  );
  return result.rows[0];
}

test('confirmed partial sell updates lot, proceeds, and PnL without closing the position', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const position = await createPosition(suffix);
  const attempt = (await db.query(
    `INSERT INTO trade_attempts
      (position_id, side, idempotency_key, chain, wallet_address,
       input_token, output_token, input_amount_raw, status, request_fingerprint, metadata)
     VALUES ($1,'sell',$2,'sol',$3,$4,$5,'40000000','confirming',$6,'{}') RETURNING *`,
    [position.id, `partial-sell-${suffix}`, `Wallet${suffix}`, `SettlementToken${suffix}`,
      'So11111111111111111111111111111111111111112', `fingerprint-${suffix}`]
  )).rows[0];
  const order = (await db.query(
    `INSERT INTO trade_orders
      (attempt_id, provider_order_id, tx_hash, provider_status, normalized_status,
       input_token, output_token, input_amount_raw, output_amount_raw,
       input_decimals, output_decimals, report_json)
     VALUES ($1,$2,$3,'confirmed','chain_verifying',$4,$5,'40000000','500000000',6,9,$6)
     RETURNING *`,
    [attempt.id, `partial-order-${suffix}`, `partial-hash-${suffix}`,
      `SettlementToken${suffix}`, 'So11111111111111111111111111111111111111112',
      { input_amount: '40000000', output_amount: '500000000', input_token_decimals: 6, output_token_decimals: 9 }]
  )).rows[0];
  const normalized = gmgnAdapter.normalizeOrder({
    order_id: order.provider_order_id,
    status: 'confirmed',
    hash: order.tx_hash,
    report: order.report_json
  });
  const receipt = {
    status: 'confirmed',
    nativeBalanceDeltaRaw: '500000000',
    transfers: {
      preTokenBalances: [{ mint: `SettlementToken${suffix}`, owner: `Wallet${suffix}`, uiTokenAmount: { amount: '100000000' } }],
      postTokenBalances: [{ mint: `SettlementToken${suffix}`, owner: `Wallet${suffix}`, uiTokenAmount: { amount: '60000000' } }]
    }
  };
  const settled = await repository.finalizeConfirmedOrder(order.id, normalized, receipt);
  assert.equal(settled.status, 'partially_closed');
  const lot = (await db.query(
    `SELECT remaining_amount_raw, realized_cost_native, realized_proceeds_native
     FROM position_lots WHERE position_id = $1`,
    [position.id]
  )).rows[0];
  assert.equal(lot.remaining_amount_raw, '60000000');
  assert.equal(Number(lot.realized_cost_native), 0.4);
  assert.equal(Number(lot.realized_proceeds_native), 0.5);
  const storedPosition = (await db.query('SELECT status, pnl, pnl_pct FROM positions WHERE id = $1', [position.id])).rows[0];
  assert.equal(storedPosition.status, 'partially_closed');
  assert.equal(Number(storedPosition.pnl), 0.1);
  assert.equal(Number(storedPosition.pnl_pct), 25);
});

test('strategy trigger claims ownership before a prepared manual close can submit', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const position = await createPosition(suffix, 'open_protected');
  const manual = (await db.query(
    `INSERT INTO trade_attempts
      (position_id, side, idempotency_key, chain, wallet_address,
       input_token, output_token, input_amount_raw, status, request_fingerprint, metadata)
     VALUES ($1,'sell',$2,'sol',$3,$4,$5,'100000000','preparing',$6,'{}') RETURNING *`,
    [position.id, `manual-sell-${suffix}`, `Wallet${suffix}`, `SettlementToken${suffix}`,
      'So11111111111111111111111111111111111111112', `manual-fingerprint-${suffix}`]
  )).rows[0];
  const group = (await db.query(
    `INSERT INTO strategy_groups
      (position_id, provider_order_id, total_amount_raw, status)
     VALUES ($1,$2,'100000000','triggered') RETURNING *`,
    [position.id, `strategy-${suffix}`]
  )).rows[0];
  const claim = await repository.claimStrategyClose(group.id, {
    providerStatus: 'closed',
    strategyStatus: 'stopped',
    closeAmountRaw: '100000000',
    closeOutputAmountRaw: '1000000000',
    closeTxHash: `strategy-close-${suffix}`,
    closePrice: 0.01,
    closeTime: Date.now(),
    quoteDecimals: 9,
    orderStatistic: {},
    raw: {}
  });
  assert.equal(claim.conflict, true);
  const storedManual = (await db.query('SELECT status, error_code FROM trade_attempts WHERE id = $1', [manual.id])).rows[0];
  assert.equal(storedManual.status, 'reconciliation_required');
  assert.equal(storedManual.error_code, 'STRATEGY_TRIGGERED_DURING_MANUAL_CLOSE');
  const orders = await db.query('SELECT COUNT(*)::int AS count FROM trade_orders WHERE attempt_id = $1', [manual.id]);
  assert.equal(orders.rows[0].count, 0);
});

test.after(async () => {
  if (createdPositions.length > 0) {
    const attempts = await db.query('SELECT id FROM trade_attempts WHERE position_id = ANY($1::int[])', [createdPositions]);
    const attemptIds = attempts.rows.map((row) => row.id);
    if (attemptIds.length > 0) await db.query('DELETE FROM trade_attempts WHERE id = ANY($1::bigint[])', [attemptIds]);
    await db.query("DELETE FROM notification_outbox WHERE aggregate_type IN ('position','strategy_group') AND aggregate_id = ANY($1::text[])", [createdPositions.map(String)]);
    await db.query('DELETE FROM positions WHERE id = ANY($1::int[])', [createdPositions]);
  }
  await db.pool.end();
});
