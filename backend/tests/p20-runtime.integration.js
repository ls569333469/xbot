const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');
const { runMigrations } = require('../lib/migrations');
const policyService = require('../domains/dynamic-signal/policy-service');
const { enqueueForActivity } = require('../domains/dynamic-signal/event-queue');
const candidateRepository = require('../domains/dynamic-signal/candidate-repository');
const { DynamicSignalWorker } = require('../domains/dynamic-signal/event-worker');
const { DynamicLaunchWindowWorker, requestWindow } = require('../jobs/dynamic-launch-window');
const paperWorker = require('../domains/dynamic-signal/paper-worker');

test('P20 launch window worker can poll an empty PostgreSQL queue', async () => {
  await runMigrations();
  const previous = {
    dynamic: process.env.P20_DYNAMIC_RESOLUTION_ENABLED,
    record: process.env.P20_RECORD_ENABLED
  };
  process.env.P20_DYNAMIC_RESOLUTION_ENABLED = 'true';
  process.env.P20_RECORD_ENABLED = 'true';
  try {
    const output = await new DynamicLaunchWindowWorker({ db }).runOnce();
    assert.deepEqual(output, { status: 'idle' });
  } finally {
    if (previous.dynamic === undefined) delete process.env.P20_DYNAMIC_RESOLUTION_ENABLED;
    else process.env.P20_DYNAMIC_RESOLUTION_ENABLED = previous.dynamic;
    if (previous.record === undefined) delete process.env.P20_RECORD_ENABLED;
    else process.env.P20_RECORD_ENABLED = previous.record;
  }
});

test('P20 dynamic 6551 activity writes one idempotent job inside the database boundary', async () => {
  await runMigrations();
  const previous = {
    dynamic: process.env.P20_DYNAMIC_RESOLUTION_ENABLED,
    record: process.env.P20_RECORD_ENABLED
  };
  process.env.P20_DYNAMIC_RESOLUTION_ENABLED = 'true';
  process.env.P20_RECORD_ENABLED = 'true';
  const client = await db.pool.connect();
  let activityId;
  let kolId;
  try {
    await client.query('BEGIN');
    const kol = await client.query(
      `INSERT INTO x_kol_accounts(x_handle, enabled) VALUES ($1, true) RETURNING id`,
      [`p20runtime${Date.now()}`]
    );
    kolId = kol.rows[0].id;
    const policy = await policyService.upsert(kolId, {
      allowed_chain_ids: ['bsc'],
      approved_aliases: ['何必东奔西走']
    }, client);
    assert.deepEqual(policy.approved_aliases, ['何必东奔西走']);
    const activity = await client.query(
      `INSERT INTO x_activities
        (kol_id, kol_handle, activity_type, tweet_id, tweet_text, provider, source_created_at)
       VALUES ($1,$2,'tweet',$3,'$TEST buy now','6551',NOW()) RETURNING *`,
      [kolId, 'p20runtime', `tweet-${Date.now()}`]
    );
    activityId = activity.rows[0].id;
    const first = await enqueueForActivity(activity.rows[0], null, client);
    const second = await enqueueForActivity(activity.rows[0], null, client);
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    const window = await requestWindow(
      { ...first[0], allowed_chain_ids: ['bsc'] },
      { extraction: { authorOwnedTerms: [{ type: 'cashtag', normalized: 'TEST' }] } },
      client
    );
    assert.deepEqual(window.observed_terms, [{ type: 'cashtag', normalized: 'TEST' }]);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    if (activityId) await db.query('DELETE FROM x_activities WHERE id = $1', [activityId]);
    if (kolId) await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [kolId]);
    client.release();
    if (previous.dynamic === undefined) delete process.env.P20_DYNAMIC_RESOLUTION_ENABLED;
    else process.env.P20_DYNAMIC_RESOLUTION_ENABLED = previous.dynamic;
    if (previous.record === undefined) delete process.env.P20_RECORD_ENABLED;
    else process.env.P20_RECORD_ENABLED = previous.record;
  }
});

