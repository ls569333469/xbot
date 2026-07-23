const db = require('../lib/db');
const logger = require('../lib/logger');
const { createXClient, calculateFollowingsCredits } = require('../lib/x-client');
const xMonitorQueries = require('../domains/x-monitor/queries');
const { matchActivity } = require('../domains/signal/matcher');

let running = false;

function providerName() {
  return String(process.env.X_DATA_PROVIDER || 'mock').toLowerCase();
}

async function selectKol(intervalMs) {
  const result = await db.query(
    `SELECT * FROM x_kol_accounts
     WHERE enabled = true
       AND (
         follow_baseline_completed_at IS NULL
         OR last_follow_checked_at IS NULL
         OR last_follow_checked_at <= NOW() - ($1 * INTERVAL '1 millisecond')
       )
     ORDER BY
       (follow_baseline_completed_at IS NOT NULL),
       last_follow_checked_at ASC NULLS FIRST,
       id ASC
     LIMIT 1`,
    [intervalMs]
  );
  return result.rows[0] || null;
}

async function createPollRun(kol, pollType) {
  const result = await db.query(
    `INSERT INTO x_follow_poll_runs
      (kol_id, poll_type, status, observation_started_at)
     VALUES ($1, $2, 'running', $3)
     RETURNING *`,
    [kol.id, pollType, kol.last_follow_checked_at]
  );
  return result.rows[0];
}

