const db = require('../../lib/db');
const { p20FeatureState } = require('../../lib/p20-features');
const { chainBudgetFor } = require('./policy-service');

async function evaluateSignal(signal, executor = db, options = {}) {
  const blockers = [];
  const flags = options.flags || p20FeatureState();
  if (!flags.P20_LIVE_ENABLED) blockers.push('P20_LIVE_DISABLED');
  const result = await executor.query(
    `SELECT policy.*, approval.id AS approval_id, approval.expires_at AS approval_expires_at,
            approval.policy_revision AS approval_revision,
            approval.context_hash AS approval_context_hash,
            target.status AS target_status, target.chain_id AS target_chain,
            target.contract_address AS target_ca, target.context_hash AS target_context_hash,
            kol.enabled AS kol_enabled
     FROM x_actor_dynamic_policies policy
     JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     LEFT JOIN dynamic_live_approvals approval ON approval.actor_policy_id = policy.id
       AND approval.status = 'active' AND approval.expires_at > NOW()
     LEFT JOIN dynamic_targets target ON target.id = $2
     WHERE policy.id = $1 ${options.lock ? 'FOR UPDATE OF policy' : ''}`,
    [Number(signal.actor_policy_id), Number(signal.dynamic_target_id)]
  );
  const row = result.rows[0];
  if (!row) blockers.push('DYNAMIC_POLICY_NOT_FOUND');
  if (row && (!row.enabled || row.mode !== 'live' || !row.kol_enabled)) blockers.push('DYNAMIC_POLICY_NOT_LIVE');
  if (row && Number(row.revision) !== Number(signal.actor_policy_revision)) blockers.push('DYNAMIC_POLICY_REVISION_CHANGED');
  if (row && row.context_hash !== signal.dynamic_policy_context_hash) blockers.push('DYNAMIC_POLICY_CONTEXT_CHANGED');
  if (row && (!row.approval_id || Number(row.approval_revision) !== Number(row.revision)
      || row.approval_context_hash !== row.context_hash)) blockers.push('DYNAMIC_LIVE_APPROVAL_INVALID');
  if (row && (row.target_status !== 'active' || row.target_chain !== signal.chain_id
      || row.target_ca !== signal.contract_address
      || row.target_context_hash !== row.context_hash)) blockers.push('DYNAMIC_TARGET_CHANGED');
  const chainBudget = row ? chainBudgetFor(row, signal.chain_id) : null;
  if (row && !chainBudget) blockers.push('DYNAMIC_CHAIN_BUDGET_NOT_CONFIGURED');
  if (row && !row.allowed_event_types.includes(String(signal.activity_type || '').toLowerCase())) {
    blockers.push('DYNAMIC_EVENT_NOT_ALLOWED');
  }
  if (!signal.source_created_at) blockers.push('SOURCE_EVENT_TIME_MISSING');
  const ageMs = Date.now() - new Date(signal.source_created_at || signal.signal_created_at).getTime();
  const maxAgeMs = Math.max(1, Number(process.env.SIGNAL_MAX_AGE_SECONDS || 300)) * 1000;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) blockers.push('SIGNAL_EXPIRED');
  if (row && !options.skipUsage && chainBudget) {
    const usageResult = await executor.query(
      `SELECT COALESCE(usage.spent_native, 0) AS spent_native,
              COALESCE(usage.reserved_native, 0) AS reserved_native,
              COALESCE(usage.new_token_count, 0) AS new_token_count,
              (SELECT COUNT(*)::int FROM positions position
               WHERE position.chain_id = $2 AND position.contract_address = $3
                 AND position.execution_mode = 'live'
                 AND position.status IN('pending','open','open_unprotected','open_protected',
                   'partially_closed','closing','close_uncertain','protection_failed')) AS open_positions,
              (SELECT COUNT(*)::int FROM trade_attempts attempt
               WHERE attempt.chain = $2 AND attempt.output_token = $3 AND attempt.side = 'buy'
                 AND attempt.status IN('reserved','preparing','submitting','submitted','confirming',
                   'submission_uncertain','reconciliation_required','confirmed')) AS token_buys,
              (SELECT COUNT(*)::int FROM dynamic_policy_usage_events event
               WHERE event.actor_policy_id = $1 AND event.usage_date = CURRENT_DATE
                 AND event.chain_id = $2 AND event.contract_address = $3
                 AND event.status <> 'released') AS existing_token_events
       FROM (SELECT 1) seed
       LEFT JOIN dynamic_policy_usage_daily_by_chain usage
         ON usage.actor_policy_id = $1 AND usage.usage_date = CURRENT_DATE
        AND usage.chain_id = $2`,
      [row.id, signal.chain_id, signal.contract_address]
    );
    const usage = usageResult.rows[0];
    if (Number(usage.open_positions) > 0) blockers.push('DYNAMIC_CA_POSITION_EXISTS');
    if (Number(usage.token_buys) >= Number(row.per_token_buy_limit)) blockers.push('DYNAMIC_TOKEN_BUY_LIMIT');
    if (Number(usage.existing_token_events) === 0
        && Number(usage.new_token_count) >= Number(row.daily_new_token_limit)) {
      blockers.push('DYNAMIC_DAILY_TOKEN_LIMIT');
    }
    if (chainBudget && Number(usage.spent_native) + Number(usage.reserved_native)
        + chainBudget.budget_per_trade > chainBudget.daily_budget) {
      blockers.push('DYNAMIC_DAILY_BUDGET_EXCEEDED');
    }
  }
  return { allowed: blockers.length === 0, blockers, policy: row || null };
}

