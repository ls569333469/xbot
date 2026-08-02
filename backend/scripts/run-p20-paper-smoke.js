const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const databaseName = String(process.env.DB_NAME || '').trim();
const productionDatabase = String(process.env.XBOT_PRODUCTION_DB_NAME || '').trim();

if (!databaseName || !/test/i.test(databaseName) || databaseName === productionDatabase) {
  throw new Error('P20 Paper smoke test requires a dedicated test database');
}
if (String(process.env.TRADING_MODE || '').toLowerCase() === 'live'
    || String(process.env.LIVE_TRADING_ENABLED || '').toLowerCase() === 'true'
    || String(process.env.P20_LIVE_ENABLED || '').toLowerCase() === 'true') {
  throw new Error('P20 Paper smoke test refuses any live trading configuration');
}
if (String(process.env.P20_DYNAMIC_RESOLUTION_ENABLED || '').toLowerCase() !== 'true'
    || String(process.env.P20_RECORD_ENABLED || '').toLowerCase() !== 'true'
    || String(process.env.P20_PAPER_ENABLED || '').toLowerCase() !== 'true') {
  throw new Error('P20 Paper smoke test requires Dynamic Resolution + Record + Paper');
}

const db = require('../lib/db');
const gmgnHttp = require('../lib/gmgn-http');
const kolQueries = require('../domains/kol/queries');
const policyService = require('../domains/dynamic-signal/policy-service');
const candidateRepository = require('../domains/dynamic-signal/candidate-repository');
const eventQueue = require('../domains/dynamic-signal/event-queue');

const HANDLE = `p20pap${Date.now().toString().slice(-8)}`;
const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000021';
let swapCallCount = 0;

gmgnHttp.getTokenInfo = async () => ({
  address: CONTRACT_ADDRESS,
  decimals: 18,
  symbol: 'P20PAPER',
  price: { price: '0.01' }
});
gmgnHttp.getUserInfo = async () => ({
  wallets: [{
    chain: 'bsc',
    address: '0x0000000000000000000000000000000000000001',
    balances: [{ symbol: 'BNB', balance: '1', usd_value: '600' }]
  }]
});
gmgnHttp.swap = async () => {
  swapCallCount += 1;
  throw new Error('Paper smoke test must never call GMGN swap');
};

const { DynamicSignalWorker } = require('../domains/dynamic-signal/event-worker');

async function main() {
  const kol = await kolQueries.create({
    x_user_id: `test-${HANDLE}`,
    x_handle: HANDLE,
    display_name: 'P20 Paper Smoke',
    chain_ids: ['bsc'],
    weight: 5,
    enabled: true,
    profile_status: 'verified',
    profile_attempt_count: 0,
    profile_next_retry_at: null
  });
  const policy = await policyService.upsert(kol.id, {
    mode: 'paper',
    enabled: true,
    allowed_chain_ids: ['bsc'],
    allowed_event_types: ['tweet'],
    allowed_term_types: ['ca', 'cashtag', 'hashtag'],
    budget_per_trade: 0.001,
    daily_budget: 0.01,
    daily_new_token_limit: 2,
    per_token_buy_limit: 1,
    slippage: 10
  });
  await candidateRepository.upsertCandidate({
    chainId: 'bsc',
    contractAddress: CONTRACT_ADDRESS,
    symbol: 'P20PAPER',
    name: 'P20 Paper Token',
    providerStatus: 'verified',
    tradableStatus: 'tradable',
    sources: ['paper_smoke']
  }, 'gmgn_info', db, { expiresAt: new Date(Date.now() + 5 * 60_000) });

  const tweetId = `p20-paper-${Date.now()}`;
  const activity = (await db.query(
    `INSERT INTO x_activities
      (kol_id, kol_handle, activity_type, tweet_id, tweet_text, provider, source_created_at)
     VALUES ($1,$2,'tweet',$3,'$P20PAPER buy now','test',NOW()) RETURNING *`,
    [kol.id, HANDLE, tweetId]
  )).rows[0];
  const jobs = await eventQueue.enqueueForActivity(activity, null, db);
  assert.equal(jobs.length, 1, 'Paper smoke event must enqueue exactly one job');

  const output = await new DynamicSignalWorker({ db }).runOnce();
  assert.equal(output.status, 'completed');
  assert.equal(output.resolutionStatus, 'resolved');
  assert.equal(output.signal?.execution_mode, 'paper');

  const resolution = (await db.query(
    'SELECT id, status FROM dynamic_ca_resolution_attempts WHERE x_activity_id = $1',
    [activity.id]
  )).rows[0];
  const target = (await db.query(
    `SELECT id, mode, whitelist_id, config_snapshot
     FROM dynamic_targets WHERE resolution_attempt_id = $1`,
    [resolution.id]
  )).rows[0];
  const signal = (await db.query(
    `SELECT id, execution_mode, status, whitelist_id
     FROM trade_signals WHERE activity_id = $1`,
    [activity.id]
  )).rows[0];
  const session = (await db.query(
    `SELECT id, status, policy_revision FROM dynamic_paper_sessions
     WHERE actor_policy_id = $1 AND policy_revision = $2 ORDER BY id DESC LIMIT 1`,
    [policy.id, policy.revision]
  )).rows[0];
  const evaluation = (await db.query(
    `SELECT id, status, position_id, entry_snapshot
     FROM dynamic_paper_evaluations WHERE paper_session_id = $1 AND dynamic_target_id = $2`,
    [session.id, target.id]
  )).rows[0];
  const position = (await db.query(
    `SELECT id, execution_mode, status, amount_in, entry_price
     FROM positions WHERE id = $1`,
    [evaluation.position_id]
  )).rows[0];

  assert.equal(resolution.status, 'resolved');
  assert.equal(target.mode, 'paper');
  assert.equal(Number(target.config_snapshot.budget_per_trade), 0.001);
  assert.equal(target.config_snapshot.exit_strategy.version, 1);
  assert.equal(signal.execution_mode, 'paper');
  assert.equal(session.status, 'running');
  assert.equal(evaluation.status, 'open');
  assert.equal(Number(evaluation.entry_snapshot.amount_in), 0.001);
  assert.equal(position.execution_mode, 'paper');
  assert.equal(position.status, 'open');
  assert.equal(Number(position.amount_in), 0.001);
  assert.equal(swapCallCount, 0, 'Paper mode must not call GMGN swap');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    database: databaseName,
    kolId: kol.id,
    policyId: policy.id,
    policyRevision: policy.revision,
    activityId: activity.id,
    jobId: jobs[0].id,
    resolutionId: resolution.id,
    targetId: target.id,
    signalId: signal.id,
    paperSessionId: session.id,
    evaluationId: evaluation.id,
    positionId: position.id,
    swapCallCount
  })}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
