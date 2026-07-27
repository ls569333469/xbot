const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('./integration-guard');
const db = require('../lib/db');
const { ingest6551Event } = require('../domains/x-monitor/6551/event-inbox');

test('6551 Tweet and CA replay persist one Activity and one canonical signal', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const kolHandle = `p8kol${suffix}`;
  const projectHandle = `p8project${suffix}`;
  const ca = `0x${suffix.padStart(40, '1').slice(-40)}`;
  const tweetId = `2099${suffix}`;
  const eventIds = [`p8-tweet-${suffix}`, `p8-ca-${suffix}`];
  const ids = { kol: null, whitelist: null };
  const previousMode = process.env.TRADING_MODE;
  process.env.TRADING_MODE = 'signal';
  const enqueuedSignals = [];

  const content = {
    id: tweetId,
    text: `Watching @${projectHandle} ${ca}`,
    createdAt: '2026-07-21T08:00:00Z',
    userScreenName: kolHandle,
    userIdStr: `p8-user-${suffix}`,
    mentions: [{ username: projectHandle }]
  };

  try {
    const kolResult = await db.query(
      `INSERT INTO x_kol_accounts (x_user_id, x_handle, display_name, enabled)
       VALUES ($1, $2, 'P8 Inbox Test', true) RETURNING id`,
      [`p8-user-${suffix}`, kolHandle]
    );
    ids.kol = kolResult.rows[0].id;

    const whitelistResult = await db.query(
      `INSERT INTO ca_whitelist
        (contract_address, chain_id, symbol, project_name, project_x_handles,
         budget_per_trade, total_budget, status)
       VALUES ($1, 'base', $2, 'P8 Inbox Test', ARRAY[$3], 0.001, 0.01, 'active')
       RETURNING id`,
      [ca, `P8${suffix}`, projectHandle]
    );
    ids.whitelist = whitelistResult.rows[0].id;
    await db.query(
      `INSERT INTO x_signal_source_rules
        (whitelist_id, actor_id, event_types, match_mode, source_kind)
       VALUES ($1, $2, ARRAY['tweet'], 'ca_only', 'ecosystem')`,
      [ids.whitelist, ids.kol]
    );

    const first = await ingest6551Event({
      id: eventIds[0],
      twAccount: kolHandle,
      eventType: 'NEW_TWEET',
      createdAt: '2026-07-21T08:00:01Z',
      content
    }, { notify: false, onSignals: (signals) => enqueuedSignals.push(...signals) });
    assert.equal(first.status, 'processed');
    assert.equal(first.activities.length, 1);
    assert.equal(first.matched, 1);
    assert.equal(enqueuedSignals.length, 1);

    const replay = await ingest6551Event({
      id: eventIds[0],
      twAccount: kolHandle,
      eventType: 'NEW_TWEET',
      createdAt: '2026-07-21T08:00:01Z',
      content
    }, { notify: false, onSignals: (signals) => enqueuedSignals.push(...signals) });
    assert.equal(replay.duplicate, true);
    assert.equal(enqueuedSignals.length, 1);

    const duplicateCa = await ingest6551Event({
      id: eventIds[1],
      twAccount: kolHandle,
      eventType: 'CA',
      createdAt: '2026-07-21T08:00:02Z',
      ca,
      content
    }, { notify: false });
    assert.equal(duplicateCa.status, 'ignored');
    assert.equal(duplicateCa.matched, 0);

    const state = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM x_activities WHERE kol_id = $1) AS activity_count,
         (SELECT COUNT(*) FROM trade_signals WHERE kol_id = $1) AS signal_count,
         (SELECT COUNT(*) FROM positions WHERE signal_id IN (
           SELECT id FROM trade_signals WHERE kol_id = $1
         )) AS position_count`,
      [ids.kol]
    );
    assert.equal(Number(state.rows[0].activity_count), 1);
    assert.equal(Number(state.rows[0].signal_count), 1);
    assert.equal(Number(state.rows[0].position_count), 0);

    const signal = await db.query(
      `SELECT canonical_key, matched_project_handles, matched_whitelist_ids,
              matched_relation_ids, matched_source_rule_ids,
              execution_mode, status
       FROM trade_signals WHERE kol_id = $1`,
      [ids.kol]
    );
    assert.ok(signal.rows[0].canonical_key);
    assert.deepEqual(signal.rows[0].matched_project_handles, [kolHandle]);
    assert.deepEqual(signal.rows[0].matched_whitelist_ids, [ids.whitelist]);
    assert.equal(signal.rows[0].matched_relation_ids.length, 0);
    assert.equal(signal.rows[0].matched_source_rule_ids.length, 1);
    assert.equal(signal.rows[0].execution_mode, 'signal');
    assert.equal(signal.rows[0].status, 'signal_only');
  } finally {
    await db.query(
      `DELETE FROM x_provider_events
       WHERE provider = '6551' AND provider_event_id = ANY($1::text[])`,
      [eventIds]
    );
    if (ids.kol) {
      await db.query('DELETE FROM trade_signals WHERE kol_id = $1', [ids.kol]);
      await db.query('DELETE FROM x_activities WHERE kol_id = $1', [ids.kol]);
      await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [ids.kol]);
    }
    if (ids.whitelist) await db.query('DELETE FROM ca_whitelist WHERE id = $1', [ids.whitelist]);
    process.env.TRADING_MODE = previousMode;
  }
});

test('6551 follower events map follower to project and never signal a refollow twice', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const actorHandle = `p8flwactor${suffix}`;
  const projectHandle = `p8flwproject${suffix}`;
  const ca = `P8FOLLOWCA${suffix}`;
  const eventIds = [
    `p8-follow-${suffix}`,
    `p8-unfollow-${suffix}`,
    `p8-refollow-${suffix}`
  ];
  const ids = { kol: null, whitelist: null };
  const previousMode = process.env.TRADING_MODE;
  process.env.TRADING_MODE = 'signal';

  try {
    const kolResult = await db.query(
      `INSERT INTO x_kol_accounts (x_user_id, x_handle, display_name, enabled)
       VALUES ($1, $2, 'P8 Follow Inbox Test', true) RETURNING id`,
      [`p8-follow-user-${suffix}`, actorHandle]
    );
    ids.kol = kolResult.rows[0].id;

    const whitelistResult = await db.query(
      `INSERT INTO ca_whitelist
        (contract_address, chain_id, symbol, project_name, project_x_handles,
         budget_per_trade, total_budget, status)
       VALUES ($1, 'sol', $2, 'P8 Follow Inbox Test', ARRAY[$3], 0.001, 0.01, 'active')
       RETURNING id`,
      [ca, `P8F${suffix}`, projectHandle]
    );
    ids.whitelist = whitelistResult.rows[0].id;
    await db.query(
      `INSERT INTO x_signal_relations (whitelist_id, kol_id, target_x_handle)
       VALUES ($1, $2, $3)`,
      [ids.whitelist, ids.kol, projectHandle]
    );

    const followerEvent = (id, eventType, createdAt) => ({
      id,
      twAccount: actorHandle,
      eventType,
      createdAt,
      content: JSON.stringify([{ twId: `p8-project-user-${suffix}`, twAccount: projectHandle }])
    });

    const first = await ingest6551Event(
      followerEvent(eventIds[0], 'NEW_FOLLOWER', '2026-07-22T10:00:00Z'),
      { notify: false }
    );
    assert.equal(first.status, 'processed');
    assert.equal(first.activities.length, 1);
    assert.equal(first.activities[0].activity_type, 'follow');
    assert.equal(first.activities[0].kol_handle, actorHandle);
    assert.deepEqual(first.activities[0].target_x_handles, [projectHandle]);
    assert.equal(first.matched, 1);

    const unfollow = await ingest6551Event(
      followerEvent(eventIds[1], 'NEW_UNFOLLOWER', '2026-07-22T10:01:00Z'),
      { notify: false }
    );
    assert.equal(unfollow.status, 'processed');
    assert.equal(unfollow.activities[0].activity_type, 'unfollow');
    assert.equal(unfollow.matched, 0);

    const refollow = await ingest6551Event(
      followerEvent(eventIds[2], 'NEW_FOLLOWER', '2026-07-22T10:02:00Z'),
      { notify: false }
    );
    assert.equal(refollow.status, 'processed');
    assert.equal(refollow.activities[0].activity_type, 'follow');
    assert.equal(refollow.matched, 0);

    const state = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM trade_signals WHERE kol_id = $1) AS signal_count,
         (SELECT COUNT(*) FROM x_follow_signal_once WHERE kol_id = $1) AS once_count`,
      [ids.kol]
    );
    assert.equal(Number(state.rows[0].signal_count), 1);
    assert.equal(Number(state.rows[0].once_count), 1);
  } finally {
    await db.query(
      `DELETE FROM x_provider_events
       WHERE provider = '6551' AND provider_event_id = ANY($1::text[])`,
      [eventIds]
    );
    if (ids.kol) {
      await db.query('DELETE FROM trade_signals WHERE kol_id = $1', [ids.kol]);
      await db.query('DELETE FROM x_activities WHERE kol_id = $1', [ids.kol]);
      await db.query('DELETE FROM x_follow_signal_once WHERE kol_id = $1', [ids.kol]);
    }
    if (ids.whitelist) await db.query('DELETE FROM ca_whitelist WHERE id = $1', [ids.whitelist]);
    if (ids.kol) await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [ids.kol]);
    process.env.TRADING_MODE = previousMode;
  }
});

test.after(async () => {
  await db.pool.end();
});
