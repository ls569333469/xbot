const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');
const signalQueries = require('../domains/signal/public-queries');
const tradeQueries = require('../domains/trade/queries');
const tradeRepository = require('../domains/trade/trade-repository');
const { assetSnapshot, authorizationSnapshot } = require('../domains/signal/contract-snapshot');
const { closedPositionCsv } = require('../domains/trade/contract-projector');
const { createTradeIntent } = require('./p12-fixtures');

const created = {
  attempts: [],
  intents: [],
  positions: [],
  signals: [],
  activities: [],
  whitelists: [],
  dynamicPolicies: [],
  followPolicies: [],
  kols: []
};

function evmAddress() {
  return `0x${crypto.randomBytes(20).toString('hex')}`;
}

async function gmgnAuditCount() {
  const result = await db.query(
    "SELECT COUNT(*)::int AS count FROM provider_rate_events WHERE provider = 'gmgn'"
  );
  return result.rows[0].count;
}

async function createPolicy(type, kolId, chain, suffix) {
  if (type === 'dynamic_policy') {
    const result = await db.query(
      `INSERT INTO x_actor_dynamic_policies
        (kol_id, mode, enabled, allowed_chain_ids, budget_per_trade, daily_budget,
         revision, context_hash, chain_budgets)
       VALUES ($1,'live',true,ARRAY[$2]::text[],0.001,0.01,1,$3,$4)
       RETURNING id, revision, context_hash`,
      [kolId, chain, `p27-dynamic-${suffix}`, {
        [chain]: { budget_per_trade: 0.001, daily_budget: 0.01 }
      }]
    );
    created.dynamicPolicies.push(result.rows[0].id);
    return result.rows[0];
  }
  if (type === 'follow_discovery') {
    const result = await db.query(
      `INSERT INTO follow_discovery_policies
        (kol_id, mode, enabled, allowed_chain_ids, trade_config_snapshot,
         resolver_options, revision, context_hash)
       VALUES ($1,'live',true,ARRAY[$2]::text[],$3,'{}',1,$4)
       RETURNING id, revision, context_hash`,
      [kolId, chain, { chain_budgets: { [chain]: { budget_per_trade: 0.001, daily_budget: 0.01 } } },
        `p27-follow-${suffix}`]
    );
    created.followPolicies.push(result.rows[0].id);
    return result.rows[0];
  }
  return null;
}

