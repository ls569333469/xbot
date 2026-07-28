const crypto = require('crypto');
const db = require('../../../lib/db');
const { normalizeXHandle } = require('../../../lib/x-handles');
const { normalizeWatchFlags } = require('../../../lib/x-client-6551');
const { flagsEqual, loadDesiredWatches } = require('./watch-reconciler');

function watchDemandFingerprint(present, flags = {}) {
  const normalized = normalizeWatchFlags(flags);
  return crypto.createHash('sha256')
    .update(JSON.stringify({ present: Boolean(present), flags: normalized }))
    .digest('hex');
}

function watchApplyEnabled() {
  return String(process.env.X_DATA_PROVIDER || '').toLowerCase() === '6551'
    && String(process.env.X_6551_WATCH_APPLY_ENABLED || 'false').toLowerCase() === 'true'
    && Boolean(process.env.OPENNEWS_TOKEN);
}

async function enqueueWatchSyncForHandles(handles, executor = db) {
  const normalized = [...new Set((handles || []).map(normalizeXHandle).filter(Boolean))];
  if (normalized.length === 0) return normalized;

  const [desired, localResult] = await Promise.all([
    loadDesiredWatches(executor),
    executor.query(
      `SELECT username, managed, sync_status, remote_flags
       FROM x_provider_watches
       WHERE provider = '6551' AND username = ANY($1::text[])`,
      [normalized]
    )
  ]);
  const desiredByHandle = new Map(desired.map((item) => [normalizeXHandle(item.username), item]));
  const localByHandle = new Map(localResult.rows.map((item) => [normalizeXHandle(item.username), item]));
  const disabled = !watchApplyEnabled();

  for (const actorHandle of normalized) {
    const desiredItem = desiredByHandle.get(actorHandle);
    const present = Boolean(desiredItem);
    const desiredFlags = normalizeWatchFlags(desiredItem?.flags);
    const local = localByHandle.get(actorHandle);
    const alreadyInSync = present
      ? local?.managed === true
        && local?.sync_status === 'in_sync'
        && flagsEqual(local?.remote_flags, desiredFlags)
      : !local || local.managed !== true;
    const desiredFingerprint = watchDemandFingerprint(present, desiredFlags);
    const pendingStatus = disabled ? 'failed' : 'pending';
    const pendingError = disabled ? 'WATCH_SYNC_DISABLED' : null;

    await executor.query(
      `INSERT INTO x_watch_sync_outbox(
         actor_handle, desired_version, status, attempt_count, next_attempt_at,
         locked_at, last_error, requested_at, updated_at,
         desired_present, desired_flags, desired_fingerprint, synced_at
       ) VALUES ($1, 1, $2, 0, NOW(), NULL, $3, NOW(), NOW(), $4, $5, $6,
         CASE WHEN $7 THEN NOW() ELSE NULL END)
       ON CONFLICT (actor_handle) DO UPDATE
       SET desired_version = CASE
             WHEN x_watch_sync_outbox.desired_fingerprint IS DISTINCT FROM EXCLUDED.desired_fingerprint
               THEN x_watch_sync_outbox.desired_version + 1
             ELSE x_watch_sync_outbox.desired_version
           END,
           desired_present = EXCLUDED.desired_present,
           desired_flags = EXCLUDED.desired_flags,
           desired_fingerprint = EXCLUDED.desired_fingerprint,
           status = CASE
             WHEN $7 THEN 'succeeded'
             WHEN x_watch_sync_outbox.desired_fingerprint IS DISTINCT FROM EXCLUDED.desired_fingerprint
               THEN $2
             WHEN x_watch_sync_outbox.status = 'succeeded' THEN $2
             WHEN $2 = 'failed' AND x_watch_sync_outbox.status <> 'processing' THEN 'failed'
             ELSE x_watch_sync_outbox.status
           END,
           attempt_count = CASE
             WHEN $7 OR x_watch_sync_outbox.desired_fingerprint IS DISTINCT FROM EXCLUDED.desired_fingerprint
               THEN 0
             ELSE x_watch_sync_outbox.attempt_count
           END,
           next_attempt_at = CASE
             WHEN $7 OR x_watch_sync_outbox.desired_fingerprint IS DISTINCT FROM EXCLUDED.desired_fingerprint
               THEN NOW()
             ELSE x_watch_sync_outbox.next_attempt_at
           END,
           locked_at = CASE WHEN $7 THEN NULL ELSE x_watch_sync_outbox.locked_at END,
           last_error = CASE
             WHEN $7 THEN NULL
             WHEN x_watch_sync_outbox.desired_fingerprint IS DISTINCT FROM EXCLUDED.desired_fingerprint
               OR ($2 = 'failed' AND x_watch_sync_outbox.status <> 'processing') THEN $3
             ELSE x_watch_sync_outbox.last_error
           END,
           requested_at = CASE
             WHEN x_watch_sync_outbox.desired_fingerprint IS DISTINCT FROM EXCLUDED.desired_fingerprint
               OR (NOT $7 AND x_watch_sync_outbox.status = 'succeeded') THEN NOW()
             ELSE x_watch_sync_outbox.requested_at
           END,
           synced_at = CASE WHEN $7 THEN NOW() ELSE x_watch_sync_outbox.synced_at END,
           updated_at = NOW()`,
      [
        actorHandle,
        alreadyInSync ? 'succeeded' : pendingStatus,
        alreadyInSync ? null : pendingError,
        present,
        desiredFlags,
        desiredFingerprint,
        alreadyInSync
      ]
    );
  }
  return normalized;
}