test('P20 worker cancels a queued job when its runtime mode is no longer enabled', async () => {
  await runMigrations();
  const previous = {
    dynamic: process.env.P20_DYNAMIC_RESOLUTION_ENABLED,
    record: process.env.P20_RECORD_ENABLED,
    paper: process.env.P20_PAPER_ENABLED,
    live: process.env.P20_LIVE_ENABLED
  };
  Object.assign(process.env, {
    P20_DYNAMIC_RESOLUTION_ENABLED: 'true', P20_RECORD_ENABLED: 'true',
    P20_PAPER_ENABLED: 'true', P20_LIVE_ENABLED: 'true'
  });
  let activityId;
  let kolId;
  try {
    const kol = await db.query(
      `INSERT INTO x_kol_accounts(x_handle, enabled) VALUES ($1, true) RETURNING id`,
      [`p20stale${Date.now()}`]
    );
    kolId = kol.rows[0].id;
    await policyService.upsert(kolId, {
      mode: 'live', allowed_chain_ids: ['bsc'], budget_per_trade: 0.01,
      daily_budget: 0.02, daily_new_token_limit: 1
    });
    const activity = await db.query(
      `INSERT INTO x_activities
        (kol_id, kol_handle, activity_type, tweet_id, tweet_text, provider, source_created_at)
       VALUES ($1,$2,'tweet',$3,'$STALE buy now','6551',NOW()) RETURNING *`,
      [kolId, 'p20stale', `tweet-${Date.now()}`]
    );
    activityId = activity.rows[0].id;
    const jobs = await enqueueForActivity(activity.rows[0], null);
    assert.equal(jobs[0].mode, 'live');
    process.env.P20_LIVE_ENABLED = 'false';
    const output = await new DynamicSignalWorker({ db }).runOnce();
    assert.deepEqual(output, {
      status: 'cancelled', jobId: jobs[0].id, reason: 'runtime_mode_changed'
    });
    const status = await db.query(
      'SELECT status, failure_code FROM dynamic_signal_jobs WHERE id = $1', [jobs[0].id]
    );
    assert.deepEqual(status.rows[0], {
      status: 'cancelled', failure_code: 'DYNAMIC_RUNTIME_MODE_CHANGED'
    });
    const attempts = await db.query(
      'SELECT COUNT(*)::int AS count FROM dynamic_ca_resolution_attempts WHERE dynamic_job_id = $1',
      [jobs[0].id]
    );
    assert.equal(attempts.rows[0].count, 0);
  } finally {
    if (activityId) await db.query('DELETE FROM x_activities WHERE id = $1', [activityId]);
    if (kolId) await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [kolId]);
    const flagKeys = {
      dynamic: 'P20_DYNAMIC_RESOLUTION_ENABLED', record: 'P20_RECORD_ENABLED',
      paper: 'P20_PAPER_ENABLED', live: 'P20_LIVE_ENABLED'
    };
    for (const [key, value] of Object.entries(previous)) {
      const envKey = flagKeys[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test('P20 paper sessions automatically complete after their seven-day window', async () => {
  await runMigrations();
  let kolId;
  try {
    const kol = await db.query(
      `INSERT INTO x_kol_accounts(x_handle, enabled) VALUES ($1, true) RETURNING id`,
      [`p20paper${Date.now()}`]
    );
    kolId = kol.rows[0].id;
    const policy = await policyService.upsert(kolId, {
      mode: 'paper',
      allowed_chain_ids: ['bsc'],
      budget_per_trade: 0.001,
      daily_budget: 0.01,
      daily_new_token_limit: 1,
      per_token_buy_limit: 1,
      slippage: 10
    });
    const session = await db.query(
      `INSERT INTO dynamic_paper_sessions
        (actor_policy_id, policy_revision, started_at, ends_at)
       VALUES ($1,$2,NOW() - INTERVAL '8 days',NOW() - INTERVAL '1 day') RETURNING id`,
      [policy.id, policy.revision]
    );
    const completed = await paperWorker.completeEligibleSessions(db);
    assert.ok(completed.some((row) => Number(row.id) === Number(session.rows[0].id)));
    const stored = await db.query(
      'SELECT status, completed_at, summary FROM dynamic_paper_sessions WHERE id = $1',
      [session.rows[0].id]
    );
    assert.equal(stored.rows[0].status, 'completed');
    assert.ok(stored.rows[0].completed_at);
    assert.equal(Number(stored.rows[0].summary.evaluations), 0);
  } finally {
    if (kolId) await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [kolId]);
  }
});

test('P20 record worker resolves a cached GMGN candidate without creating a trade', async () => {
  await runMigrations();
  const previous = {
    dynamic: process.env.P20_DYNAMIC_RESOLUTION_ENABLED,
    record: process.env.P20_RECORD_ENABLED,
    paper: process.env.P20_PAPER_ENABLED,
    live: process.env.P20_LIVE_ENABLED
  };
  Object.assign(process.env, {
    P20_DYNAMIC_RESOLUTION_ENABLED: 'true', P20_RECORD_ENABLED: 'true',
    P20_PAPER_ENABLED: 'false', P20_LIVE_ENABLED: 'false'
  });
  const client = await db.pool.connect();
  let activityId;
  let kolId;
  try {
    await client.query('BEGIN');
    const kol = await client.query(
      `INSERT INTO x_kol_accounts(x_handle, enabled) VALUES ($1, true) RETURNING id`,
      [`p20worker${Date.now()}`]
    );
    kolId = kol.rows[0].id;
    await policyService.upsert(kolId, { allowed_chain_ids: ['bsc'] }, client);
    await candidateRepository.upsertCandidate({
      chainId: 'bsc', contractAddress: '0x0000000000000000000000000000000000000002',
      symbol: 'WORKER', name: 'Worker Token', providerStatus: 'verified',
      tradableStatus: 'tradable', sources: ['test']
    }, 'gmgn_info', client);
    const activity = await client.query(
      `INSERT INTO x_activities
        (kol_id, kol_handle, activity_type, tweet_id, tweet_text, provider, source_created_at)
       VALUES ($1,$2,'tweet',$3,'$WORKER buy now','6551',NOW()) RETURNING *`,
      [kolId, 'p20worker', `tweet-${Date.now()}`]
    );
    activityId = activity.rows[0].id;
    await enqueueForActivity(activity.rows[0], null, client);
    await client.query('COMMIT');
    const worker = new DynamicSignalWorker({ db });
    const output = await worker.runOnce();
    assert.equal(output.status, 'completed');
    const resolution = await db.query(
      `SELECT status, selected_variant_id FROM dynamic_ca_resolution_attempts
       WHERE x_activity_id = $1`, [activityId]
    );
    assert.equal(resolution.rows[0].status, 'resolved');
    assert.ok(resolution.rows[0].selected_variant_id);
    const signals = await db.query('SELECT COUNT(*)::int AS count FROM trade_signals WHERE activity_id = $1', [activityId]);
    assert.equal(signals.rows[0].count, 0);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    if (activityId) await db.query('DELETE FROM x_activities WHERE id = $1', [activityId]);
    if (kolId) await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [kolId]);
    client.release();
    const flagKeys = {
      dynamic: 'P20_DYNAMIC_RESOLUTION_ENABLED', record: 'P20_RECORD_ENABLED',
      paper: 'P20_PAPER_ENABLED', live: 'P20_LIVE_ENABLED'
    };
    for (const [key, value] of Object.entries(previous)) {
      const envKey = flagKeys[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test.after(async () => { await db.pool.end(); });