async function fetchBaseline(xClient, kol) {
  const maxPages = Math.max(1, Number(process.env.TWITTERAPI_IO_MAX_PAGES || 100));
  const users = [];
  let credits = 0;
  let cursor = '';
  let pageCount = 0;
  let hasNextPage = false;

  for (let page = 0; page < maxPages; page++) {
    const result = await xClient.getUserFollowingPage(kol.x_handle, { cursor, pageSize: 200 });
    pageCount++;
    users.push(...result.users);
    credits += calculateFollowingsCredits(result.users.length);
    hasNextPage = result.hasNextPage;
    if (!result.hasNextPage || !result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }

  return { users, credits, pageCount, gapDetected: hasNextPage };
}

async function pageContainsSeen(kolId, users) {
  if (users.length === 0) return false;
  const result = await db.query(
    `SELECT 1 FROM x_follow_seen
     WHERE kol_id = $1 AND target_x_user_id = ANY($2::text[])
     LIMIT 1`,
    [kolId, users.map((user) => user.id)]
  );
  return result.rows.length > 0;
}

async function fetchIncremental(xClient, kol) {
  const maxPages = Math.max(1, Number(process.env.TWITTERAPI_IO_FOLLOW_INCREMENTAL_MAX_PAGES || 5));
  const users = [];
  let credits = 0;
  let cursor = '';
  let pageCount = 0;
  let boundaryFound = false;
  let hasNextPage = false;

  for (let page = 0; page < maxPages; page++) {
    const result = await xClient.getUserFollowingPage(kol.x_handle, { cursor, pageSize: 20 });
    pageCount++;
    users.push(...result.users);
    credits += calculateFollowingsCredits(result.users.length);
    hasNextPage = result.hasNextPage;

    if (await pageContainsSeen(kol.id, result.users)) {
      boundaryFound = true;
      break;
    }
    if (!result.hasNextPage || !result.nextCursor || result.nextCursor === cursor) {
      boundaryFound = true;
      break;
    }
    cursor = result.nextCursor;
  }

  return {
    users,
    credits,
    pageCount,
    gapDetected: !boundaryFound && hasNextPage
  };
}

async function completeBaseline(kol, pollRun, result) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const user of result.users) {
      await client.query(
        `INSERT INTO x_follow_seen
          (kol_id, target_x_user_id, target_x_handle, first_seen_poll_id, was_in_baseline)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (kol_id, target_x_user_id)
         DO UPDATE SET target_x_handle = EXCLUDED.target_x_handle, updated_at = NOW()`,
        [kol.id, user.id, user.handle, pollRun.id]
      );
    }
    await client.query(
      `UPDATE x_follow_poll_runs
       SET status = 'completed', completed_at = NOW(), page_count = $1,
           returned_count = $2, credits_used = $3
       WHERE id = $4`,
      [result.pageCount, result.users.length, result.credits, pollRun.id]
    );
    await client.query(
      `UPDATE x_kol_accounts
       SET follow_baseline_completed_at = NOW(), last_follow_checked_at = NOW(),
           follow_poll_status = 'completed', updated_at = NOW()
       WHERE id = $1`,
      [kol.id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function completeIncremental(kol, pollRun, result) {
  const client = await db.pool.connect();
  const observedAt = new Date();
  const insertedActivities = [];
  try {
    await client.query('BEGIN');
    for (const user of result.users) {
      const seenResult = await client.query(
        `INSERT INTO x_follow_seen
          (kol_id, target_x_user_id, target_x_handle, first_seen_poll_id, was_in_baseline)
         VALUES ($1, $2, $3, $4, false)
         ON CONFLICT (kol_id, target_x_user_id)
         DO UPDATE SET target_x_handle = EXCLUDED.target_x_handle, updated_at = NOW()
         RETURNING id, (xmax = 0) AS inserted`,
        [kol.id, user.id, user.handle, pollRun.id]
      );
      if (!seenResult.rows[0]?.inserted) continue;

      const activity = await xMonitorQueries.insertActivity({
        kol_id: kol.id,
        kol_handle: kol.x_handle,
        activity_type: 'follow',
        target_x_handle: user.handle,
        target_x_handles: [user.handle],
        provider_event_id: `follow:${kol.id}:${user.id}`,
        provider: 'twitterapi',
        source_created_at: null,
        observation_started_at: kol.last_follow_checked_at,
        observation_ended_at: observedAt,
        raw_json: user.raw_json || user
      }, client);
      if (activity) insertedActivities.push(activity);
    }

    await client.query(
      `UPDATE x_follow_poll_runs
       SET status = 'completed', completed_at = NOW(), page_count = $1,
           returned_count = $2, new_count = $3, credits_used = $4
       WHERE id = $5`,
      [result.pageCount, result.users.length, insertedActivities.length, result.credits, pollRun.id]
    );
    await client.query(
      `UPDATE x_kol_accounts
       SET last_follow_checked_at = NOW(), follow_poll_status = 'completed', updated_at = NOW()
       WHERE id = $1`,
      [kol.id]
    );
    await client.query('COMMIT');
    return insertedActivities;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function matchInsertedActivities(activities, wsBroadcast) {
  let matched = 0;

  for (const activity of activities) {
    try {
      const activityMatches = await matchActivity(activity);
      matched += activityMatches;
      await db.query('UPDATE x_activities SET processed = true WHERE id = $1', [activity.id]);

      if (activityMatches > 0 && wsBroadcast) {
        wsBroadcast({
          type: 'signal:matched',
          payload: { activityId: activity.id, matches: activityMatches }
        });
      }
    } catch (error) {
      logger.error('x-follow', `Immediate signal matching failed: ${error.message}`, {
        activity_id: activity.id
      });
    }
  }

  return matched;
}

async function markPollFailure(kol, pollRun, status, error, result = {}) {
  await db.query(
    `UPDATE x_follow_poll_runs
     SET status = $1, completed_at = NOW(), page_count = $2,
         returned_count = $3, credits_used = $4, last_error = $5
     WHERE id = $6`,
    [
      status,
      result.pageCount || 0,
      result.users?.length || 0,
      result.credits || 0,
      String(error?.message || error || status).slice(0, 1000),
      pollRun.id
    ]
  );
  await db.query(
    `UPDATE x_kol_accounts SET follow_poll_status = $1, updated_at = NOW() WHERE id = $2`,
    [status, kol.id]
  );
}

async function run(deps = {}) {
  if (running) return { status: 'skipped', reason: 'already_running' };
  if (providerName() !== 'twitterapi') {
    return { status: 'skipped', reason: 'twitterapi_provider_required' };
  }

  running = true;
  let lockClient;
  let kol;
  let pollRun;
  try {
    const intervalMs = Math.max(30000, Number(process.env.TWITTERAPI_IO_FOLLOW_INTERVAL_MS || 60000));
    kol = deps.kol || await selectKol(intervalMs);
    if (!kol) return { status: 'idle' };

    lockClient = await db.pool.connect();
    const lockResult = await lockClient.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [`x-follow-poll:${kol.id}`]
    );
    if (!lockResult.rows[0].locked) return { status: 'skipped', reason: 'kol_locked', kol_id: kol.id };

    const pollType = kol.follow_baseline_completed_at ? 'incremental' : 'baseline';
    pollRun = await createPollRun(kol, pollType);
    const xClient = deps.xClient || createXClient();
    const result = pollType === 'baseline'
      ? await fetchBaseline(xClient, kol)
      : await fetchIncremental(xClient, kol);

    if (result.gapDetected) {
      const error = new Error('Known follow boundary was not found before the page limit');
      error.code = 'FOLLOW_GAP_DETECTED';
      await markPollFailure(kol, pollRun, 'gap_detected', error, result);
      return { status: 'gap_detected', kol_handle: kol.x_handle, page_count: result.pageCount };
    }

    if (pollType === 'baseline') {
      await completeBaseline(kol, pollRun, result);
      return {
        status: 'baseline_initialized',
        kol_handle: kol.x_handle,
        following_count: result.users.length,
        page_count: result.pageCount
      };
    }

    const activities = await completeIncremental(kol, pollRun, result);
    const matchedSignals = await matchInsertedActivities(activities, deps.wsBroadcast);
    if (activities.length > 0 && deps.wsBroadcast) {
      deps.wsBroadcast({
        type: 'x:follow-detected',
        payload: {
          kolId: kol.id,
          kolHandle: kol.x_handle,
          count: activities.length,
          matchedSignals
        }
      });
    }
    return {
      status: 'completed',
      kol_handle: kol.x_handle,
      new_follows: activities.map((activity) => activity.target_x_handle),
      matched_signals: matchedSignals,
      page_count: result.pageCount
    };
  } catch (error) {
    if (kol && pollRun) {
      const status = error.code === 'PROVIDER_BUDGET_EXCEEDED' ? 'budget_blocked' : 'failed';
      await markPollFailure(kol, pollRun, status, error).catch((markError) => {
        logger.error('x-follow', `Failed to record poll failure: ${markError.message}`);
      });
    }
    logger.error('x-follow', `Followings poll failed${kol ? ` for @${kol.x_handle}` : ''}: ${error.message}`);
    throw error;
  } finally {
    if (lockClient && kol) {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [`x-follow-poll:${kol.id}`])
        .catch(() => {});
      lockClient.release();
    }
    running = false;
  }
}

module.exports = {
  run,
  fetchBaseline,
  fetchIncremental,
  matchInsertedActivities
};
