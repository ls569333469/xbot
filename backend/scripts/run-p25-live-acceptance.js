require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const db = require('../lib/db');
const { scopeKey } = require('../lib/gmgn-shared-rate-limit');

// P25 makes only the terminal swap mandatory. Gas is chain-adapter dependent;
// security, quote, and token info are explicit opt-ins and may be absent.
const REQUIRED_STAGES = Object.freeze(['swap']);
const OPTIONAL_STAGES = Object.freeze(['security', 'gas', 'quote', 'token_info']);
const BOUNDED_STAGES = Object.freeze({ order_query: 4, strategy_association: 2 });
const DEFAULT_TIMEOUT_SECONDS = 900;
const DEFAULT_POLL_MS = 1000;

function parseArgs(argv = []) {
  const result = {
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    pollMs: DEFAULT_POLL_MS,
    strategies: ['dynamic', 'follow']
  };
  for (const item of argv) {
    const [key, ...valueParts] = String(item).split('=');
    const value = valueParts.join('=').replace(/^"|"$/g, '');
    if (key === '--timeout-seconds' && Number.isInteger(Number(value))) {
      result.timeoutSeconds = Math.max(30, Math.min(3600, Number(value)));
    } else if (key === '--poll-ms' && Number.isInteger(Number(value))) {
      result.pollMs = Math.max(250, Math.min(10000, Number(value)));
    } else if (key === '--strategies' && value) {
      result.strategies = value.split(',').map((entry) => entry.trim().toLowerCase())
        .filter((entry) => ['dynamic', 'follow'].includes(entry));
    } else if (key === '--confirm') {
      result.confirmation = value;
    }
  }
  return result;
}

function strategyPredicate(strategy) {
  if (strategy === 'dynamic') return 'signal.actor_policy_id IS NOT NULL';
  if (strategy === 'follow') return 'signal.follow_discovery_policy_id IS NOT NULL';
  throw new Error(`Unsupported P25 strategy: ${strategy}`);
}

