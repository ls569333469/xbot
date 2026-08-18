const db = require('../../lib/db');

const CUSTOM_LABELS_PROJECTION = `COALESCE((
  SELECT json_agg(
    json_build_object('id', label.id::text, 'name', label.name)
    ORDER BY lower(label.name), label.id
  )
  FROM x_kol_account_labels AS account_label
  JOIN x_kol_labels AS label ON label.id = account_label.label_id
  WHERE account_label.kol_id = kol.id
), '[]'::json) AS custom_labels`;

async function getAll(filters = {}, executor = db) {
  const tag = String(filters.tag || filters.chain_id || '').trim().toLowerCase();
  const search = String(filters.search || '').trim();
  const labelId = String(filters.label_id || '').trim();
  const res = await executor.query(
    `SELECT kol.*, ${CUSTOM_LABELS_PROJECTION}
     FROM x_kol_accounts AS kol
     WHERE ($1 = ''
       OR kol.x_handle ILIKE '%' || $1 || '%'
       OR kol.display_name ILIKE '%' || $1 || '%'
       OR EXISTS (
         SELECT 1
         FROM x_kol_account_labels AS searched_account_label
         JOIN x_kol_labels AS searched_label ON searched_label.id = searched_account_label.label_id
         WHERE searched_account_label.kol_id = kol.id
           AND searched_label.name ILIKE '%' || $1 || '%'
       ))
       AND ($2 = ''
         OR ($2 = 'unclassified' AND cardinality(COALESCE(kol.chain_ids, '{}')) = 0)
         OR $2 = ANY(COALESCE(kol.chain_ids, '{}')))
       AND ($3 = '' OR EXISTS (
         SELECT 1 FROM x_kol_account_labels AS filtered_account_label
         WHERE filtered_account_label.kol_id = kol.id
           AND filtered_account_label.label_id::text = $3
       ))
     ORDER BY kol.weight DESC, lower(kol.x_handle)`,
    [search, tag, labelId]
  );
  return res.rows;
}

async function getById(id, executor = db, options = {}) {
  const lock = options.forUpdate ? ' FOR UPDATE' : '';
  const res = await executor.query(
    `SELECT kol.*, ${CUSTOM_LABELS_PROJECTION}
     FROM x_kol_accounts AS kol WHERE kol.id = $1${lock}`,
    [id]
  );
  return res.rows[0];
}

