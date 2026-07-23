const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('./integration-guard');
const db = require('../lib/db');
const followJob = require('../jobs/x-poll-follows');

function followingPage(users, options = {}) {
  return {
    users: users.map(([id, handle]) => ({ id, handle, raw_json: { id, userName: handle } })),
    hasNextPage: options.hasNextPage || false,
    nextCursor: options.nextCursor || null
  };
}

test('follow job establishes a baseline, emits one signal, and ignores refollows and gaps', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const handle = `p7followkol${suffix}`;
  const projectHandle = `p7followproject${suffix}`;
  const boundaryHandle = `p7boundary${suffix}`;
  const ids = { kol: null, whitelist: null };
  const previous = {
    provider: process.env.X_DATA_PROVIDER,
    mode: process.env.TRADING_MODE,
    maxPages: process.env.TWITTERAPI_IO_FOLLOW_INCREMENTAL_MAX_PAGES
  };
  process.env.X_DATA_PROVIDER = 'twitterapi';
  process.env.TRADING_MODE = 'signal';

  try {
    const kolResult = await db.query(
      `INSERT INTO x_kol_accounts (x_user_id, x_handle, display_name, enabled)
       VALUES ($1, $2, 'P7 Follow Job Test', true) RETURNING *`,
      [`p7-follow-user-${suffix}`, handle]
    );
    ids.kol = kolResult.rows[0].id;

    const whitelistResult = await db.query(
      `INSERT INTO ca_whitelist
        (contract_address, chain_id, symbol, project_name, project_x_handles,
         budget_per_trade, total_budget, status)
       VALUES ($1, 'sol', $2, 'P7 Follow Job Test', ARRAY[$3], 0.001, 0.01, 'active')
       RETURNING id`,
      [`P7FOLLOWCA${suffix}`, `P7FOLLOW${suffix}`, projectHandle]
    );
    ids.whitelist = whitelistResult.rows[0].id;
    await db.query(
      `INSERT INTO x_signal_relations (whitelist_id, kol_id, target_x_handle)
       VALUES ($1, $2, $3)`,
      [ids.whitelist, ids.kol, projectHandle]
    );

    const baselineClient = {
      getUserFollowingPage: async () => followingPage([['boundary-user', boundaryHandle]])
    };
    let kol = kolResult.rows[0];
    const baseline = await followJob.run({ kol, xClient: baselineClient });
    assert.equal(baseline.status, 'baseline_initialized');

    const afterBaseline = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM x_follow_seen WHERE kol_id = $1) AS seen_count,
         (SELECT COUNT(*) FROM x_activities WHERE kol_id = $1) AS activity_count,
         (SELECT COUNT(*) FROM trade_signals WHERE kol_id = $1) AS signal_count`,
      [ids.kol]
    );
    assert.equal(Number(afterBaseline.rows[0].seen_count), 1);
    assert.equal(Number(afterBaseline.rows[0].activity_count), 0);
    assert.equal(Number(afterBaseline.rows[0].signal_count), 0);

    kol = (await db.query('SELECT * FROM x_kol_accounts WHERE id = $1', [ids.kol])).rows[0];
    const newFollowClient = {
      getUserFollowingPage: async () => followingPage([
        ['new-project-user', projectHandle],
        ['boundary-user', boundaryHandle]
      ])
    };
    const firstFollow = await followJob.run({ kol, xClient: newFollowClient });
    assert.equal(firstFollow.status, 'completed');
    assert.deepEqual(firstFollow.new_follows, [projectHandle]);
    assert.equal(firstFollow.matched_signals, 1);

    let state = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM x_activities WHERE kol_id = $1 AND activity_type = 'follow') AS activity_count,
         (SELECT COUNT(*) FROM trade_signals WHERE kol_id = $1) AS signal_count,
         (SELECT COUNT(*) FROM x_activities WHERE kol_id = $1 AND processed = true) AS processed_count`,
      [ids.kol]
    );
    assert.equal(Number(state.rows[0].activity_count), 1);
    assert.equal(Number(state.rows[0].signal_count), 1);
    assert.equal(Number(state.rows[0].processed_count), 1);

    // A cancellation is represented by absence. Reappearing later remains seen and must not signal again.
    for (const page of [
      followingPage([['boundary-user', boundaryHandle]]),
      followingPage([['new-project-user', projectHandle], ['boundary-user', boundaryHandle]])
    ]) {
      kol = (await db.query('SELECT * FROM x_kol_accounts WHERE id = $1', [ids.kol])).rows[0];
      const result = await followJob.run({
        kol,
        xClient: { getUserFollowingPage: async () => page }
      });
      assert.equal(result.status, 'completed');
      assert.equal(result.matched_signals, 0);
    }

    state = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM x_activities WHERE kol_id = $1) AS activity_count,
         (SELECT COUNT(*) FROM trade_signals WHERE kol_id = $1) AS signal_count`,
      [ids.kol]
    );
    assert.equal(Number(state.rows[0].activity_count), 1);
    assert.equal(Number(state.rows[0].signal_count), 1);

    process.env.TWITTERAPI_IO_FOLLOW_INCREMENTAL_MAX_PAGES = '1';
    kol = (await db.query('SELECT * FROM x_kol_accounts WHERE id = $1', [ids.kol])).rows[0];
    const gap = await followJob.run({
      kol,
      xClient: {
        getUserFollowingPage: async () => followingPage(
          [['unknown-user', `p7unknown${suffix}`]],
          { hasNextPage: true, nextCursor: 'next-page' }
        )
      }
    });
    assert.equal(gap.status, 'gap_detected');

    const afterGap = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM x_follow_seen WHERE kol_id = $1 AND target_x_user_id = 'unknown-user') AS unknown_seen,
         (SELECT COUNT(*) FROM x_activities WHERE kol_id = $1) AS activity_count,
         (SELECT COUNT(*) FROM trade_signals WHERE kol_id = $1) AS signal_count,
         (SELECT COUNT(*) FROM x_follow_poll_runs WHERE kol_id = $1 AND status = 'gap_detected') AS gap_count`,
      [ids.kol]
    );
    assert.equal(Number(afterGap.rows[0].unknown_seen), 0);
    assert.equal(Number(afterGap.rows[0].activity_count), 1);
    assert.equal(Number(afterGap.rows[0].signal_count), 1);
    assert.equal(Number(afterGap.rows[0].gap_count), 1);
  } finally {
    if (ids.kol) {
      await db.query('DELETE FROM trade_signals WHERE kol_id = $1', [ids.kol]);
      await db.query('DELETE FROM x_activities WHERE kol_id = $1', [ids.kol]);
      await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [ids.kol]);
    }
    if (ids.whitelist) {
      await db.query('DELETE FROM ca_whitelist WHERE id = $1', [ids.whitelist]);
    }
    process.env.X_DATA_PROVIDER = previous.provider;
    process.env.TRADING_MODE = previous.mode;
    if (previous.maxPages === undefined) {
      delete process.env.TWITTERAPI_IO_FOLLOW_INCREMENTAL_MAX_PAGES;
    } else {
      process.env.TWITTERAPI_IO_FOLLOW_INCREMENTAL_MAX_PAGES = previous.maxPages;
    }
  }
});

test.after(async () => {
  await db.pool.end();
});
