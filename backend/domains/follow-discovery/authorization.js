const db = require('../../lib/db');
const { chainBudgetFor } = require('./policy-service');

function enabled(env = process.env) {
  return String(env.P21_FOLLOW_DISCOVERY_ENABLED || 'false').toLowerCase() === 'true';
}

async function evaluateSignal(signal, executor = db, options = {}) {
  const blockers = [];
  if (!enabled(options.env)) blockers.push('P21_FOLLOW_DISCOVERY_DISABLED');
  const result = await executor.query(
    `SELECT policy.*, event.status AS event_status, event.chain_id AS event_chain,
            event.contract_address AS event_ca, event.provider_created_at,
            kol.enabled AS kol_enabled, watch.status AS watch_sync_status,
            watch.desired_present AS watch_desired_present,
            watch.desired_flags AS watch_desired_flags
     FROM follow_discovery_policies policy
     JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     LEFT JOIN follow_discovery_events event ON event.id = $2
     LEFT JOIN LATERAL (
       SELECT status, desired_present, desired_flags
       FROM x_watch_sync_outbox
       WHERE actor_handle = lower(regexp_replace(kol.x_handle, '^@+', ''))
       ORDER BY updated_at DESC, desired_version DESC LIMIT 1
     ) watch ON true
     WHERE policy.id = $1 ${options.lock ? 'FOR UPDATE OF policy' : ''}`,
    [Number(signal.follow_discovery_policy_id), Number(signal.follow_discovery_event_id)]
  );
  const policy = result.rows[0];
  if (!policy) blockers.push('FOLLOW_POLICY_NOT_FOUND');
  if (policy && (policy.archived_at || !policy.enabled || !policy.kol_enabled
      || policy.mode !== 'live')) blockers.push('FOLLOW_POLICY_NOT_LIVE');
  if (policy && (policy.watch_sync_status !== 'succeeded'
      || policy.watch_desired_present !== true
      || policy.watch_desired_flags?.newFlwBol !== true)) {
    blockers.push('FOLLOW_WATCH_NOT_SYNCED');
  }
  if (policy && Number(policy.revision) !== Number(signal.follow_discovery_policy_revision)) blockers.push('FOLLOW_POLICY_REVISION_CHANGED');
  if (policy && policy.context_hash !== signal.follow_discovery_context_hash) blockers.push('FOLLOW_POLICY_CONTEXT_CHANGED');
  if (policy && (policy.event_status !== 'resolved' || policy.event_chain !== signal.chain_id
      || policy.event_ca !== signal.contract_address)) blockers.push('FOLLOW_TARGET_CHANGED');
  const budget = policy ? chainBudgetFor(policy, signal.chain_id) : null;
  if (policy && !budget) blockers.push('FOLLOW_CHAIN_BUDGET_NOT_CONFIGURED');
  const sourceCreatedAt = signal.source_created_at || policy?.provider_created_at;
  const ageMs = Date.now() - new Date(sourceCreatedAt || signal.signal_created_at).getTime();
  const ttlSeconds = Number(policy?.resolver_options?.event_ttl_seconds || 900);
  if (!sourceCreatedAt) blockers.push('SOURCE_EVENT_TIME_MISSING');
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > ttlSeconds * 1000) blockers.push('SIGNAL_EXPIRED');

  if (policy && budget && !options.skipUsage) {
    const usageResult = await executor.query(
      `SELECT COALESCE(usage.spent_native, 0) AS spent_native,
              COALESCE(usage.reserved_native, 0) AS reserved_native,
              COALESCE(usage.new_token_count, 0) AS new_token_count,
              (SELECT COUNT(*)::int FROM positions position
               WHERE position.chain_id = $2 AND position.contract_address = $3
                 AND position.execution_mode = 'live'
                 AND position.status IN ('pending','open','open_unprotected','open_protected',
                   'partially_closed','closing','close_uncertain','protection_failed')) AS open_positions,
              (SELECT COUNT(*)::int FROM trade_attempts attempt
               JOIN trade_signals signal ON signal.id = attempt.signal_id
               WHERE signal.follow_discovery_policy_id = $1
                 AND attempt.chain = $2 AND attempt.output_token = $3 AND attempt.side = 'buy'
                 AND attempt.status IN ('reserved','preparing','submitting','submitted','confirming',
                   'submission_uncertain','reconciliation_required','confirmed')) AS token_buys,
              (SELECT COUNT(*)::int FROM follow_discovery_usage_events event
               WHERE event.policy_id = $1 AND event.usage_date = CURRENT_DATE
                 AND event.chain_id = $2 AND event.contract_address = $3
                 AND event.status <> 'released') AS existing_token_events
       FROM (SELECT 1) seed
       LEFT JOIN follow_discovery_usage_daily_by_chain usage
         ON usage.policy_id = $1 AND usage.usage_date = CURRENT_DATE AND usage.chain_id = $2`,
      [policy.id, signal.chain_id, signal.contract_address]
    );
    const usage = usageResult.rows[0];
    if (Number(usage.open_positions) > 0) blockers.push('FOLLOW_CA_POSITION_EXISTS');
    if (Number(usage.token_buys) >= Number(policy.trade_config_snapshot.per_token_buy_limit)) blockers.push('FOLLOW_TOKEN_BUY_LIMIT');
    if (Number(usage.existing_token_events) === 0
        && Number(policy.trade_config_snapshot.daily_new_token_limit) > 0
        && Number(usage.new_token_count) >= Number(policy.trade_config_snapshot.daily_new_token_limit)) {
      blockers.push('FOLLOW_DAILY_TOKEN_LIMIT');
    }
    if (Number(usage.spent_native) + Number(usage.reserved_native)
        + budget.budget_per_trade > budget.daily_budget) blockers.push('FOLLOW_DAILY_BUDGET_EXCEEDED');
  }
  return { allowed: blockers.length === 0, blockers, policy: policy || null };
}

