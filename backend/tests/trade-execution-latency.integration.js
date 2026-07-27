const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');
const repository = require('../domains/trade/trade-repository');
const { LiveExecutionQueue } = require('../domains/trade/live-execution-queue');
const { createTradeIntent } = require('./p12-fixtures');

test('execution timing updates resolve a signal activity through provider activity_ids', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const ids = { kol: null, whitelist: null, activity: null, signal: null, intent: null, attempt: null };
  const providerEventId = `p9-latency-${suffix}`;

  try {
    ids.kol = (await db.query(
      `INSERT INTO x_kol_accounts (x_user_id, x_handle, enabled)
       VALUES ($1, $2, true) RETURNING id`,
      [`p9-latency-user-${suffix}`, `p9latency${suffix}`]
    )).rows[0].id;
    ids.whitelist = (await db.query(
      `INSERT INTO ca_whitelist
        (contract_address, chain_id, symbol, project_name, budget_per_trade, total_budget, status)
       VALUES ($1, 'sol', $2, 'P9 Latency', 0.001, 0.01, 'active') RETURNING id`,
      [`P9Latency${suffix}`, `P9L${suffix}`]
    )).rows[0].id;
    ids.activity = (await db.query(
      `INSERT INTO x_activities
        (kol_id, kol_handle, activity_type, provider, provider_event_id, processed)
       VALUES ($1, $2, 'tweet', '6551', $3, true) RETURNING id`,
      [ids.kol, `p9latency${suffix}`, providerEventId]
    )).rows[0].id;
    ids.signal = (await db.query(
      `INSERT INTO trade_signals
        (activity_id, whitelist_id, kol_id, kol_handle, signal_type, execution_mode, status)
       VALUES ($1, $2, $3, $4, 'ca_mention', 'live', 'recorded') RETURNING id`,
      [ids.activity, ids.whitelist, ids.kol, `p9latency${suffix}`]
    )).rows[0].id;
    await db.query(
      `INSERT INTO x_provider_events
        (provider, provider_event_id, event_type, raw_payload, status, activity_ids,
         transport_received_at, received_at)
       VALUES ('6551', $1, 'NEW_TWEET', '{}', 'processed', ARRAY[$2]::int[],
         NOW() - INTERVAL '2 seconds', NOW() - INTERVAL '2 seconds')`,
      [providerEventId, ids.activity]
    );
    const intent = await createTradeIntent(db, {
      suffix,
      side: 'buy',
      signalId: ids.signal,
      whitelistId: ids.whitelist,
      walletAddress: `Wallet${suffix}`,
      contractAddress: `P9Latency${suffix}`,
      status: 'created'
    });
    ids.intent = intent.id;
    ids.attempt = (await db.query(
      `INSERT INTO trade_attempts
        (intent_id, attempt_no, signal_id, whitelist_id, side, idempotency_key, chain, wallet_address,
         input_token, output_token, input_amount_raw, status, request_fingerprint)
       VALUES ($1, 1, $2, $3, 'buy', $4, 'sol', $5, $6, $7, '1000', 'reserved', $8)
       RETURNING id`,
      [ids.intent, ids.signal, ids.whitelist, `intent:${ids.intent}:attempt:1`, `Wallet${suffix}`,
        'So11111111111111111111111111111111111111112', `P9Latency${suffix}`,
        `p9-latency-fingerprint-${suffix}`]
    )).rows[0].id;

    const queue = new LiveExecutionQueue({ db, logger: { warn() {}, error() {} } });
    await queue.markTiming(ids.signal, 'enqueued');
    await queue.markTiming(ids.signal, 'started');
    await repository.transitionAttempt(ids.attempt, ['reserved'], 'submitting', { actor: 'test' });

    const timing = (await db.query(
      `SELECT execution_enqueued_at, execution_started_at, swap_started_at,
              signal_to_execution_ms, receive_to_swap_ms
       FROM x_provider_events
       WHERE provider = '6551' AND provider_event_id = $1`,
      [providerEventId]
    )).rows[0];
    assert.ok(timing.execution_enqueued_at);
    assert.ok(timing.execution_started_at);
    assert.ok(timing.swap_started_at);
    assert.ok(Number(timing.signal_to_execution_ms) >= 0);
    assert.ok(Number(timing.receive_to_swap_ms) >= 1500);
  } finally {
    if (ids.attempt) await db.query('DELETE FROM trade_attempts WHERE id = $1', [ids.attempt]);
    if (ids.intent) await db.query('DELETE FROM trade_intents WHERE id = $1', [ids.intent]);
    await db.query(
      `DELETE FROM x_provider_events WHERE provider = '6551' AND provider_event_id = $1`,
      [providerEventId]
    );
    if (ids.signal) await db.query('DELETE FROM trade_signals WHERE id = $1', [ids.signal]);
    if (ids.activity) await db.query('DELETE FROM x_activities WHERE id = $1', [ids.activity]);
    if (ids.whitelist) await db.query('DELETE FROM ca_whitelist WHERE id = $1', [ids.whitelist]);
    if (ids.kol) await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [ids.kol]);
  }
});

test.after(async () => {
  await db.pool.end();
});
