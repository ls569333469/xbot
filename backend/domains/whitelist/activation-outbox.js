const db = require('../../lib/db');

async function enqueueWhitelistActivation(whitelistId, executor = db, options = {}) {
  const increment = options.increment !== false;
  const updated = await executor.query(
    `UPDATE ca_whitelist
     SET activation_version = activation_version + CASE WHEN $2 THEN 1 ELSE 0 END,
         live_activation_state = 'syncing',
         activation_context_hash = NULL,
         activation_error_code = NULL,
         activation_error_detail = NULL,
         activation_checked_at = NULL,
         activated_at = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status = 'active'
     RETURNING id, activation_version`,
    [Number(whitelistId), increment]
  );
  const item = updated.rows[0] || null;
  if (!item) return null;
  await executor.query(
    `INSERT INTO whitelist_activation_outbox(
       whitelist_id, desired_version, status, attempt_count, next_attempt_at,
       locked_at, last_error_code, last_error_detail, requested_at, completed_at, updated_at
     ) VALUES ($1,$2,'pending',0,NOW(),NULL,NULL,NULL,NOW(),NULL,NOW())
     ON CONFLICT (whitelist_id) DO UPDATE
     SET desired_version = EXCLUDED.desired_version,
         status = 'pending', attempt_count = 0, next_attempt_at = NOW(),
         locked_at = NULL, last_error_code = NULL, last_error_detail = NULL,
         requested_at = NOW(), completed_at = NULL, updated_at = NOW()`,
    [item.id, item.activation_version]
  );
  return item;
}

async function retryWhitelistActivation(whitelistId, executor = db) {
  return enqueueWhitelistActivation(whitelistId, executor, { increment: true });
}

async function claimActivationBatch(limit = 2, executor = db) {
  const result = await executor.query(
    `WITH due AS (
       SELECT whitelist_id
       FROM whitelist_activation_outbox
       WHERE (status = 'pending' AND next_attempt_at <= NOW())
          OR (status = 'processing' AND locked_at < NOW() - INTERVAL '2 minutes')
       ORDER BY next_attempt_at, requested_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE whitelist_activation_outbox AS item
     SET status = 'processing', locked_at = NOW(), updated_at = NOW()
     FROM due
     WHERE item.whitelist_id = due.whitelist_id
     RETURNING item.*`,
    [Math.max(1, Number(limit) || 1)]
  );
  return result.rows;
}

async function deferActivation(row, error, executor = db) {
  const attemptCount = Number(row.attempt_count || 0) + 1;
  const delaySeconds = Math.min(30, 2 ** Math.min(5, attemptCount));
  const code = String(error.code || 'ACTIVATION_CHECK_FAILED').slice(0, 120);
  const detail = String(error.message || code).slice(0, 1000);
  await executor.query(
    `UPDATE whitelist_activation_outbox
     SET status = CASE WHEN desired_version = $2 THEN 'pending' ELSE 'pending' END,
         attempt_count = CASE WHEN desired_version = $2 THEN $3 ELSE 0 END,
         next_attempt_at = CASE WHEN desired_version = $2
           THEN NOW() + ($4::double precision * INTERVAL '1 second') ELSE NOW() END,
         locked_at = NULL,
         last_error_code = CASE WHEN desired_version = $2 THEN $5 ELSE NULL END,
         last_error_detail = CASE WHEN desired_version = $2 THEN $6 ELSE NULL END,
         updated_at = NOW()
     WHERE whitelist_id = $1`,
    [row.whitelist_id, Number(row.desired_version), attemptCount, delaySeconds, code, detail]
  );
  await executor.query(
    `UPDATE ca_whitelist
     SET live_activation_state = 'syncing', activation_error_code = $3,
         activation_error_detail = $4, activation_checked_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND activation_version = $2 AND status = 'active'`,
    [row.whitelist_id, Number(row.desired_version), code, detail]
  );
}