async function claimWatchSyncBatch(limit = 100, executor = db) {
  const result = await executor.query(
    `WITH due AS (
       SELECT actor_handle
       FROM x_watch_sync_outbox
       WHERE (status IN ('pending','failed') AND next_attempt_at <= NOW())
          OR (status = 'processing' AND locked_at < NOW() - INTERVAL '2 minutes')
       ORDER BY next_attempt_at, requested_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE x_watch_sync_outbox AS item
     SET status = 'processing', locked_at = NOW(), updated_at = NOW()
     FROM due
     WHERE item.actor_handle = due.actor_handle
     RETURNING item.*`,
    [Math.max(1, Number(limit) || 1)]
  );
  return result.rows;
}

async function completeWatchSync(rows, executor = db) {
  for (const row of rows) {
    await executor.query(
      `UPDATE x_watch_sync_outbox
       SET status = CASE WHEN desired_version = $2 THEN 'succeeded' ELSE 'pending' END,
           attempt_count = CASE WHEN desired_version = $2 THEN 0 ELSE attempt_count END,
           next_attempt_at = CASE WHEN desired_version = $2 THEN next_attempt_at ELSE NOW() END,
           locked_at = NULL, last_error = NULL,
           synced_at = CASE WHEN desired_version = $2 THEN NOW() ELSE synced_at END,
           updated_at = NOW()
       WHERE actor_handle = $1`,
      [row.actor_handle, Number(row.desired_version)]
    );
  }
}

async function failWatchSync(rows, error, executor = db) {
  for (const row of rows) {
    const attemptCount = Number(row.attempt_count || 0) + 1;
    const delaySeconds = Math.min(300, 2 ** Math.min(8, attemptCount));
    await executor.query(
      `UPDATE x_watch_sync_outbox
       SET status = CASE WHEN desired_version = $2 THEN 'failed' ELSE 'pending' END,
           attempt_count = CASE WHEN desired_version = $2 THEN $3 ELSE 0 END,
           next_attempt_at = CASE
             WHEN desired_version = $2 THEN NOW() + ($4::double precision * interval '1 second')
             ELSE NOW()
           END,
           locked_at = NULL,
           last_error = CASE WHEN desired_version = $2 THEN $5 ELSE NULL END,
           updated_at = NOW()
       WHERE actor_handle = $1`,
      [row.actor_handle, Number(row.desired_version), attemptCount, delaySeconds, String(error || '').slice(0, 1000)]
    );
  }
}

module.exports = {
  claimWatchSyncBatch,
  completeWatchSync,
  enqueueWatchSyncForHandles,
  failWatchSync,
  watchApplyEnabled,
  watchDemandFingerprint
};
