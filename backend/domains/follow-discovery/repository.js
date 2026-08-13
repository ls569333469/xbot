const crypto = require('crypto');
const db = require('../../lib/db');
const { parseResetAt } = require('../../lib/gmgn-rate-scheduler');

async function listEvents(filters = {}, executor = db) {
  const params = [];
  let where = 'WHERE 1=1';
  if (filters.policy_id) {
    params.push(Number(filters.policy_id));
    where += ` AND event.policy_id = $${params.length}`;
  }
  if (filters.status) {
    params.push(String(filters.status));
    where += ` AND event.status = $${params.length}`;
  }
  params.push(Math.min(200, Math.max(1, Number(filters.limit || 50))));
  const result = await executor.query(
    `SELECT event.*, policy.kol_id, policy.revision AS current_policy_revision,
            kol.x_handle AS current_actor_handle
     FROM follow_discovery_events event
     JOIN follow_discovery_policies policy ON policy.id = event.policy_id
     JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     ${where} ORDER BY event.provider_created_at DESC LIMIT $${params.length}`, params
  );
  return result.rows;
}

async function getEvent(id, executor = db) {
  const result = await executor.query(
    `SELECT event.*, policy.kol_id, policy.enabled AS policy_enabled,
            policy.mode AS current_mode, policy.revision AS current_policy_revision,
            policy.context_hash, policy.allowed_chain_ids, policy.trade_config_snapshot,
            policy.resolver_options, kol.enabled AS kol_enabled
     FROM follow_discovery_events event
     JOIN follow_discovery_policies policy ON policy.id = event.policy_id
     JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     WHERE event.id = $1`, [Number(id)]
  );
  return result.rows[0] || null;
}

async function enqueueFollow({ activity, providerEventId, item, kol }, executor = db) {
  if (item.activityType !== 'follow') return [];
  const actorUserId = String(kol.x_user_id || '').trim();
  const targetUserId = String(item.targetUserId || '').trim();
  const actorHandle = String(item.actorHandle || '').trim().toLowerCase();
  const targetHandle = String(item.targetHandles?.[0] || '').trim().toLowerCase();
  if (!actorUserId || !targetUserId || !targetHandle
      || actorUserId.toLowerCase() === actorHandle
      || targetUserId.toLowerCase() === targetHandle) return [];
  const policies = await executor.query(
    `SELECT policy.*
     FROM follow_discovery_policies policy
     JOIN x_kol_accounts actor ON actor.id = policy.kol_id
     JOIN LATERAL (
       SELECT status, desired_present, desired_flags
       FROM x_watch_sync_outbox
       WHERE actor_handle = lower(regexp_replace(actor.x_handle, '^@+', ''))
       ORDER BY updated_at DESC, desired_version DESC LIMIT 1
     ) watch ON watch.status = 'succeeded'
       AND watch.desired_present = true
       AND watch.desired_flags->>'newFlwBol' = 'true'
     WHERE policy.kol_id = $1 AND policy.archived_at IS NULL
       AND policy.enabled = true AND policy.mode <> 'paused'`, [Number(kol.id)]
  );
  const output = [];
  for (const policy of policies.rows) {
    const behaviorKey = `follow:${actorUserId}:${targetUserId}`;
    const isBaseline = new Date(item.sourceCreatedAt).getTime() <= new Date(policy.baseline_at).getTime();
    const result = await executor.query(
      `INSERT INTO follow_discovery_events
        (x_provider_event_id, x_activity_id, policy_id, policy_revision, mode,
         actor_user_id, actor_handle, target_user_id, target_handle, behavior_key,
         provider_created_at, status, stage, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
         CASE WHEN $12 = 'baseline' THEN NOW() ELSE NULL END)
       ON CONFLICT (behavior_key) DO NOTHING RETURNING *`,
      [providerEventId || null, activity.id, policy.id, policy.revision, policy.mode,
        actorUserId, actorHandle, targetUserId, targetHandle, behaviorKey,
        item.sourceCreatedAt, isBaseline ? 'baseline' : 'pending',
        isBaseline ? 'baseline' : 'queued']
    );
    if (result.rows[0]) output.push(result.rows[0]);
  }
  return output;
}

async function claimNext(workerId = crypto.randomUUID(), executor = db, leaseSeconds = 90) {
  const result = await executor.query(
    `WITH candidate AS (
       SELECT id FROM follow_discovery_events
       WHERE (status = 'pending' AND next_attempt_at <= NOW())
          OR (status = 'processing' AND lease_expires_at < NOW())
       ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE follow_discovery_events event SET status = 'processing', stage = 'profile',
       attempt_count = attempt_count + 1, worker_id = $1, locked_at = NOW(),
       lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),
       started_at = COALESCE(started_at, NOW()), updated_at = NOW()
     FROM candidate WHERE event.id = candidate.id RETURNING event.*`,
    [workerId, Math.max(30, Number(leaseSeconds || 90))]
  );
  return result.rows[0] || null;
}

async function renewLease(eventId, workerId, executor = db, leaseSeconds = 240) {
  const result = await executor.query(
    `UPDATE follow_discovery_events SET lease_expires_at = NOW() + ($3 * INTERVAL '1 second'),
       updated_at = NOW() WHERE id = $1 AND status = 'processing' AND worker_id = $2
       RETURNING id`,
    [Number(eventId), String(workerId), Math.max(60, Number(leaseSeconds || 240))]
  );
  return result.rows[0] || null;
}

async function markStage(eventId, stage, workerId, executor = db) {
  const result = await executor.query(
    `UPDATE follow_discovery_events SET stage = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND worker_id = $3 RETURNING id`,
    [Number(eventId), String(stage), String(workerId)]
  );
  return result.rows[0] || null;
}

async function markWaiting(eventId, error, executor = db) {
  const explicitDelay = Number(error.retryAfterSeconds);
  const resetAt = error.resetAt == null ? null : parseResetAt(error.resetAt);
  const resetDelay = Number.isFinite(resetAt)
    ? Math.ceil((resetAt - Date.now()) / 1000) + 1
    : null;
  const fallbackDelay = String(error.code || '').includes('RATE_LIMIT_BANNED') ? 300 : 60;
  const delaySeconds = Math.min(900, Math.max(15,
    Number.isFinite(explicitDelay) ? explicitDelay : resetDelay ?? fallbackDelay));
  const result = await executor.query(
    `UPDATE follow_discovery_events SET status = 'pending', stage = 'provider_wait',
       next_attempt_at = NOW() + ($2 * INTERVAL '1 second'), failure_code = $3,
       last_error = $4, locked_at = NULL, lease_expires_at = NULL, worker_id = NULL,
       updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'processing') RETURNING *`,
    [Number(eventId), delaySeconds, error.code || 'FOLLOW_PROVIDER_WAIT',
      String(error.message || error).slice(0, 1000)]
  );
  return result.rows[0] || null;
}

async function markFailed(eventId, error, executor = db) {
  const result = await executor.query(
    `UPDATE follow_discovery_events SET status = $2, stage = 'completed',
       failure_code = $3, last_error = $4, locked_at = NULL, lease_expires_at = NULL,
       worker_id = NULL, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'processing') RETURNING *`,
    [Number(eventId), error.rejected ? 'rejected' : 'failed',
      error.code || 'FOLLOW_DISCOVERY_FAILED', String(error.message || error).slice(0, 1000)]
  );
  return result.rows[0] || null;
}

module.exports = { claimNext, enqueueFollow, getEvent, listEvents, markFailed, markStage, markWaiting, renewLease };
