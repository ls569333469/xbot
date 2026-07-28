const db = require('../../../lib/db');
const providerUsage = require('../../../lib/provider-usage');
const engineState = require('../../../lib/engine-state');
const { getTradingMode } = require('../../../lib/runtime-mode');
const { X6551Client } = require('../../../lib/x-client-6551');
const { consumer } = require('./wss-consumer');
const { HEARTBEAT_STALE_MS, latestHeartbeat } = require('../../../lib/service-heartbeat');

const REMOTE_WATCH_CACHE_MS = 60000;
let remoteWatchCache = {
  token: null,
  expiresAt: 0,
  value: null,
  inFlight: null
};

async function getRemoteWatchSummary(options = {}) {
  const provider = String(process.env.X_DATA_PROVIDER || 'mock').toLowerCase();
  const token = process.env.OPENNEWS_TOKEN || '';
  if (provider !== '6551' || !token) {
    return { count: null, error: 'X6551_PROVIDER_INACTIVE' };
  }

  const now = Date.now();
  if (!options.force && remoteWatchCache.token === token
      && remoteWatchCache.value && remoteWatchCache.expiresAt > now) {
    return remoteWatchCache.value;
  }
  if (!options.force && remoteWatchCache.token === token && remoteWatchCache.inFlight) {
    return remoteWatchCache.inFlight;
  }

  const request = new X6551Client(token).listWatches()
    .then((rows) => ({ count: rows.length, error: null }))
    .catch((error) => ({ count: null, error: error.code || 'X6551_WATCH_STATUS_UNAVAILABLE' }))
    .then((value) => {
      remoteWatchCache = {
        token,
        expiresAt: Date.now() + REMOTE_WATCH_CACHE_MS,
        value,
        inFlight: null
      };
      return value;
    });
  remoteWatchCache = { token, expiresAt: 0, value: remoteWatchCache.value, inFlight: request };
  return request;
}

