const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('./integration-guard');
const db = require('../lib/db');
const previousProvider = process.env.X_DATA_PROVIDER;
process.env.X_DATA_PROVIDER = 'twitterapi';
const {
  ingestTwitterApiEvent,
  normalizeEventType,
  normalizeTweet,
  tweetsFromPayload
} = require('../domains/x-monitor/twitterapi-webhook');

test('normalizes fast_tweet events without losing snowflake IDs', () => {
  const payload = {
    event_type: 'fast_tweet',
    timestamp: Date.now(),
    tweet: {
      id: '2045879341243043889',
      screen_name: 'WanShenMe',
      user_id: '123',
      text: 'Watching @neet_sol and NEET',
      type: 'quote',
      created_ms: Date.now() - 100,
      mentions: ['neet_sol']
    }
  };
  const tweet = normalizeTweet(payload, tweetsFromPayload(payload)[0]);
  assert.equal(tweet.id, '2045879341243043889');
  assert.equal(tweet.author.handle, 'wanshenme');
  assert.equal(tweet.activityType, 'quote');
  assert.deepEqual(tweet.targetHandles, ['neet_sol']);
});

test('normalizes standard batched tweet events', () => {
  const payload = {
    event_type: 'tweet',
    timestamp: Date.now(),
    tweets: [{
      id: '1234567890',
      text: 'replying to @BlackBullSol',
      author: { id: '42', username: 'wanshenme' },
      inReplyToUsername: 'BlackBullSol',
      createdAt: new Date().toISOString()
    }]
  };
  const tweet = normalizeTweet(payload, tweetsFromPayload(payload)[0]);
  assert.equal(tweet.activityType, 'reply');
  assert.deepEqual(tweet.targetHandles, ['blackbullsol']);
});

test('ignores unsupported follow-shaped stream events', () => {
  assert.equal(normalizeEventType('follow'), null);
});

test('rejects webhook payloads without a provider timestamp', async () => {
  await assert.rejects(
    ingestTwitterApiEvent({ event_type: 'tweet', tweets: [] }),
    { code: 'WEBHOOK_TIMESTAMP_REQUIRED' }
  );
});

test('webhook ingestion creates one signal and ignores a replayed tweet', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const handle = `p7webhookkol${suffix}`;
  const projectHandle = `p7webhookproject${suffix}`;
  const contractAddress = `0x${suffix.padStart(40, '2').slice(-40)}`;
  const ids = { kol: null, whitelist: null, activity: null };
  const previousMode = process.env.TRADING_MODE;
  process.env.TRADING_MODE = 'signal';

  try {
    const kolResult = await db.query(
      `INSERT INTO x_kol_accounts (x_user_id, x_handle, display_name, enabled)
       VALUES ($1, $2, 'P7 Webhook Test', true) RETURNING id`,
      [`p7-webhook-user-${suffix}`, handle]
    );
    ids.kol = kolResult.rows[0].id;

    const whitelistResult = await db.query(
      `INSERT INTO ca_whitelist
        (contract_address, chain_id, symbol, project_name, project_x_handles,
         budget_per_trade, total_budget, status)
       VALUES ($1, 'base', $2, 'P7 Webhook Test', ARRAY[$3], 0.001, 0.01, 'active')
       RETURNING id`,
      [contractAddress, `P7WEBHOOK${suffix}`, projectHandle]
    );
    ids.whitelist = whitelistResult.rows[0].id;
    await db.query(
      `INSERT INTO x_signal_source_rules
        (whitelist_id, actor_id, event_types, match_mode, source_kind)
       VALUES ($1, $2, ARRAY['tweet'], 'ca_only', 'ecosystem')`,
      [ids.whitelist, ids.kol]
    );

    const now = Date.now();
    const payload = {
      event_type: 'fast_tweet',
      timestamp: now,
      tweet: {
        id: `204587934${suffix}`,
        screen_name: handle,
        user_id: `p7-webhook-user-${suffix}`,
        text: `Watching @${projectHandle} ${contractAddress}`,
        type: 'tweet',
        created_ms: now - 100,
        mentions: [projectHandle]
      }
    };

    const first = await ingestTwitterApiEvent(payload, { now: new Date(now + 100) });
    assert.equal(first.received, 1);
    assert.equal(first.inserted, 1);
    assert.equal(first.matched, 1);
    ids.activity = first.activities[0].id;

    const replay = await ingestTwitterApiEvent(payload, { now: new Date(now + 200) });
    assert.equal(replay.received, 1);
    assert.equal(replay.inserted, 0);
    assert.equal(replay.matched, 0);

    const state = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM x_activities WHERE kol_id = $1) AS activity_count,
         (SELECT COUNT(*) FROM x_activities WHERE kol_id = $1 AND processed = true) AS processed_count,
         (SELECT COUNT(*) FROM trade_signals WHERE kol_id = $1) AS signal_count,
         (SELECT COUNT(*) FROM positions WHERE signal_id IN (
           SELECT id FROM trade_signals WHERE kol_id = $1
         )) AS position_count`,
      [ids.kol]
    );
    assert.equal(Number(state.rows[0].activity_count), 1);
    assert.equal(Number(state.rows[0].processed_count), 1);
    assert.equal(Number(state.rows[0].signal_count), 1);
    assert.equal(Number(state.rows[0].position_count), 0);
  } finally {
    if (ids.kol) {
      await db.query('DELETE FROM trade_signals WHERE kol_id = $1', [ids.kol]);
      await db.query('DELETE FROM x_activities WHERE kol_id = $1', [ids.kol]);
      await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [ids.kol]);
    }
    if (ids.whitelist) {
      await db.query('DELETE FROM ca_whitelist WHERE id = $1', [ids.whitelist]);
    }
    process.env.TRADING_MODE = previousMode;
  }
});

test.after(async () => {
  if (previousProvider === undefined) delete process.env.X_DATA_PROVIDER;
  else process.env.X_DATA_PROVIDER = previousProvider;
  await db.pool.end();
});
