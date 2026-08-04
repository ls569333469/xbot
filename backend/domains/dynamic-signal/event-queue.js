const crypto = require('crypto');
const db = require('../../lib/db');
const { p20FeatureState } = require('../../lib/p20-features');

function errorMessage(error) {
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : 'Unknown dynamic job error';
  } catch {
    return 'Unknown dynamic job error';
  }
}

function effectiveMode(policyMode, flags = p20FeatureState()) {
  if (!flags.P20_DYNAMIC_RESOLUTION_ENABLED || !flags.P20_RECORD_ENABLED) return null;
  if (policyMode === 'record') return 'record';
  if (policyMode === 'paper') return flags.P20_PAPER_ENABLED ? 'paper' : null;
  if (policyMode === 'live') return flags.P20_LIVE_ENABLED ? 'live' : null;
  return null;
}

async function enqueueForActivity(activity, providerEventId, executor = db, options = {}) {
  const flags = options.flags || p20FeatureState();
  if (!flags.P20_DYNAMIC_RESOLUTION_ENABLED || !flags.P20_RECORD_ENABLED
      || !['tweet', 'quote', 'reply'].includes(activity.activity_type)) return [];
  const policies = await executor.query(
    `SELECT policy.* FROM x_actor_dynamic_policies policy
     JOIN x_kol_accounts kol ON kol.id = policy.kol_id AND kol.enabled = true
     WHERE policy.kol_id = $1 AND policy.enabled = true AND policy.mode <> 'paused'
       AND $2 = ANY(policy.allowed_event_types)`,
    [activity.kol_id, activity.activity_type]
  );
  const output = [];
  for (const policy of policies.rows) {
    const mode = effectiveMode(policy.mode, flags);
    if (!mode) continue;
    const result = await executor.query(
      `INSERT INTO dynamic_signal_jobs
        (x_provider_event_id, x_activity_id, actor_policy_id, policy_revision, mode)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (x_activity_id, actor_policy_id, policy_revision) DO NOTHING
       RETURNING *`,
      [providerEventId || null, activity.id, policy.id, policy.revision, mode]
    );
    if (result.rows[0]) output.push(result.rows[0]);
  }
  return output;
}

async function claimNext(workerId = crypto.randomUUID(), executor = db, leaseSeconds = 60) {
  const result = await executor.query(
    `WITH candidate AS (
       SELECT id FROM dynamic_signal_jobs
       WHERE (status = 'pending' AND next_attempt_at <= NOW())
          OR (status = 'processing' AND lease_expires_at < NOW())
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE dynamic_signal_jobs job SET status = 'processing',
       attempt_count = attempt_count + 1, worker_id = $1, locked_at = NOW(),
       lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),
       started_at = COALESCE(started_at, NOW()), updated_at = NOW()
     FROM candidate WHERE job.id = candidate.id RETURNING job.*`,
    [workerId, Math.max(15, Number(leaseSeconds || 60))]
  );
  return result.rows[0] || null;
}

async function loadContext(jobId, executor = db) {
  const result = await executor.query(
    `SELECT job.*, activity.kol_id, activity.kol_handle, activity.activity_type,
            activity.tweet_id, activity.tweet_text, activity.raw_json,
            activity.provider_event_id, activity.source_created_at,
            policy.mode AS configured_mode, policy.enabled AS policy_enabled,
            policy.allowed_chain_ids, policy.allowed_event_types, policy.allowed_term_types,
            policy.approved_aliases, policy.resolver_options, policy.context_hash,
            policy.revision AS current_policy_revision
     FROM dynamic_signal_jobs job
     JOIN x_activities activity ON activity.id = job.x_activity_id
     JOIN x_actor_dynamic_policies policy ON policy.id = job.actor_policy_id
     WHERE job.id = $1`, [Number(jobId)]
  );
  return result.rows[0] || null;
}

async function renew(jobId, workerId, executor = db, leaseSeconds = 60) {
  const result = await executor.query(
    `UPDATE dynamic_signal_jobs SET lease_expires_at = NOW() + ($3 * INTERVAL '1 second'),
       locked_at = COALESCE(locked_at, NOW()), updated_at = NOW()
     WHERE id = $1 AND status = 'processing' AND worker_id = $2
       AND (lease_expires_at IS NULL OR lease_expires_at > NOW())
     RETURNING id`,
    [Number(jobId), String(workerId || ''), Math.max(15, Number(leaseSeconds || 60))]
  );
  return result.rows.length > 0;
}

async function fail(jobId, error, executor = db, workerId = null) {
  const retryable = Number(error?.attemptCount || 1) < 3;
  const result = await executor.query(
    `UPDATE dynamic_signal_jobs SET status = $2,
       next_attempt_at = CASE WHEN $2 = 'pending' THEN NOW() + INTERVAL '15 seconds' ELSE next_attempt_at END,
       failure_code = $3, last_error = $4, lease_expires_at = NULL,
       locked_at = NULL, completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE completed_at END,
        updated_at = NOW()
      WHERE id = $1 AND status = 'processing'
        AND ($5::text IS NULL OR worker_id = $5)
      RETURNING *`,
    [Number(jobId), retryable ? 'pending' : 'failed',
      String(error?.code || 'DYNAMIC_JOB_FAILED'), errorMessage(error).slice(0, 1000),
      workerId === null || workerId === undefined ? null : String(workerId)]
  );
  return result.rows[0] || null;
}

async function cancel(jobId, failureCode, executor = db, workerId = null) {
  const result = await executor.query(
    `UPDATE dynamic_signal_jobs SET status = 'cancelled', failure_code = $2,
       last_error = NULL, lease_expires_at = NULL, locked_at = NULL,
       completed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status IN('pending','processing','rejected')
        AND ($3::text IS NULL OR worker_id = $3) RETURNING *`,
    [Number(jobId), String(failureCode || 'DYNAMIC_JOB_CANCELLED'),
      workerId === null || workerId === undefined ? null : String(workerId)]
  );
  return result.rows[0] || null;
}

module.exports = {
  cancel, claimNext, effectiveMode, enqueueForActivity, errorMessage, fail, loadContext, renew
};