function countsByStatus(rows) {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

function monthlyProjection(observed) {
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsed = Math.max(1, now.getTime() - monthStart);
  const duration = nextMonth - monthStart;
  return Math.ceil(Number(observed || 0) * (duration / elapsed));
}

function usageLevel(usagePct) {
  if (usagePct >= 95) return 'critical';
  if (usagePct >= 85) return 'restricted';
  if (usagePct >= 70) return 'warning';
  return 'normal';
}

async function get6551Status(executor = db, consumerInstance = consumer, options = {}) {
  const remoteWatchPromise = getRemoteWatchSummary({ force: options.refreshRemote === true });

  const [watchRows, watchSyncRows, eventRows, eventTotals, restUsage, ingestionHeartbeat, remoteWatches] = await Promise.all([
    executor.query(
      `SELECT sync_status AS status, COUNT(*) AS count,
              COUNT(*) FILTER (WHERE managed = true) AS managed_count
       FROM x_provider_watches WHERE provider = '6551'
       GROUP BY sync_status`
    ),
    executor.query(
      `SELECT status, COUNT(*) AS count, MIN(requested_at) AS oldest_requested_at
       FROM x_watch_sync_outbox
       GROUP BY status`
    ),
    executor.query(
      `SELECT status, COUNT(*) AS count
       FROM x_provider_events WHERE provider = '6551'
       GROUP BY status`
    ),
    executor.query(
      `SELECT
         COUNT(*) FILTER (WHERE received_at >= date_trunc('day', NOW())) AS today,
         COUNT(*) FILTER (WHERE received_at >= date_trunc('month', NOW())) AS month,
         COUNT(*) FILTER (
           WHERE event_type IS NULL OR upper(event_type) NOT IN (
             'NEW_TWEET','NEW_TWEET_REPLY','NEW_TWEET_QUOTE','NEW_RETWEET','CA',
             'NEW_FOLLOWER','NEW_UNFOLLOWER'
           )
         ) AS unknown,
         MAX(received_at) AS last_received_at
       FROM x_provider_events WHERE provider = '6551'`
    ),
    providerUsage.getDailyUsage('6551'),
    latestHeartbeat(['ingestion', 'all'], executor).catch(() => null),
    remoteWatchPromise
  ]);

  const watches = countsByStatus(watchRows.rows);
  const watchSyncCounts = countsByStatus(watchSyncRows.rows);
  const inbox = countsByStatus(eventRows.rows);
  const totals = eventTotals.rows[0] || {};
  const observedMonth = Number(totals.month || 0);
  const messageLimit = Math.max(1, Number(process.env.X_6551_MONTHLY_MESSAGE_LIMIT || 2000000));
  const messageUsagePct = Number(((observedMonth / messageLimit) * 100).toFixed(2));
  const registryTotal = Object.values(watches).reduce((total, count) => total + count, 0);

  const localWss = consumerInstance.getStatus();
  const sharedWss = ingestionHeartbeat?.status?.wss || null;
  const wss = sharedWss ? {
    ...sharedWss,
    status: ingestionHeartbeat.fresh ? sharedWss.status : 'stale',
    source: 'service_heartbeat',
    serviceRole: ingestionHeartbeat.role,
    heartbeatAt: ingestionHeartbeat.heartbeatAt,
    heartbeatAgeMs: ingestionHeartbeat.ageMs,
    heartbeatFresh: ingestionHeartbeat.fresh,
    heartbeatStaleAfterMs: HEARTBEAT_STALE_MS
  } : {
    ...localWss,
    source: 'local_process',
    heartbeatAt: null,
    heartbeatAgeMs: null,
    heartbeatFresh: false,
    heartbeatStaleAfterMs: HEARTBEAT_STALE_MS
  };

  return {
    provider: String(process.env.X_DATA_PROVIDER || 'mock').toLowerCase(),
    configured: Boolean(process.env.OPENNEWS_TOKEN),
    wss,
    watches: {
      byStatus: watches,
      // `total` is the current remote count. The local registry also retains
      // historical rows for ownership and audit, so it must not be shown as
      // the number of active provider Watches.
      total: remoteWatches.count ?? registryTotal,
      remoteTotal: remoteWatches.count,
      remoteAvailable: remoteWatches.count !== null,
      remoteError: remoteWatches.error,
      registryTotal,
      managed: watchRows.rows.reduce(
        (total, row) => total + Number(row.managed_count || 0),
        0
      )
    },
    watchSync: {
      byStatus: watchSyncCounts,
      pending: Number(watchSyncCounts.pending || 0) + Number(watchSyncCounts.processing || 0)
        + Number(watchSyncCounts.failed || 0),
      failed: Number(watchSyncCounts.failed || 0),
      oldestRequestedAt: watchSyncRows.rows
        .filter((row) => ['pending', 'processing', 'failed'].includes(row.status))
        .map((row) => row.oldest_requested_at)
        .filter(Boolean)
        .sort()[0] || null,
      runtime: ingestionHeartbeat?.status?.watchSync || null
    },
    inbox: {
      byStatus: inbox,
      total: Object.values(inbox).reduce((total, count) => total + count, 0),
      today: Number(totals.today || 0),
      month: observedMonth,
      unknown: Number(totals.unknown || 0),
      lastReceivedAt: totals.last_received_at || null
    },
    usage: {
      rest: restUsage,
      messages: {
        observedMonth,
        monthlyLimit: messageLimit,
        usagePct: messageUsagePct,
        projectedMonth: monthlyProjection(observedMonth),
        level: usageLevel(messageUsagePct),
        source: 'local_observed_events'
      }
    },
    safety: {
      tradingMode: getTradingMode(),
      engineArmed: engineState.getArmed(),
      watchApplyEnabled: String(process.env.X_6551_WATCH_APPLY_ENABLED || 'false').toLowerCase() === 'true'
    }
  };
}

module.exports = {
  countsByStatus,
  get6551Status,
  getRemoteWatchSummary,
  monthlyProjection,
  usageLevel
};
