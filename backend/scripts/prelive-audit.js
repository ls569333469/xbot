require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

const EXPIRE_STALE_FLAG = '--expire-stale';

async function query(sql, params = []) {
  const result = await db.query(sql, params);
  return result.rows;
}

async function listState() {
  const liveRecorded = await query(
    `SELECT signal.id, signal.status, signal.execution_mode, signal.created_at,
            signal.reject_reason, signal.signal_type, signal.activity_id,
            signal.whitelist_id, activity.provider, activity.source_created_at,
            activity.kol_handle, activity.activity_type, activity.tweet_text
       FROM trade_signals signal
       JOIN x_activities activity ON activity.id = signal.activity_id
      WHERE signal.status = 'recorded' AND signal.execution_mode = 'live'
      ORDER BY signal.id`
  );
  const runtime = await query(
    `SELECT key, value_json, updated_at
       FROM trade_runtime_state
      WHERE key = 'live_engine_control'`
  );
  const pendingFollowEvents = await query(
    `SELECT id, policy_id, target_handle, status, provider_created_at,
            completed_at, signal_id, whitelist_id, failure_code
       FROM follow_discovery_events
      WHERE status IN ('pending', 'processing')
      ORDER BY id`
  );
  const pendingActivation = await query(
    `SELECT whitelist_id, desired_version, status, attempt_count,
            last_error_code, next_attempt_at, created_at
       FROM whitelist_activation_outbox
      WHERE status IN ('pending', 'processing')
      ORDER BY next_attempt_at, created_at`
  );
  const heartbeats = await query(
    `SELECT role, instance_id, process_id, status_json, started_at, heartbeat_at,
            GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - heartbeat_at)) * 1000)::int) AS age_ms
       FROM service_heartbeats
      ORDER BY role`
  );
  return { liveRecorded, runtime, pendingFollowEvents, pendingActivation, heartbeats };
}

async function expireStaleSignals() {
  const maxAgeSeconds = Math.max(1, Number(process.env.SIGNAL_MAX_AGE_SECONDS || 300));
  return query(
    `WITH stale AS (
       SELECT signal.id,
              CASE
                WHEN lower(COALESCE(activity.provider, '')) = '6551'
                  AND activity.source_created_at IS NULL
                  THEN 'SOURCE_EVENT_TIME_MISSING'
                ELSE 'P22_STALE_PRELIVE_SIGNAL'
              END AS reason
         FROM trade_signals signal
         JOIN x_activities activity ON activity.id = signal.activity_id
        WHERE signal.status = 'recorded'
          AND signal.execution_mode = 'live'
          AND (
            (lower(COALESCE(activity.provider, '')) = '6551'
              AND activity.source_created_at IS NULL)
            OR CASE WHEN lower(COALESCE(activity.provider, '')) = '6551'
              THEN activity.source_created_at
              ELSE COALESCE(activity.source_created_at, signal.created_at)
            END < NOW() - ($1 * INTERVAL '1 second')
          )
     )
     UPDATE trade_signals signal
        SET status = 'expired',
            reject_reason = stale.reason,
            updated_at = NOW()
       FROM stale
      WHERE signal.id = stale.id
      RETURNING signal.id, signal.status, signal.reject_reason, signal.updated_at`,
    [maxAgeSeconds]
  );
}

async function main() {
  const before = await listState();
  console.log(JSON.stringify({ mode: process.env.TRADING_MODE || null, before }, null, 2));
  if (process.argv.includes(EXPIRE_STALE_FLAG)) {
    const expired = await expireStaleSignals();
    console.log(JSON.stringify({ expired }, null, 2));
    const after = await listState();
    console.log(JSON.stringify({ after }, null, 2));
  }
}

main()
  .catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