async function reserveUsage(signal, executor = db) {
  const evaluation = await evaluateSignal(signal, executor, { lock: true });
  if (!evaluation.allowed) {
    const error = new Error(`Follow discovery authorization rejected: ${evaluation.blockers.join(', ')}`);
    error.code = evaluation.blockers[0];
    throw error;
  }
  const budget = chainBudgetFor(evaluation.policy, signal.chain_id);
  const event = await executor.query(
    `INSERT INTO follow_discovery_usage_events
      (policy_id, signal_id, chain_id, contract_address, amount_native, counts_new_token)
     SELECT $1,$2,$3,$4,$5,NOT EXISTS(
       SELECT 1 FROM follow_discovery_usage_events
       WHERE policy_id = $1 AND usage_date = CURRENT_DATE
         AND chain_id = $3 AND contract_address = $4 AND status <> 'released')
     ON CONFLICT (signal_id) DO NOTHING RETURNING *`,
    [evaluation.policy.id, Number(signal.signal_id || signal.id), signal.chain_id,
      signal.contract_address, budget.budget_per_trade]
  );
  if (!event.rows[0]) return evaluation;
  await executor.query(
    `INSERT INTO follow_discovery_usage_daily_by_chain
      (policy_id, usage_date, chain_id, reserved_native, new_token_count, signal_count)
     VALUES ($1,CURRENT_DATE,$2,$3,$4,1)
     ON CONFLICT (policy_id, usage_date, chain_id) DO UPDATE SET
       reserved_native = follow_discovery_usage_daily_by_chain.reserved_native + EXCLUDED.reserved_native,
       new_token_count = follow_discovery_usage_daily_by_chain.new_token_count + EXCLUDED.new_token_count,
       signal_count = follow_discovery_usage_daily_by_chain.signal_count + 1, updated_at = NOW()`,
    [evaluation.policy.id, signal.chain_id, budget.budget_per_trade,
      event.rows[0].counts_new_token ? 1 : 0]
  );
  return evaluation;
}

async function settleUsage(signalId, status, actualAmount, executor = db) {
  const result = await executor.query(
    `UPDATE follow_discovery_usage_events SET status = $2, updated_at = NOW()
     WHERE signal_id = $1 AND status = 'reserved' RETURNING *`, [Number(signalId), status]
  );
  const event = result.rows[0];
  if (!event) return false;
  const amount = status === 'committed' && Number.isFinite(Number(actualAmount))
    ? Number(actualAmount) : Number(event.amount_native);
  await executor.query(
    `UPDATE follow_discovery_usage_daily_by_chain SET
       reserved_native = GREATEST(0, reserved_native - $3),
       spent_native = spent_native + CASE WHEN $2 = 'committed' THEN $4::numeric ELSE 0 END,
       new_token_count = GREATEST(0, new_token_count - CASE WHEN $2 = 'released' AND $5 THEN 1 ELSE 0 END),
       updated_at = NOW()
     WHERE policy_id = $1 AND usage_date = $6 AND chain_id = $7`,
    [event.policy_id, status, event.amount_native, amount, event.counts_new_token,
      event.usage_date, event.chain_id]
  );
  return true;
}

const commitUsage = (signalId, amount, executor = db) => settleUsage(signalId, 'committed', amount, executor);
const releaseUsage = (signalId, executor = db) => settleUsage(signalId, 'released', null, executor);

module.exports = { commitUsage, enabled, evaluateSignal, releaseUsage, reserveUsage, settleUsage };