async function reserveUsage(signal, executor = db) {
  const evaluation = await evaluateSignal(signal, executor, { lock: true });
  if (!evaluation.allowed) {
    const error = new Error(`Dynamic authorization rejected: ${evaluation.blockers.join(', ')}`);
    error.code = evaluation.blockers[0];
    error.details = evaluation;
    throw error;
  }
  const event = await executor.query(
    `INSERT INTO dynamic_policy_usage_events
      (actor_policy_id, signal_id, chain_id, contract_address, amount_native, counts_new_token)
     SELECT $1,$2,$3,$4,$5,NOT EXISTS(
       SELECT 1 FROM dynamic_policy_usage_events
       WHERE actor_policy_id = $1 AND usage_date = CURRENT_DATE
         AND chain_id = $3 AND contract_address = $4 AND status <> 'released'
     )
     ON CONFLICT (signal_id) DO NOTHING RETURNING *`,
    [Number(signal.actor_policy_id), Number(signal.signal_id || signal.id),
       signal.chain_id, signal.contract_address,
       Number(chainBudgetFor(evaluation.policy, signal.chain_id).budget_per_trade)]
  );
  if (event.rows.length === 0) return evaluation;
  await executor.query(
    `INSERT INTO dynamic_policy_usage_daily_by_chain
      (actor_policy_id, usage_date, chain_id, reserved_native, new_token_count, signal_count)
     VALUES ($1,CURRENT_DATE,$2,$3,$4,1)
     ON CONFLICT (actor_policy_id, usage_date, chain_id) DO UPDATE SET
       reserved_native = dynamic_policy_usage_daily_by_chain.reserved_native + EXCLUDED.reserved_native,
       new_token_count = dynamic_policy_usage_daily_by_chain.new_token_count + EXCLUDED.new_token_count,
       signal_count = dynamic_policy_usage_daily_by_chain.signal_count + EXCLUDED.signal_count,
       updated_at = NOW()`,
    [Number(signal.actor_policy_id), signal.chain_id,
      Number(chainBudgetFor(evaluation.policy, signal.chain_id).budget_per_trade),
      event.rows[0].counts_new_token ? 1 : 0]
  );
  return evaluation;
}