async function failActivation(row, error, executor = db) {
  const code = String(error.code || 'ACTIVATION_CHECK_FAILED').slice(0, 120);
  const detail = String(error.message || code).slice(0, 1000);
  await executor.query(
    `UPDATE whitelist_activation_outbox
     SET status = CASE WHEN desired_version = $2 THEN 'failed' ELSE 'pending' END,
         attempt_count = CASE WHEN desired_version = $2 THEN attempt_count + 1 ELSE 0 END,
         next_attempt_at = CASE WHEN desired_version = $2 THEN next_attempt_at ELSE NOW() END,
         locked_at = NULL,
         last_error_code = CASE WHEN desired_version = $2 THEN $3 ELSE NULL END,
         last_error_detail = CASE WHEN desired_version = $2 THEN $4 ELSE NULL END,
         updated_at = NOW()
     WHERE whitelist_id = $1`,
    [row.whitelist_id, Number(row.desired_version), code, detail]
  );
  await executor.query(
    `UPDATE ca_whitelist
     SET live_activation_state = 'sync_failed', activation_error_code = $3,
         activation_error_detail = $4, activation_checked_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND activation_version = $2 AND status = 'active'`,
    [row.whitelist_id, Number(row.desired_version), code, detail]
  );
  await executor.query(
    `UPDATE trade_signals
     SET status = 'signal_only', reject_reason = $3, updated_at = NOW()
     WHERE whitelist_id = $1 AND activation_wait_version = $2
       AND status = 'recorded'`,
    [row.whitelist_id, Number(row.desired_version), code]
  );
}

async function completeActivation(row, contextHash, executor = db) {
  const updated = await executor.query(
    `UPDATE ca_whitelist
     SET live_activation_state = 'live_ready', activation_context_hash = $3,
         activation_error_code = NULL, activation_error_detail = NULL,
         activation_checked_at = NOW(), activated_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND activation_version = $2 AND status = 'active'
     RETURNING id`,
    [row.whitelist_id, Number(row.desired_version), contextHash]
  );
  await executor.query(
    `UPDATE whitelist_activation_outbox
     SET status = CASE
           WHEN desired_version = $2 AND $3 THEN 'succeeded'
           ELSE 'pending'
         END,
         attempt_count = CASE WHEN desired_version = $2 AND $3 THEN 0 ELSE attempt_count END,
         next_attempt_at = CASE WHEN desired_version = $2 AND $3 THEN next_attempt_at ELSE NOW() END,
         locked_at = NULL,
         last_error_code = CASE WHEN desired_version = $2 AND $3 THEN NULL ELSE last_error_code END,
         last_error_detail = CASE WHEN desired_version = $2 AND $3 THEN NULL ELSE last_error_detail END,
         completed_at = CASE WHEN desired_version = $2 AND $3 THEN NOW() ELSE NULL END,
         updated_at = NOW()
     WHERE whitelist_id = $1`,
    [row.whitelist_id, Number(row.desired_version), updated.rows.length > 0]
  );
  return updated.rows.length > 0;
}

async function discardActivation(row, executor = db) {
  await executor.query(
    `UPDATE whitelist_activation_outbox
     SET status = CASE WHEN desired_version = $2 THEN 'succeeded' ELSE 'pending' END,
         attempt_count = CASE WHEN desired_version = $2 THEN 0 ELSE attempt_count END,
         next_attempt_at = CASE WHEN desired_version = $2 THEN next_attempt_at ELSE NOW() END,
         locked_at = NULL,
         last_error_code = CASE WHEN desired_version = $2 THEN NULL ELSE last_error_code END,
         last_error_detail = CASE WHEN desired_version = $2 THEN NULL ELSE last_error_detail END,
         completed_at = CASE WHEN desired_version = $2 THEN NOW() ELSE NULL END,
         updated_at = NOW()
     WHERE whitelist_id = $1`,
    [row.whitelist_id, Number(row.desired_version)]
  );
}

module.exports = {
  claimActivationBatch,
  completeActivation,
  deferActivation,
  discardActivation,
  enqueueWhitelistActivation,
  failActivation,
  retryWhitelistActivation
};
