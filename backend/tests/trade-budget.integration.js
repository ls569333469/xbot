const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('./integration-guard');
const db = require('../lib/db');
const repository = require('../domains/trade/trade-repository');

test('global and chain transaction locks prevent concurrent whitelists exceeding a daily budget', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const originalDaily = process.env.GMGN_GLOBAL_DAILY_USD_LIMIT;
  const originalWeekly = process.env.GMGN_GLOBAL_WEEKLY_USD_LIMIT;
  process.env.GMGN_GLOBAL_DAILY_USD_LIMIT = '1000';
  process.env.GMGN_GLOBAL_WEEKLY_USD_LIMIT = '1000';
  const ids = { kol: null, activities: [], whitelists: [], signals: [] };
  const configResult = await db.query("SELECT value_json FROM config WHERE key = 'chain_configs'");
  const originalConfig = configResult.rows[0].value_json;
  const chainConfigs = structuredClone(originalConfig);
  chainConfigs.sol = {
    ...chainConfigs.sol,
    enabled: true,
    dailyBudget: 0.015,
    weeklyBudget: 1,
    maxPerTrade: 0.02,
    maxOpenPositions: 100,
    dailyLossLimit: 100
  };

  try {
    await db.query("UPDATE config SET value_json = $1 WHERE key = 'chain_configs'", [chainConfigs]);
    const kol = await db.query(
      `INSERT INTO x_kol_accounts(x_user_id, x_handle, enabled)
       VALUES ($1,$2,true) RETURNING id`,
      [`p9-budget-${suffix}`, `p9budget${suffix}`]
    );
    ids.kol = kol.rows[0].id;
    const prepared = [];
    for (let index = 0; index < 20; index += 1) {
      const whitelist = await db.query(
        `INSERT INTO ca_whitelist(contract_address, chain_id, symbol, project_name,
          budget_per_trade, total_budget, spent_budget, slippage, status)
         VALUES ($1,'sol',$2,'P9 Budget',0.01,1,0,10,'active') RETURNING id`,
        [`P9Budget${suffix}${index}`, `P9B${index}`]
      );
      ids.whitelists.push(whitelist.rows[0].id);
      const activity = await db.query(
        `INSERT INTO x_activities(kol_id, kol_handle, activity_type, provider, processed)
         VALUES ($1,$2,'tweet','6551',true) RETURNING id`,
        [ids.kol, `p9budget${suffix}`]
      );
      ids.activities.push(activity.rows[0].id);
      const signal = await db.query(
        `INSERT INTO trade_signals(activity_id, whitelist_id, kol_id, kol_handle,
          signal_type, execution_mode, status, matched_relation_ids)
         VALUES ($1,$2,$3,$4,'ca_mention','live','recorded',ARRAY[1]::bigint[]) RETURNING id`,
        [activity.rows[0].id, whitelist.rows[0].id, ids.kol, `p9budget${suffix}`]
      );
      ids.signals.push(signal.rows[0].id);
      prepared.push({
        signal: { signal_id: signal.rows[0].id },
        chain: { id: 'sol', nativeToken: 'So11111111111111111111111111111111111111112', nativeSymbol: 'SOL' },
        wallet: { address: `wallet-${index}` },
        walletNativeBalance: 1,
        inputAmountRaw: '10000000',
        budgetNative: '0.01',
        feeReserveNative: '0',
        budgetUsdSnapshot: 10,
        snapshotHash: `snapshot-${index}`,
        cacheMeta: {},
        conditionOrders: [],
        token: { decimals: 6, symbol: `P9B${index}` },
        riskSnapshot: { passed: true }
      });
    }

    const results = await Promise.allSettled(prepared.map(item => repository.createBuyAttempt(item)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'CHAIN_DAILY_BUDGET_EXCEEDED');
  } finally {
    await db.query("UPDATE config SET value_json = $1 WHERE key = 'chain_configs'", [originalConfig]);
    if (ids.signals.length) await db.query('DELETE FROM trade_attempts WHERE signal_id = ANY($1::int[])', [ids.signals]);
    if (ids.signals.length) await db.query('DELETE FROM trade_signals WHERE id = ANY($1::int[])', [ids.signals]);
    if (ids.activities.length) await db.query('DELETE FROM x_activities WHERE id = ANY($1::int[])', [ids.activities]);
    if (ids.kol) await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [ids.kol]);
    if (ids.whitelists.length) await db.query('DELETE FROM ca_whitelist WHERE id = ANY($1::int[])', [ids.whitelists]);
    if (originalDaily === undefined) delete process.env.GMGN_GLOBAL_DAILY_USD_LIMIT;
    else process.env.GMGN_GLOBAL_DAILY_USD_LIMIT = originalDaily;
    if (originalWeekly === undefined) delete process.env.GMGN_GLOBAL_WEEKLY_USD_LIMIT;
    else process.env.GMGN_GLOBAL_WEEKLY_USD_LIMIT = originalWeekly;
  }
});