async function settleUsage(signalId, status, actualAmount, executor = db) {
  if (!['committed', 'released'].includes(status)) throw new Error('Invalid dynamic usage settlement');
  const eventResult = await executor.query(
    `UPDATE dynamic_policy_usage_events SET status = $2, updated_at = NOW()
     WHERE signal_id = $1 AND status = 'reserved' RETURNING *`,
    [Number(signalId), status]
  );
  const event = eventResult.rows[0];
  if (!event) return false;
  const amount = status === 'committed' && Number.isFinite(Number(actualAmount))
    ? Number(actualAmount) : Number(event.amount_native);
  await executor.query(
    `UPDATE dynamic_policy_usage_daily_by_chain SET
       reserved_native = GREATEST(0, reserved_native - $3),
       spent_native = spent_native + CASE WHEN $2 = 'committed' THEN $4 ELSE 0 END,
       new_token_count = GREATEST(0, new_token_count - CASE WHEN $2 = 'released' AND $6 THEN 1 ELSE 0 END),
       updated_at = NOW()
      WHERE actor_policy_id = $1 AND usage_date = $5 AND chain_id = $7`,
    [event.actor_policy_id, status, event.amount_native, amount, event.usage_date,
      event.counts_new_token, event.chain_id]
  );
  return true;
}

async function commitUsage(signalId, amount, executor = db) {
  return settleUsage(signalId, 'committed', amount, executor);
}

async function releaseUsage(signalId, executor = db) {
  return settleUsage(signalId, 'released', null, executor);
}

async function releaseUsageByAttempt(attemptId, executor = db) {
  const result = await executor.query(
    'SELECT signal_id FROM trade_attempts WHERE id = $1', [Number(attemptId)]
  );
  return result.rows[0]?.signal_id ? releaseUsage(result.rows[0].signal_id, executor) : false;
}

async function approve(policyId, input = {}, executor = db) {
  if (input.confirmation !== 'APPROVE P20 DYNAMIC LIVE') {
    const error = new Error('Explicit dynamic live confirmation is required');
    error.code = 'DYNAMIC_LIVE_CONFIRMATION_REQUIRED';
    throw error;
  }
  const policyResult = await executor.query(
    'SELECT * FROM x_actor_dynamic_policies WHERE id = $1', [Number(policyId)]
  );
  const policy = policyResult.rows[0];
  if (!policy || policy.mode !== 'live' || !policy.enabled) {
    const error = new Error('Policy must be enabled in live mode before approval');
    error.code = 'DYNAMIC_POLICY_NOT_LIVE';
    throw error;
  }
  const paperResult = await executor.query(
    `SELECT id FROM dynamic_paper_sessions
     WHERE actor_policy_id = $1 AND policy_revision = $2 AND status = 'completed'
       AND completed_at - started_at >= INTERVAL '7 days'
     ORDER BY id DESC LIMIT 1`, [policy.id, policy.revision]
  );
  if (paperResult.rows.length === 0) {
    const error = new Error('A completed seven-day Paper session is required');
    error.code = 'DYNAMIC_PAPER_ACCEPTANCE_REQUIRED';
    throw error;
  }
  const minutes = Math.min(24 * 60, Math.max(5, Number(input.duration_minutes || 30)));
  await executor.query(
    `UPDATE dynamic_live_approvals SET status = 'revoked', revoked_at = NOW()
     WHERE actor_policy_id = $1 AND status = 'active'`, [policy.id]
  );
  const result = await executor.query(
    `INSERT INTO dynamic_live_approvals
      (actor_policy_id, policy_revision, context_hash, approved_by, approval_note, expires_at)
     VALUES ($1,$2,$3,$4,$5,NOW() + ($6 * INTERVAL '1 minute')) RETURNING *`,
    [policy.id, policy.revision, policy.context_hash, input.approved_by || 'admin',
      input.approval_note || null, minutes]
  );
  await executor.query(
    'UPDATE x_actor_dynamic_policies SET last_approved_revision = revision WHERE id = $1', [policy.id]
  );
  return result.rows[0];
}

async function revoke(policyId, executor = db) {
  await executor.query(
    `UPDATE dynamic_live_approvals SET status = 'revoked', revoked_at = NOW()
     WHERE actor_policy_id = $1 AND status = 'active'`, [Number(policyId)]
  );
}

module.exports = {
  approve, commitUsage, evaluateSignal, releaseUsage, releaseUsageByAttempt,
  reserveUsage, revoke, settleUsage
};