async function createContractFlow(type, chain, symbol, projectName, suffix) {
  const handle = `p27${type.replaceAll('_', '')}${suffix}`.slice(0, 48);
  const kol = (await db.query(
    `INSERT INTO x_kol_accounts (x_user_id, x_handle, display_name, enabled)
     VALUES ($1,$2,$3,true) RETURNING id`,
    [`p27-user-${type}-${suffix}`, handle, `P27 ${type}`]
  )).rows[0];
  created.kols.push(kol.id);
  const policy = await createPolicy(type, kol.id, chain, suffix);
  const contractAddress = evmAddress();
  const source = type === 'dynamic_policy' ? 'dynamic_keyword'
    : type === 'follow_discovery' ? 'follow_discovery' : 'manual';
  const whitelist = (await db.query(
    `INSERT INTO ca_whitelist
      (contract_address, chain_id, symbol, project_name, project_x_handles,
       budget_per_trade, total_budget, status, source, live_activation_state,
       managed_by_system, actor_policy_id, actor_policy_revision, follow_discovery_policy_id)
     VALUES ($1,$2,$3,$4,ARRAY[$5]::text[],0.001,0.01,'active',$6,'live_ready',$7,$8,$9,$10)
     RETURNING id`,
    [contractAddress, chain, symbol, projectName, handle, source, type !== 'fixed_ca',
      type === 'dynamic_policy' ? policy.id : null,
      type === 'dynamic_policy' ? policy.revision : null,
      type === 'follow_discovery' ? policy.id : null]
  )).rows[0];
  created.whitelists.push(whitelist.id);
  const activityType = type === 'follow_discovery' ? 'follow' : 'tweet';
  const activity = (await db.query(
    `INSERT INTO x_activities
      (kol_id, kol_handle, activity_type, tweet_id, tweet_text, target_x_handle,
       extracted_cas, provider_event_id, source_created_at, provider, processed)
     VALUES ($1,$2,$3,$4,$5,$6,ARRAY[$7]::text[],$8,NOW(),'6551',true)
     RETURNING id`,
    [kol.id, handle, activityType, `p27-tweet-${type}-${suffix}`,
      `P27 contract fixture ${contractAddress}`, handle, contractAddress,
      `p27-event-${type}-${suffix}`]
  )).rows[0];
  created.activities.push(activity.id);
  const signalType = type === 'dynamic_policy' ? 'dynamic_keyword'
    : type === 'follow_discovery' ? 'follow_discovery' : 'ca_mention';
  const snapshotInput = {
    strategy_type: type,
    chain_id: chain,
    contract_address: contractAddress,
    symbol,
    project_name: projectName,
    project_handle: handle,
    whitelist_id: whitelist.id,
    execution_mode: 'live',
    actor_policy_id: type === 'dynamic_policy' ? policy.id : null,
    actor_policy_revision: type === 'dynamic_policy' ? policy.revision : null,
    dynamic_policy_context_hash: type === 'dynamic_policy' ? policy.context_hash : null,
    follow_discovery_policy_id: type === 'follow_discovery' ? policy.id : null,
    follow_discovery_policy_revision: type === 'follow_discovery' ? policy.revision : null,
    follow_discovery_context_hash: type === 'follow_discovery' ? policy.context_hash : null
  };
  const asset = assetSnapshot(snapshotInput, 'p27_integration_fixture');
  const authorization = authorizationSnapshot(snapshotInput, type);
  const signal = (await db.query(
    `INSERT INTO trade_signals
      (activity_id, whitelist_id, kol_id, kol_handle, signal_type, match_detail,
       canonical_key, matched_whitelist_ids, execution_mode, status, trace_id,
       actor_policy_id, actor_policy_revision, dynamic_policy_context_hash,
       follow_discovery_policy_id, follow_discovery_policy_revision,
       follow_discovery_context_hash, strategy_type, asset_snapshot, authorization_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,ARRAY[$2]::int[],'live','executed',$8,
       $9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [activity.id, whitelist.id, kol.id, handle, signalType,
      `P27 ${type} contract fixture`, `p27:${type}:${suffix}`, `p27-trace-${type}-${suffix}`,
      snapshotInput.actor_policy_id, snapshotInput.actor_policy_revision,
      snapshotInput.dynamic_policy_context_hash, snapshotInput.follow_discovery_policy_id,
      snapshotInput.follow_discovery_policy_revision, snapshotInput.follow_discovery_context_hash,
      type, asset, authorization]
  )).rows[0];
  created.signals.push(signal.id);
  const position = (await db.query(
    `INSERT INTO positions
      (signal_id, whitelist_id, contract_address, chain_id, symbol, amount_in,
       amount_out, entry_price, buy_tx_hash, buy_order_id, sell_tx_hash,
       tp_pct, sl_pct, tpsl_status, exit_price, pnl, pnl_pct, execution_mode,
       status, opened_at, closed_at, asset_snapshot)
     VALUES ($1,$2,$3,$4,$5,0.001,100,0.00001,$6,$7,$8,100,20,'ok',
       0.000011,0.0001,10,'live','manual_close',NOW() - INTERVAL '1 minute',NOW(),$9)
     RETURNING id`,
    [signal.id, whitelist.id, contractAddress, chain, symbol,
      `p27-buy-${type}-${suffix}`, `p27-order-${type}-${suffix}`,
      `p27-sell-${type}-${suffix}`, asset]
  )).rows[0];
  created.positions.push(position.id);
  const intent = await createTradeIntent(db, {
    suffix: `p27-${type}-${suffix}`,
    sourceKey: `p27:${type}:source:${suffix}`,
    scopeKey: `p27:${type}:scope:${suffix}`,
    signalId: signal.id,
    positionId: position.id,
    whitelistId: whitelist.id,
    chain,
    walletAddress: `p27-wallet-${type}-${suffix}`,
    contractAddress,
    status: 'confirmed'
  });
  created.intents.push(intent.id);
  const attempt = (await db.query(
    `INSERT INTO trade_attempts
      (intent_id, attempt_no, signal_id, whitelist_id, position_id, side,
       idempotency_key, chain, wallet_address, input_token, output_token,
       input_amount_raw, output_amount_raw, status, request_fingerprint,
       confirmed_at, metadata, trace_id)
     VALUES ($1,1,$2,$3,$4,'buy',$5,$6,$7,$8,$9,'1000000','100000000',
       'confirmed',$10,NOW(),$11,$12)
     RETURNING id`,
    [intent.id, signal.id, whitelist.id, position.id, `p27:${type}:attempt:${suffix}`,
      chain, `p27-wallet-${type}-${suffix}`, '0x0000000000000000000000000000000000000000',
      contractAddress, `p27-fingerprint-${type}-${suffix}`, { fixture: 'p27_contract_flow' },
      `p27-trace-${type}-${suffix}`]
  )).rows[0];
  created.attempts.push(attempt.id);
  await db.query(
    `INSERT INTO trade_orders
      (attempt_id, provider_order_id, tx_hash, provider_status, normalized_status,
       input_token, output_token, input_amount_raw, output_amount_raw,
       input_decimals, output_decimals, confirmed_at)
     VALUES ($1,$2,$3,'confirmed','confirmed',$4,$5,'1000000','100000000',18,18,NOW())`,
    [attempt.id, `p27-provider-${type}-${suffix}`, `p27-tx-${type}-${suffix}`,
      '0x0000000000000000000000000000000000000000', contractAddress]
  );
  return { type, signal, position, attempt, contractAddress, symbol, projectName };
}

test('P27 three-strategy DTO flow preserves metadata without GMGN calls', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const beforeAudit = await gmgnAuditCount();
  const fixtures = [
    await createContractFlow('fixed_ca', 'base', 'P27FIX', 'P27 Fixed Asset', `${suffix}1`),
    await createContractFlow('dynamic_policy', 'bsc', 'P27DYN', 'P27 Dynamic Asset', `${suffix}2`),
    await createContractFlow('follow_discovery', 'robinhood', 'P27FOL', 'P27 Follow Asset', `${suffix}3`)
  ];

  const [signals, history, attempts] = await Promise.all([
    signalQueries.listSignals({ status: 'executed', pageSize: 200 }),
    tradeQueries.getHistory(),
    tradeRepository.listAttempts(200)
  ]);
  const signalById = new Map(signals.data.map((row) => [String(row.id), row]));
  const positionById = new Map(history.map((row) => [String(row.id), row]));
  const attemptById = new Map(attempts.map((row) => [String(row.id), row]));
  for (const fixture of fixtures) {
    const signal = signalById.get(String(fixture.signal.id));
    const position = positionById.get(String(fixture.position.id));
    const attempt = attemptById.get(String(fixture.attempt.id));
    assert.ok(signal, `${fixture.type} signal missing`);
    assert.ok(position, `${fixture.type} position missing`);
    assert.ok(attempt, `${fixture.type} attempt missing`);
    for (const row of [signal, position, attempt]) {
      assert.equal(row.contract_version, 'p27.v1');
      assert.equal(row.strategy_type, fixture.type);
      assert.equal(row.contract_address, fixture.contractAddress);
      assert.equal(row.asset.symbol, fixture.symbol);
      assert.equal(row.asset.name, fixture.projectName);
      assert.equal(row.asset.display_label, fixture.symbol);
    }
  }
  const csv = closedPositionCsv(history.filter((row) => created.positions.includes(Number(row.id))));
  for (const fixture of fixtures) assert.match(csv, new RegExp(fixture.symbol));
  assert.equal(await gmgnAuditCount(), beforeAudit);
});

test.after(async () => {
  if (created.attempts.length) {
    await db.query('DELETE FROM trade_attempts WHERE id = ANY($1::bigint[])', [created.attempts]);
  }
  if (created.intents.length) {
    await db.query('DELETE FROM trade_intents WHERE id = ANY($1::bigint[])', [created.intents]);
  }
  if (created.positions.length) {
    await db.query('DELETE FROM positions WHERE id = ANY($1::int[])', [created.positions]);
  }
  if (created.signals.length) {
    await db.query('DELETE FROM trade_signals WHERE id = ANY($1::int[])', [created.signals]);
  }
  if (created.activities.length) {
    await db.query('DELETE FROM x_activities WHERE id = ANY($1::int[])', [created.activities]);
  }
  if (created.whitelists.length) {
    await db.query('DELETE FROM ca_whitelist WHERE id = ANY($1::int[])', [created.whitelists]);
  }
  if (created.dynamicPolicies.length) {
    await db.query('DELETE FROM x_actor_dynamic_policies WHERE id = ANY($1::bigint[])', [created.dynamicPolicies]);
  }
  if (created.followPolicies.length) {
    await db.query('DELETE FROM follow_discovery_policies WHERE id = ANY($1::bigint[])', [created.followPolicies]);
  }
  if (created.kols.length) {
    await db.query('DELETE FROM x_kol_accounts WHERE id = ANY($1::int[])', [created.kols]);
  }
  await db.pool.end();
});