test('per-trade and whitelist limits compare principal while reserving fees separately', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const originalDaily = process.env.GMGN_GLOBAL_DAILY_USD_LIMIT;
  const originalWeekly = process.env.GMGN_GLOBAL_WEEKLY_USD_LIMIT;
  process.env.GMGN_GLOBAL_DAILY_USD_LIMIT = '100000';
  process.env.GMGN_GLOBAL_WEEKLY_USD_LIMIT = '100000';
  const configResult = await db.query("SELECT value_json FROM config WHERE key = 'chain_configs'");
  const originalConfig = configResult.rows[0].value_json;
  const chainConfigs = structuredClone(originalConfig);
  chainConfigs.sol = {
    ...chainConfigs.sol,
    enabled: true,
    dailyBudget: 100,
    weeklyBudget: 100,
    maxPerTrade: 0.005,
    maxOpenPositions: 100,
    dailyLossLimit: 100
  };
  const ids = { kol: null, activity: null, whitelist: null, signal: null };

  try {
    await db.query("UPDATE config SET value_json = $1 WHERE key = 'chain_configs'", [chainConfigs]);
    ids.kol = (await db.query(
      `INSERT INTO x_kol_accounts(x_user_id, x_handle, enabled)
       VALUES ($1,$2,true) RETURNING id`,
      [`p11-fee-${suffix}`, `p11fee${suffix}`]
    )).rows[0].id;
    ids.whitelist = (await db.query(
      `INSERT INTO ca_whitelist(contract_address, chain_id, symbol, project_name,
        budget_per_trade, total_budget, spent_budget, slippage, status)
       VALUES ($1,'sol','P11F','P11 Fee',0.005,0.005,0,10,'active') RETURNING id`,
      [`P11Fee${suffix}`]
    )).rows[0].id;
    ids.activity = (await db.query(
      `INSERT INTO x_activities(kol_id, kol_handle, activity_type, provider, processed)
       VALUES ($1,$2,'follow','6551',true) RETURNING id`,
      [ids.kol, `p11fee${suffix}`]
    )).rows[0].id;
    ids.signal = (await db.query(
      `INSERT INTO trade_signals(activity_id, whitelist_id, kol_id, kol_handle,
        signal_type, execution_mode, status, matched_relation_ids)
       VALUES ($1,$2,$3,$4,'handle_match','live','recorded',ARRAY[1]::bigint[]) RETURNING id`,
      [ids.activity, ids.whitelist, ids.kol, `p11fee${suffix}`]
    )).rows[0].id;

    const created = await repository.createBuyAttempt({
      signal: { signal_id: ids.signal },
      chain: {
        id: 'sol',
        nativeToken: 'So11111111111111111111111111111111111111112',
        nativeSymbol: 'SOL'
      },
      wallet: { address: 'p11-fee-wallet' },
      walletNativeBalance: 1,
      inputAmountRaw: '5000000',
      budgetNative: '0.005',
      feeReserveNative: '0.0002',
      budgetUsdSnapshot: 0.52,
      snapshotHash: `snapshot-${suffix}`,
      cacheMeta: {},
      conditionOrders: [],
      token: { decimals: 6, symbol: 'P11F' },
      riskSnapshot: { passed: true }
    });
    assert.equal(Number(created.reservation.amount_native), 0.005);
    assert.equal(Number(created.reservation.fee_native), 0.0002);
  } finally {
    await db.query("UPDATE config SET value_json = $1 WHERE key = 'chain_configs'", [originalConfig]);
    if (ids.signal) await db.query('DELETE FROM trade_attempts WHERE signal_id = $1', [ids.signal]);
    if (ids.signal) await db.query('DELETE FROM trade_signals WHERE id = $1', [ids.signal]);
    if (ids.activity) await db.query('DELETE FROM x_activities WHERE id = $1', [ids.activity]);
    if (ids.kol) await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [ids.kol]);
    if (ids.whitelist) await db.query('DELETE FROM ca_whitelist WHERE id = $1', [ids.whitelist]);
    if (originalDaily === undefined) delete process.env.GMGN_GLOBAL_DAILY_USD_LIMIT;
    else process.env.GMGN_GLOBAL_DAILY_USD_LIMIT = originalDaily;
    if (originalWeekly === undefined) delete process.env.GMGN_GLOBAL_WEEKLY_USD_LIMIT;
    else process.env.GMGN_GLOBAL_WEEKLY_USD_LIMIT = originalWeekly;
  }
});

test.after(async () => { await db.pool.end(); });
