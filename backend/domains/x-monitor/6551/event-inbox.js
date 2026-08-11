const crypto = require('crypto');
const db = require('../../../lib/db');
const logger = require('../../../lib/logger');
const notifier = require('../../../lib/notifier');
const xMonitorQueries = require('../queries');
const { matchActivity } = require('../../signal/matcher');
const { normalizeXHandle } = require('../../../lib/x-handles');
const { normalize6551Event } = require('./normalizer');
const { enqueueForActivity } = require('../../dynamic-signal/event-queue');
const { enqueueFollow } = require('../../follow-discovery/repository');

const SENSITIVE_KEY = /(token|authorization|api[_-]?key|secret|password)/i;

function redactPayload(value) {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactPayload(item)
    ]));
  }
  if (typeof value === 'string') {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
      .replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]');
  }
  return value;
}

function providerEventIdentity(event) {
  if (event?.id !== undefined && event.id !== null && event.id !== '') {
    return { id: String(event.id), stable: true };
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(event || {})).digest('hex');
  return { id: `missing:${digest}`, stable: false };
}

async function insertInboxEvent(event, executor = db, timing = {}) {
  const identity = providerEventIdentity(event);
  const transportReceivedAt = timing.transportReceivedAt || new Date();
  const result = await executor.query(
    `INSERT INTO x_provider_events
      (provider, provider_event_id, event_type, tw_account, provider_created_at,
       raw_payload, status, last_error, transport_received_at, inbox_committed_at,
       receive_to_inbox_ms, trace_id)
     VALUES ('6551', $1, $2, $3, $4, $5, $6, $7, $8, NOW(),
       GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - $8::timestamptz)) * 1000)::int), $9)
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING *`,
    [
      identity.id,
      event?.eventType || null,
      normalizeXHandle(event?.twAccount) || null,
      event?.createdAt || null,
      redactPayload(event || {}),
      identity.stable ? 'pending' : 'dead_letter',
      identity.stable ? null : 'Provider event is missing a stable ID',
      transportReceivedAt,
      crypto.randomUUID()
    ]
  );
  return { row: result.rows[0] || null, duplicate: result.rows.length === 0, identity };
}

async function findKol(actorHandle, executor = db) {
  const result = await executor.query(
    `SELECT * FROM x_kol_accounts
     WHERE enabled = true AND lower(regexp_replace(x_handle, '^@+', '')) = $1
     LIMIT 1`,
    [normalizeXHandle(actorHandle)]
  );
  return result.rows[0] || null;
}

async function markEvent(id, values, executor = db) {
  await executor.query(
    `UPDATE x_provider_events
     SET status = $1, semantic_key = COALESCE($2, semantic_key),
         activity_ids = COALESCE($3, activity_ids), last_error = $4,
         processed_at = CASE WHEN $1 IN ('processed','ignored','dead_letter') THEN NOW() ELSE processed_at END,
         updated_at = NOW()
     WHERE id = $5`,
    [values.status, values.semanticKey || null, values.activityIds || null, values.error || null, id]
  );
}

