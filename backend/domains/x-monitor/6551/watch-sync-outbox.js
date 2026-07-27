const db = require('../../../lib/db');
const { normalizeXHandle } = require('../../../lib/x-handles');

async function enqueueWatchSyncForHandles(handles, executor = db) {
  const normalized = [...new Set((handles || []).map(normalizeXHandle).filter(Boolean))];
  for (const actorHandle of normalized) {
    await executor.query(
      `INSERT INTO x_watch_sync_outbox(
         actor_handle, desired_version, status, attempt_count, next_attempt_at,
         locked_at, last_error, requested_at, updated_at
       ) VALUES ($1, 1, 'pending', 0, NOW(), NULL, NULL, NOW(), NOW())
       ON CONFLICT (actor_handle) DO UPDATE
       SET desired_version = x_watch_sync_outbox.desired_version + 1,
           status = 'pending', attempt_count = 0, next_attempt_at = NOW(),
           locked_at = NULL, last_error = NULL, requested_at = NOW(), updated_at = NOW()`,
      [actorHandle]
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
  failWatchSync
};
