const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');
const repository = require('../domains/trade/trade-repository');
const { compileExitStrategy } = require('../domains/trade/exit-strategy-compiler');

const cleanup = {
  kolId: null,
  activityId: null,
  whitelistId: null,
  signalId: null,
  intentId: null,
  positionId: null
};

test('confirmed position keeps the exit strategy captured when the buy attempt was created', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const originalStrategy = {
    version: 1,
    sell_ratio_type: 'buy_amount',
    legs: [{ type: 'take_profit', trigger_pct: 100, sell_pct: 50 }]
  };
  const changedStrategy = {
    version: 1,
    sell_ratio_type: 'buy_amount',
    legs: [
      { type: 'take_profit', trigger_pct: 500, sell_pct: 100 },
      { type: 'stop_loss', drop_pct: 30, sell_pct: 100 }
    ]
  };
  const compiled = compileExitStrategy(originalStrategy);

  await db.query(
    `UPDATE chain_live_readiness
     SET implemented = true, contract_tested = true, live_enabled = true, updated_at = NOW()
     WHERE chain = 'sol'`
  );
  cleanup.kolId = (await db.query(
    `INSERT INTO x_kol_accounts(x_user_id, x_handle, enabled)
     VALUES ($1,$2,true) RETURNING id`,
    [`snapshot-kol-${suffix}`, `snapshotkol${suffix}`]
  )).rows[0].id;
  cleanup.whitelistId = (await db.query(
    `INSERT INTO ca_whitelist(
       contract_address, chain_id, symbol, project_name, budget_per_trade,
       total_budget, spent_budget, auto_tp_pct, auto_sl_pct, exit_strategy,
       exit_strategy_version, slippage, status
     ) VALUES ($1,'sol','SNAP','Strategy Snapshot',0.01,1,0,100,20,$2,1,10,'active')
     RETURNING id`,
    [`SnapshotToken${suffix}`, originalStrategy]
  )).rows[0].id;
  cleanup.activityId = (await db.query(
    `INSERT INTO x_activities(
       kol_id, kol_handle, activity_type, provider, source_created_at, processed
     ) VALUES ($1,$2,'tweet','6551',NOW(),true) RETURNING id`,
    [cleanup.kolId, `snapshotkol${suffix}`]
  )).rows[0].id;
  cleanup.signalId = (await db.query(
    `INSERT INTO trade_signals(
       activity_id, whitelist_id, kol_id, kol_handle, signal_type,
       execution_mode, status, matched_relation_ids
     ) VALUES ($1,$2,$3,$4,'ca_mention','live','recorded',ARRAY[1]::bigint[])
     RETURNING id`,
    [cleanup.activityId, cleanup.whitelistId, cleanup.kolId, `snapshotkol${suffix}`]
  )).rows[0].id;

  const created = await repository.createBuyAttempt({
    signal: { signal_id: cleanup.signalId },
    chain: {
      id: 'sol',
      nativeToken: 'So11111111111111111111111111111111111111112',
      nativeSymbol: 'SOL'
    },
    wallet: { address: `SnapshotWallet${suffix}` },
    walletNativeBalance: 10,
    inputAmountRaw: '10000000',
    budgetNative: '0.01',
    feeReserveNative: '0.0002',
    budgetUsdSnapshot: 2,
    snapshotHash: `snapshot-${suffix}`,
    cacheMeta: {},
    conditionOrders: compiled.conditionOrders,
    token: { decimals: 6, symbol: 'SNAP' },
    riskSnapshot: { passed: true }
  });
  cleanup.intentId = created.intent.id;

  await db.query(
    `UPDATE ca_whitelist
     SET auto_tp_pct = 500, auto_sl_pct = 30, exit_strategy = $2,
         exit_strategy_version = 2, updated_at = NOW()
     WHERE id = $1`,
    [cleanup.whitelistId, changedStrategy]
  );

  await repository.transitionAttempt(created.attempt.id, ['reserved'], 'submitting');
  const normalizedOrder = {
    providerOrderId: `snapshot-order-${suffix}`,
    providerStatus: 'success',
    status: 'confirmed',
    txHash: `snapshot-tx-${suffix}`,
    strategyOrderId: `snapshot-strategy-${suffix}`,
    report: {
      inputAmountRaw: '10000000',
      outputAmountRaw: '50000000',
      inputDecimals: 9,
      outputDecimals: 6,
      priceUsd: 0.04,
      gasNative: 0.0001,
      gasUsd: 0.02,
      raw: {}
    },
    raw: {}
  };
  const order = await repository.recordSubmittedOrder(
    created.attempt.id,
    normalizedOrder,
    { raw: {} },
    { status: 200, latencyMs: 10 }
  );
  const position = await repository.finalizeConfirmedOrder(order.id, normalizedOrder, {
    status: 'confirmed',
    confirmations: 1,
    transfers: {},
    raw: {}
  });
  cleanup.positionId = position.id;

  const storedPosition = (await db.query(
    'SELECT tp_pct, sl_pct FROM positions WHERE id = $1',
    [position.id]
  )).rows[0];
  assert.equal(Number(storedPosition.tp_pct), 100);
  assert.equal(storedPosition.sl_pct, null);

  const strategyGroup = (await db.query(
    `SELECT requested_params FROM strategy_groups
     WHERE position_id = $1`,
    [position.id]
  )).rows[0];
  assert.deepEqual(strategyGroup.requested_params.exit_strategy, originalStrategy);
  assert.equal(strategyGroup.requested_params.exit_strategy_version, 1);
  assert.deepEqual(strategyGroup.requested_params.condition_orders, compiled.conditionOrders);
});

test.after(async () => {
  if (cleanup.intentId) {
    await db.query('DELETE FROM trade_attempts WHERE intent_id = $1', [cleanup.intentId]);
    await db.query('DELETE FROM trade_intents WHERE id = $1', [cleanup.intentId]);
  }
  if (cleanup.positionId) {
    await db.query(
      "DELETE FROM notification_outbox WHERE aggregate_type IN ('position','strategy_group') AND aggregate_id = $1",
      [String(cleanup.positionId)]
    );
    await db.query('DELETE FROM positions WHERE id = $1', [cleanup.positionId]);
  }
  if (cleanup.signalId) await db.query('DELETE FROM trade_signals WHERE id = $1', [cleanup.signalId]);
  if (cleanup.activityId) await db.query('DELETE FROM x_activities WHERE id = $1', [cleanup.activityId]);
  if (cleanup.kolId) await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [cleanup.kolId]);
  if (cleanup.whitelistId) await db.query('DELETE FROM ca_whitelist WHERE id = $1', [cleanup.whitelistId]);
  await db.pool.end();
});