async function processInboxEvent(row, options = {}) {
  const stateExecutor = options.executor || db;
  const client = options.client;
  const wsBroadcast = options.wsBroadcast;
  await stateExecutor.query(
    `UPDATE x_provider_events
     SET status = 'processing', attempt_count = attempt_count + 1,
         processing_started_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [row.id]
  );

  let transactionClient = null;
  let executor = stateExecutor;
  try {
    if (!options.executor) {
      transactionClient = await db.pool.connect();
      executor = transactionClient;
      await executor.query('BEGIN');
    }

    let normalized = normalize6551Event(row.raw_payload);
    let processingPath = 'fast';
    if (normalized.length === 0) {
      await markEvent(row.id, { status: 'ignored' }, executor);
      if (transactionClient) await executor.query('COMMIT');
      return { status: 'ignored', activities: [], matched: 0 };
    }

    if (normalized.some((item) => item.needsEnrichment)) {
      processingPath = 'slow_enrichment';
      if (!client) {
        const error = new Error('6551 interaction target requires Tweet by ID enrichment');
        error.code = 'X6551_ENRICHMENT_REQUIRED';
        throw error;
      }
      const tweetId = normalized.find((item) => item.needsEnrichment)?.tweetId;
      const enrichment = await client.getTweetById(tweetId);
      normalized = normalize6551Event(row.raw_payload, { enrichment });
      if (normalized.some((item) => item.needsEnrichment)) {
        const error = new Error('6551 interaction target remains unknown after enrichment');
        error.code = 'X6551_TARGET_UNKNOWN';
        throw error;
      }
    }

    const activities = [];
    const signals = [];
    const dynamicJobs = [];
    const followDiscoveryEvents = [];
    let matched = 0;
    for (const item of normalized) {
      const kol = await findKol(item.actorHandle, executor);
      if (!kol) continue;
      const providerEventId = `6551:${row.provider_event_id}:${item.actorHandle}`;
      const activity = await xMonitorQueries.insertActivity({
        kol_id: kol.id,
        kol_handle: kol.x_handle,
        activity_type: item.activityType,
        tweet_id: item.tweetId,
        tweet_text: item.tweetText,
        target_x_handle: item.targetHandles[0] || null,
        target_x_handles: item.targetHandles,
        extracted_cas: item.extractedCas,
        extracted_tickers: item.extractedTickers,
        provider_event_id: providerEventId,
        source_created_at: item.sourceCreatedAt,
        provider: '6551',
        semantic_key: item.semanticKey,
        observation_started_at: row.transport_received_at || row.received_at,
        observation_ended_at: new Date(),
        raw_json: item.raw,
        trace_id: row.trace_id
      }, executor);
      if (!activity) continue;
      activities.push(activity);
      dynamicJobs.push(...await enqueueForActivity(activity, row.id, executor));
      followDiscoveryEvents.push(...await enqueueFollow({
        activity, providerEventId: row.id, item, kol
      }, executor));
      if (item.activityType !== 'unfollow') {
        const matchResult = await matchActivity(activity, executor, {
          notify: false,
          returnSignals: true
        });
        matched += matchResult.count;
        signals.push(...matchResult.signals);
      }
      await executor.query('UPDATE x_activities SET processed = true WHERE id = $1', [activity.id]);
    }

    const status = activities.length > 0 ? 'processed' : 'ignored';
    await markEvent(row.id, {
      status,
      semanticKey: normalized[0]?.semanticKey,
      activityIds: activities.map((activity) => activity.id)
    }, executor);
    await executor.query(
      `UPDATE x_provider_events
       SET processing_path = $2,
           signal_committed_at = CASE WHEN $3::boolean THEN NOW() ELSE signal_committed_at END,
           receive_to_signal_ms = CASE WHEN $3::boolean THEN
             GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - COALESCE(transport_received_at, received_at))) * 1000)::int)
             ELSE receive_to_signal_ms END,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, processingPath, signals.length > 0]
    );
    if (transactionClient) await executor.query('COMMIT');

    if (signals.length > 0 && !options.executor) {
      try {
        await db.query(
          "SELECT pg_notify('xbot_live_signal', $1)",
          [JSON.stringify(signals.map((signal) => ({
            id: Number(signal.id),
            execution_mode: signal.execution_mode
          })))]
        );
      } catch (error) {
        logger.error('6551-inbox', `Post-commit live queue publish failed: ${error.message}`);
      }
    }

    if (options.notify !== false) {
      try {
        signals.forEach((signal) => notifier.signalMatched(signal));
      } catch (error) {
        logger.error('6551-inbox', `Post-commit notification failed: ${error.message}`);
      }
    }

    if (activities.length > 0 && wsBroadcast) {
      try {
        wsBroadcast({
          type: 'x:6551-event',
          payload: { providerEventId: row.provider_event_id, activities: activities.length, matched }
        });
      } catch (error) {
        logger.error('6551-inbox', `Post-commit broadcast failed: ${error.message}`);
      }
    }
    if (signals.length > 0 && options.onSignals) {
      try {
        options.onSignals(signals, {
          providerEventId: row.provider_event_id,
          transportReceivedAt: row.transport_received_at || row.received_at,
          processingPath
        });
      } catch (error) {
        logger.error('6551-inbox', `Post-commit execution enqueue failed: ${error.message}`);
      }
    }
    return { status, activities, matched, signals, dynamicJobs, followDiscoveryEvents };
  } catch (error) {
    if (transactionClient) await executor.query('ROLLBACK').catch(() => {});
    const attemptsResult = await stateExecutor.query(
      'SELECT attempt_count FROM x_provider_events WHERE id = $1',
      [row.id]
    );
    const attempts = Number(attemptsResult.rows[0]?.attempt_count || 1);
    const status = attempts >= 3 ? 'dead_letter' : 'pending';
    await markEvent(row.id, { status, error: error.message }, stateExecutor);
    throw error;
  } finally {
    transactionClient?.release();
  }
}

async function ingest6551Event(event, options = {}) {
  const inserted = await insertInboxEvent(event, options.executor || db, {
    transportReceivedAt: options.transportReceivedAt
  });
  if (inserted.duplicate) return { duplicate: true, status: 'duplicate', activities: [], matched: 0, dynamicJobs: [], followDiscoveryEvents: [] };
  if (!inserted.identity.stable) {
    return { duplicate: false, status: 'dead_letter', activities: [], matched: 0, dynamicJobs: [], followDiscoveryEvents: [] };
  }
  const result = await processInboxEvent(inserted.row, options);
  return { duplicate: false, ...result };
}

async function resumePending(options = {}) {
  const executor = options.executor || db;
  const limit = Math.min(100, Math.max(1, Number(options.limit || 50)));
  const result = await executor.query(
    `SELECT * FROM x_provider_events
     WHERE provider = '6551' AND status = 'pending'
     ORDER BY received_at ASC LIMIT $1`,
    [limit]
  );
  const summary = { processed: 0, failed: 0 };
  for (const row of result.rows) {
    try {
      await processInboxEvent(row, options);
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      logger.error('6551-inbox', `Pending event ${row.provider_event_id} failed: ${error.message}`);
    }
  }
  return summary;
}

module.exports = {
  ingest6551Event,
  insertInboxEvent,
  processInboxEvent,
  providerEventIdentity,
  redactPayload,
  resumePending
};