function strategyLabel(strategy) {
  return strategy === 'dynamic' ? 'P20 dynamic' : 'P21 follow discovery';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runtimeState(executor = db) {
  const result = await executor.query(
    `SELECT value_json
       FROM trade_runtime_state
      WHERE key = 'live_engine_control'`
  );
  const value = result.rows[0]?.value_json || {};
  return {
    mode: String(process.env.TRADING_MODE || '').toLowerCase(),
    desiredRunning: Boolean(value.desired_running),
    status: value.status || 'unknown',
    scopeType: value.scope_type || 'unknown',
    scopeChains: value.scope_chain_ids || []
  };
}

async function findFreshSignal(strategy, since, excludedIds = [], executor = db) {
  const excluded = excludedIds.length > 0 ? 'AND signal.id <> ALL($2::int[])' : '';
  const params = excludedIds.length > 0 ? [since, excludedIds] : [since];
  const result = await executor.query(
    `SELECT signal.id, signal.status, signal.execution_mode, signal.created_at,
            signal.actor_policy_id, signal.follow_discovery_policy_id,
            signal.reject_reason, signal.signal_type,
            whitelist.chain_id, whitelist.contract_address, whitelist.symbol,
            activity.activity_type, activity.kol_handle, activity.source_created_at
       FROM trade_signals AS signal
       JOIN ca_whitelist AS whitelist ON whitelist.id = signal.whitelist_id
       LEFT JOIN x_activities AS activity ON activity.id = signal.activity_id
      WHERE signal.created_at >= $1
        AND signal.execution_mode = 'live'
        AND (${strategyPredicate(strategy)})
        ${excluded}
      ORDER BY signal.created_at ASC
      LIMIT 1`,
    params
  );
  return result.rows[0] || null;
}

async function loadExecutionEvidence(signalId, since, executor = db) {
  const [pathResult, providerResult] = await Promise.all([
    executor.query(
      `SELECT signal.id AS signal_id,
              signal.status AS signal_status,
              signal.reject_reason,
              signal.actor_policy_id,
              signal.follow_discovery_policy_id,
              whitelist.chain_id,
              whitelist.contract_address,
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                'id', attempt.id,
                'side', attempt.side,
                'status', attempt.status,
                'error_code', attempt.error_code,
                'trace_id', attempt.trace_id
              )) FILTER (WHERE attempt.id IS NOT NULL), '[]'::jsonb) AS attempts,
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                'id', orders.id,
                'provider_order_id', orders.provider_order_id,
                'tx_hash', orders.tx_hash,
                'status', orders.normalized_status
              )) FILTER (WHERE orders.id IS NOT NULL), '[]'::jsonb) AS orders,
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                'id', receipt.id,
                'tx_hash', receipt.tx_hash,
                'status', receipt.receipt_status
              )) FILTER (WHERE receipt.id IS NOT NULL), '[]'::jsonb) AS receipts,
              COUNT(DISTINCT position.id)::int AS position_count,
              COUNT(DISTINCT lot.id)::int AS lot_count,
              COALESCE(array_agg(DISTINCT position.execution_mode)
                FILTER (WHERE position.id IS NOT NULL), ARRAY[]::text[]) AS position_modes
         FROM trade_signals AS signal
         JOIN ca_whitelist AS whitelist ON whitelist.id = signal.whitelist_id
         LEFT JOIN trade_attempts AS attempt
           ON attempt.signal_id = signal.id AND attempt.side = 'buy'
         LEFT JOIN trade_orders AS orders ON orders.attempt_id = attempt.id
         LEFT JOIN chain_receipts AS receipt ON receipt.order_id = orders.id
         LEFT JOIN positions AS position ON position.signal_id = signal.id
         LEFT JOIN position_lots AS lot ON lot.position_id = position.id
        WHERE signal.id = $1
        GROUP BY signal.id, signal.status, signal.reject_reason,
                 signal.actor_policy_id, signal.follow_discovery_policy_id,
                 whitelist.chain_id, whitelist.contract_address`,
      [signalId]
    ),
    executor.query(
      `SELECT id, endpoint, http_status,
              context_json->>'stage' AS stage,
              context_json->>'trace_id' AS trace_id,
              context_json->>'execution_session_id' AS execution_session_id,
              context_json->>'rate_scope' AS rate_scope,
              error_code, created_at
         FROM provider_rate_events
        WHERE provider = 'gmgn'
          AND signal_id = $1
          AND created_at >= $2
        ORDER BY id ASC`,
      [signalId, since]
    )
  ]);
  return {
    path: pathResult.rows[0] || null,
    provider: providerResult.rows
  };
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function verifyEvidence(evidence, expectedScope = scopeKey()) {
  const path = evidence?.path;
  const attempts = jsonArray(path?.attempts);
  const orders = jsonArray(path?.orders);
  const receipts = jsonArray(path?.receipts);
  const provider = jsonArray(evidence?.provider);
  const errors = [];

  if (!path) errors.push('SIGNAL_NOT_FOUND');
  if (path?.signal_status !== 'executed') errors.push(`SIGNAL_NOT_EXECUTED:${path?.signal_status || 'missing'}`);
  const confirmedAttempt = attempts.find((item) => item.status === 'confirmed');
  const confirmedOrder = orders.find((item) => item.status === 'confirmed' && item.tx_hash && item.provider_order_id);
  const confirmedReceipt = receipts.find((item) => item.status === 'confirmed' && item.tx_hash);
  if (attempts.length !== 1) errors.push(`BUY_ATTEMPT_COUNT:${attempts.length}`);
  if (!confirmedAttempt) errors.push('BUY_ATTEMPT_NOT_CONFIRMED');
  if (orders.length !== 1) errors.push(`ORDER_COUNT:${orders.length}`);
  if (!confirmedOrder) errors.push('GMGN_ORDER_NOT_CONFIRMED');
  if (!confirmedReceipt) errors.push('RPC_RECEIPT_NOT_CONFIRMED');
  if (Number(path?.position_count || 0) !== 1) errors.push(`POSITION_COUNT:${path?.position_count || 0}`);
  if (Number(path?.lot_count || 0) < 1) errors.push(`POSITION_LOT_COUNT:${path?.lot_count || 0}`);
  if (!jsonArray(path?.position_modes).includes('live')) errors.push('POSITION_NOT_LIVE');

  const stages = new Map();
  const sessions = new Set();
  const traces = new Set();
  const scopes = new Set();
  for (const item of provider) {
    stages.set(item.stage, (stages.get(item.stage) || 0) + 1);
    if (item.execution_session_id) sessions.add(item.execution_session_id);
    if (item.trace_id) traces.add(item.trace_id);
    if (item.rate_scope) scopes.add(item.rate_scope);
  }
  for (const stage of REQUIRED_STAGES) {
    if (stages.get(stage) !== 1) errors.push(`GMGN_STAGE_${stage.toUpperCase()}_COUNT:${stages.get(stage) || 0}`);
  }
  for (const stage of OPTIONAL_STAGES) {
    if ((stages.get(stage) || 0) > 1) errors.push(`GMGN_STAGE_${stage.toUpperCase()}_COUNT:${stages.get(stage)}`);
  }
  for (const [stage, maximum] of Object.entries(BOUNDED_STAGES)) {
    if ((stages.get(stage) || 0) > maximum) {
      errors.push(`GMGN_STAGE_${stage.toUpperCase()}_COUNT:${stages.get(stage)}`);
    }
  }
  if (stages.get('swap') !== 1) errors.push('GMGN_SWAP_NOT_SINGLE');
  const expectedSession = path?.signal_id ? `signal:${path.signal_id}` : null;
  if (!expectedSession || !sessions.has(expectedSession)) {
    errors.push(`EXECUTION_SESSION_INVALID:${[...sessions].join(',') || 'missing'}`);
  }
  if (traces.size !== 1) errors.push(`TRACE_INVALID:${[...traces].join(',') || 'missing'}`);
  if (scopes.size !== 1 || !scopes.has(expectedScope)) {
    errors.push(`RATE_SCOPE_INVALID:${[...scopes].join(',') || 'missing'}`);
  }
  return {
    passed: errors.length === 0,
    errors,
    signalId: path?.signal_id || null,
    chain: path?.chain_id || null,
    contractAddress: path?.contract_address || null,
    providerStages: Object.fromEntries(stages),
    attemptId: confirmedAttempt?.id || null,
    providerOrderId: confirmedOrder?.provider_order_id || null,
    txHash: confirmedOrder?.tx_hash || confirmedReceipt?.tx_hash || null,
    receiptStatus: confirmedReceipt?.status || null,
    positionCount: Number(path?.position_count || 0),
    lotCount: Number(path?.lot_count || 0)
  };
}

async function waitForSignal(strategy, startedAt, timeoutAt, usedIds, options) {
  while (Date.now() < timeoutAt) {
    const signal = await findFreshSignal(strategy, startedAt, [...usedIds]);
    if (signal) return signal;
    await wait(options.pollMs);
  }
  throw new Error(`${strategyLabel(strategy)} signal timeout`);
}

async function waitForSettlement(signal, startedAt, timeoutAt, options) {
  let latest = null;
  while (Date.now() < timeoutAt) {
    latest = await loadExecutionEvidence(signal.id, startedAt);
    const result = verifyEvidence(latest);
    if (result.passed) return { result, evidence: latest };
    if (['rejected', 'expired', 'signal_only'].includes(latest.path?.signal_status)) {
      const error = new Error(`${strategyLabel(signal.actor_policy_id ? 'dynamic' : 'follow')} signal ${signal.id} stopped: ${latest.path.reject_reason || latest.path.signal_status}`);
      error.evidence = result;
      throw error;
    }
    await wait(options.pollMs);
  }
  const error = new Error(`Signal ${signal.id} settlement timeout`);
  error.evidence = verifyEvidence(latest);
  throw error;
}

async function run(options = parseArgs(process.argv.slice(2))) {
  const confirmation = options.confirmation || process.env.P25_REAL_TEST_CONFIRM;
  if (confirmation !== 'EXECUTE P25 REAL TEST') {
    throw new Error('Explicit confirmation required: --confirm="EXECUTE P25 REAL TEST"');
  }
  if (!Array.isArray(options.strategies) || options.strategies.length === 0) {
    throw new Error('At least one strategy must be selected');
  }
  const state = await runtimeState();
  if (state.mode !== 'live' || !state.desiredRunning || state.status !== 'running') {
    throw new Error(`Live engine is not armed: mode=${state.mode}, desired=${state.desiredRunning}, status=${state.status}`);
  }

  const startedAt = (await db.query('SELECT NOW() AS started_at')).rows[0].started_at;
  const timeoutAt = Date.now() + options.timeoutSeconds * 1000;
  const usedIds = new Set();
  const results = [];
  console.log(JSON.stringify({
    event: 'p25_live_acceptance_started',
    startedAt,
    timeoutSeconds: options.timeoutSeconds,
    strategies: options.strategies,
    scope: state.scopeType,
    chains: state.scopeChains
  }));

  try {
    for (const strategy of options.strategies) {
      const signal = await waitForSignal(strategy, startedAt, timeoutAt, usedIds, options);
      usedIds.add(Number(signal.id));
      console.log(JSON.stringify({
        event: 'p25_live_signal_detected',
        strategy,
        signalId: signal.id,
        chain: signal.chain_id,
        contractAddress: signal.contract_address,
        activityType: signal.activity_type,
        actor: signal.kol_handle
      }));
      const settlement = await waitForSettlement(signal, startedAt, timeoutAt, options);
      results.push({ strategy, signalId: signal.id, ...settlement.result });
      console.log(JSON.stringify({ event: 'p25_live_strategy_passed', strategy, ...settlement.result }));
    }
    const summary = { event: 'p25_live_acceptance_passed', results };
    console.log(JSON.stringify(summary));
    return summary;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'p25_live_acceptance_failed',
      code: error.code || 'P25_LIVE_ACCEPTANCE_FAILED',
      error: error.message,
      evidence: error.evidence || null,
      completed: results
    }));
    throw error;
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) {
  run().catch(() => process.exitCode = 1);
}

module.exports = {
  REQUIRED_STAGES,
  findFreshSignal,
  loadExecutionEvidence,
  parseArgs,
  runtimeState,
  strategyLabel,
  strategyPredicate,
  verifyEvidence
};