async function create(data, executor = db) {
  const existing = await executor.query(
    `SELECT * FROM x_kol_accounts
     WHERE lower(regexp_replace(x_handle, '^@+', '')) = lower(regexp_replace($1, '^@+', ''))
        OR (NULLIF($2, '') IS NOT NULL AND x_user_id = $2)
     ORDER BY
       CASE WHEN lower(regexp_replace(x_handle, '^@+', '')) = lower(regexp_replace($1, '^@+', '')) THEN 0 ELSE 1 END,
       enabled DESC,
       id
     LIMIT 1`,
    [data.x_handle, data.x_user_id || '']
  );
  if (existing.rows[0]) {
    const current = existing.rows[0];
    const sameHandle = String(current.x_handle || '').replace(/^@+/, '').toLowerCase()
      === String(data.x_handle || '').replace(/^@+/, '').toLowerCase();
    const preserveVerifiedIdentity = sameHandle && current.profile_status === 'verified';
    const updated = await executor.query(
      `UPDATE x_kol_accounts
       SET x_user_id = $1, x_handle = $2, display_name = $3,
           chain_ids = $4, weight = $5, enabled = $6,
           profile_status = $7, profile_attempt_count = $8,
           profile_last_checked_at = $9, profile_next_retry_at = $10,
           profile_verified_at = $11, profile_last_error_code = $12,
           updated_at = NOW()
       WHERE id = $13
       RETURNING *`,
      [
        preserveVerifiedIdentity ? current.x_user_id : (data.x_user_id || data.x_handle),
        data.x_handle,
        data.display_name || data.x_handle,
        data.chain_ids || [],
        data.weight ?? 5,
        data.enabled !== false,
        preserveVerifiedIdentity ? 'verified' : (data.profile_status || 'pending'),
        preserveVerifiedIdentity ? current.profile_attempt_count : Number(data.profile_attempt_count || 0),
        preserveVerifiedIdentity ? current.profile_last_checked_at : (data.profile_last_checked_at || null),
        preserveVerifiedIdentity ? null : (data.profile_next_retry_at || new Date()),
        preserveVerifiedIdentity ? current.profile_verified_at : null,
        preserveVerifiedIdentity ? null : (data.profile_last_error_code || null),
        current.id
      ]
    );
    return updated.rows[0];
  }

  const res = await executor.query(
    `INSERT INTO x_kol_accounts
       (x_user_id, x_handle, display_name, chain_ids, weight, enabled,
        profile_status, profile_attempt_count, profile_next_retry_at, profile_last_error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      data.x_user_id || data.x_handle,
      data.x_handle,
      data.display_name || data.x_handle,
      data.chain_ids || [],
      data.weight ?? 5,
      data.enabled !== false,
      data.profile_status || 'pending',
      Number(data.profile_attempt_count || 0),
      data.profile_next_retry_at || new Date(),
      data.profile_last_error_code || null
    ]
  );
  return res.rows[0];
}

async function update(id, data, executor = db) {
  const res = await executor.query(
    `UPDATE x_kol_accounts SET
       x_user_id = COALESCE($1, x_user_id),
       x_handle = COALESCE($2, x_handle),
       display_name = COALESCE($3, display_name),
       chain_ids = COALESCE($4, chain_ids),
       weight = COALESCE($5, weight),
       profile_status = CASE WHEN $6 THEN 'pending' ELSE profile_status END,
       profile_attempt_count = CASE WHEN $6 THEN 0 ELSE profile_attempt_count END,
       profile_last_checked_at = CASE WHEN $6 THEN NULL ELSE profile_last_checked_at END,
       profile_next_retry_at = CASE WHEN $6 THEN NOW() ELSE profile_next_retry_at END,
       profile_verified_at = CASE WHEN $6 THEN NULL ELSE profile_verified_at END,
       profile_last_error_code = CASE WHEN $6 THEN NULL ELSE profile_last_error_code END,
       updated_at = NOW()
     WHERE id = $7
     RETURNING *`,
    [data.x_user_id, data.x_handle, data.display_name, data.chain_ids, data.weight, data.identity_reset === true, id]
  );
  return res.rows[0];
}

async function claimPendingProfiles(limit = 1, leaseMs = 300000) {
  const res = await db.query(
    `WITH candidates AS (
       SELECT id
       FROM x_kol_accounts
       WHERE profile_status = 'pending'
         AND COALESCE(profile_next_retry_at, NOW()) <= NOW()
       ORDER BY COALESCE(profile_next_retry_at, created_at), id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE x_kol_accounts AS kol
     SET profile_next_retry_at = NOW() + make_interval(secs => $2::int)
     FROM candidates
     WHERE kol.id = candidates.id
     RETURNING kol.*`,
    [Math.max(1, Number(limit || 1)), Math.max(30, Math.ceil(Number(leaseMs || 300000) / 1000))]
  );
  return res.rows;
}

async function completeProfileVerification(id, expectedHandle, profile) {
  const res = await db.query(
    `UPDATE x_kol_accounts
     SET x_user_id = $1,
         x_handle = $2,
         display_name = CASE
           WHEN display_name IS NULL OR btrim(display_name) = '' OR lower(display_name) = lower($3)
             THEN COALESCE(NULLIF($4, ''), display_name, $2)
           ELSE display_name
         END,
         profile_status = 'verified',
         profile_attempt_count = profile_attempt_count + 1,
         profile_last_checked_at = NOW(),
         profile_next_retry_at = NULL,
         profile_verified_at = NOW(),
         profile_last_error_code = NULL,
         updated_at = NOW()
     WHERE id = $5
       AND lower(regexp_replace(x_handle, '^@+', '')) = lower(regexp_replace($3, '^@+', ''))
     RETURNING *`,
    [profile.id, profile.handle || expectedHandle, expectedHandle, profile.name || '', id]
  );
  return res.rows[0] || null;
}

async function failProfileVerification(id, errorCode, nextRetryAt) {
  const res = await db.query(
    `UPDATE x_kol_accounts
     SET profile_status = 'pending',
         profile_attempt_count = profile_attempt_count + 1,
         profile_last_checked_at = NOW(),
         profile_next_retry_at = $1,
         profile_last_error_code = $2,
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [nextRetryAt, String(errorCode || 'X_PROFILE_UNAVAILABLE').slice(0, 80), id]
  );
  return res.rows[0] || null;
}

async function scheduleProfileRetry(id) {
  const res = await db.query(
    `UPDATE x_kol_accounts
     SET profile_status = 'pending',
         profile_next_retry_at = NOW(),
         profile_last_error_code = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

async function toggle(id, executor = db) {
  const res = await executor.query(
    'UPDATE x_kol_accounts SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1 RETURNING *',
    [id]
  );
  return res.rows[0];
}

async function remove(id, executor = db) {
  await executor.query('DELETE FROM x_kol_accounts WHERE id = $1', [id]);
  return true;
}

async function getDependencyImpact(id, executor = db) {
  const result = await executor.query(
    `SELECT
       COALESCE((SELECT array_agg(DISTINCT whitelist_id)
         FROM (
           SELECT whitelist_id FROM x_signal_relations WHERE kol_id = $1
           UNION SELECT whitelist_id FROM x_signal_source_rules WHERE actor_id = $1
         ) AS affected), '{}'::int[]) AS whitelist_ids,
       COALESCE((SELECT array_agg(DISTINCT launch_rule_id)
         FROM (
           SELECT launch_rule_id FROM project_launch_sources WHERE actor_id = $1
           UNION SELECT launch_rule_id FROM project_launch_relations WHERE actor_id = $1
         ) AS affected), '{}'::bigint[]) AS launch_rule_ids,
       (SELECT COUNT(*)::int FROM x_activities WHERE kol_id = $1) AS activity_count`,
    [Number(id)]
  );
  return result.rows[0] || { whitelist_ids: [], launch_rule_ids: [], activity_count: 0 };
}

async function getActivities(id, limit) {
  const res = await db.query('SELECT * FROM x_activities WHERE kol_id = $1 ORDER BY created_at DESC LIMIT $2', [id, limit || 20]);
  return res.rows;
}

module.exports = {
  claimPendingProfiles,
  completeProfileVerification,
  create,
  failProfileVerification,
  getActivities,
  getAll,
  getById,
  getDependencyImpact,
  remove,
  scheduleProfileRetry,
  toggle,
  update
};
