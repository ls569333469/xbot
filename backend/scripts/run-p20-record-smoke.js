const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const databaseName = String(process.env.DB_NAME || '').trim();
const productionDatabase = String(process.env.XBOT_PRODUCTION_DB_NAME || '').trim();

if (!databaseName || !/test/i.test(databaseName) || databaseName === productionDatabase) {
  throw new Error('P20 Record smoke test requires a dedicated test database');
}
if (String(process.env.TRADING_MODE || '').toLowerCase() === 'live'
    || String(process.env.LIVE_TRADING_ENABLED || '').toLowerCase() === 'true'
    || String(process.env.P20_LIVE_ENABLED || '').toLowerCase() === 'true') {
  throw new Error('P20 Record smoke test refuses any live trading configuration');
}
if (String(process.env.P20_DYNAMIC_RESOLUTION_ENABLED || '').toLowerCase() !== 'true'
    || String(process.env.P20_RECORD_ENABLED || '').toLowerCase() !== 'true'
    || String(process.env.P20_PAPER_ENABLED || '').toLowerCase() === 'true') {
  throw new Error('P20 Record smoke test requires Dynamic Resolution + Record only');
}

const db = require('../lib/db');
const kolQueries = require('../domains/kol/queries');
const policyService = require('../domains/dynamic-signal/policy-service');
const candidateRepository = require('../domains/dynamic-signal/candidate-repository');
const eventQueue = require('../domains/dynamic-signal/event-queue');
const { DynamicSignalWorker } = require('../domains/dynamic-signal/event-worker');

const HANDLE = `p20rec${Date.now().toString().slice(-8)}`;
const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000020';

async function waitForJob(jobId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await db.query(
      'SELECT status, failure_code, last_error FROM dynamic_signal_jobs WHERE id = $1',
      [jobId]
    );
    if (result.rows[0] && !['pending', 'processing'].includes(result.rows[0].status)) {
      return result.rows[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`P20 Record smoke job ${jobId} did not finish within ${timeoutMs}ms`);
}

async function main() {
  const kol = await kolQueries.create({
    x_user_id: `test-${HANDLE}`,
    x_handle: HANDLE,
    display_name: 'P20 Record Smoke',
    chain_ids: ['bsc'],
    weight: 5,
    enabled: true,
    profile_status: 'verified',
    profile_attempt_count: 0,
    profile_next_retry_at: null
  });
  const policy = await policyService.upsert(kol.id, {
    mode: 'record',
    enabled: true,
    allowed_chain_ids: ['bsc'],
    allowed_event_types: ['tweet'],
    allowed_term_types: ['ca', 'cashtag', 'hashtag'],
    budget_per_trade: 0,
    daily_budget: 0,
    daily_new_token_limit: 0,
    per_token_buy_limit: 1,
    slippage: 10
  });
  await candidateRepository.upsertCandidate({
    chainId: 'bsc',
    contractAddress: CONTRACT_ADDRESS,
    symbol: 'P20SMOKE',
    name: 'P20 Smoke Token',
    providerStatus: 'verified',
    tradableStatus: 'tradable',
    sources: ['record_smoke']
  }, 'gmgn_info', db, { expiresAt: new Date(Date.now() + 5 * 60_000) });

  const tweetId = `p20-smoke-${Date.now()}`;
  const activity = (await db.query(
    `INSERT INTO x_activities
      (kol_id, kol_handle, activity_type, tweet_id, tweet_text, provider, source_created_at)
     VALUES ($1,$2,'tweet',$3,'$P20SMOKE buy now','test',NOW()) RETURNING *`,
    [kol.id, HANDLE, tweetId]
  )).rows[0];
  const jobs = await eventQueue.enqueueForActivity(activity, null, db);
  assert.equal(jobs.length, 1, 'Record smoke event must enqueue exactly one job');

  await new DynamicSignalWorker({ db }).runOnce();
  const job = await waitForJob(jobs[0].id);
  const resolution = (await db.query(
    `SELECT id, status, selected_variant_id, failure_code
     FROM dynamic_ca_resolution_attempts WHERE x_activity_id = $1`,
    [activity.id]
  )).rows[0];
  const signalCount = Number((await db.query(
    'SELECT COUNT(*)::int AS count FROM trade_signals WHERE activity_id = $1',
    [activity.id]
  )).rows[0].count);
  const targetCount = Number((await db.query(
    'SELECT COUNT(*)::int AS count FROM dynamic_targets WHERE resolution_attempt_id = $1',
    [resolution?.id || null]
  )).rows[0].count);

  assert.equal(job.status, 'resolved');
  assert.equal(resolution?.status, 'resolved');
  assert.ok(resolution?.selected_variant_id);
  assert.equal(signalCount, 0, 'Record mode must not create a trade signal');
  assert.equal(targetCount, 0, 'Record mode must not materialize a dynamic target');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    database: databaseName,
    kolId: kol.id,
    policyId: policy.id,
    policyRevision: policy.revision,
    activityId: activity.id,
    jobId: jobs[0].id,
    resolutionId: resolution.id,
    resolutionStatus: resolution.status,
    contractAddress: CONTRACT_ADDRESS,
    signalCount,
    targetCount
  })}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
