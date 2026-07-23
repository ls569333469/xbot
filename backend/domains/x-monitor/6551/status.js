const db = require('../../../lib/db');
const providerUsage = require('../../../lib/provider-usage');
const engineState = require('../../../lib/engine-state');
const { getTradingMode } = require('../../../lib/runtime-mode');
const { consumer } = require('./wss-consumer');
const { HEARTBEAT_STALE_MS, latestHeartbeat } = require('../../../lib/service-heartbeat');

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

async function get6551Status(executor = db, consumerInstance = consumer) {
  const [watchRows, eventRows, eventTotals, restUsage, ingestionHeartbeat] = await Promise.all([
    executor.query(
      `SELECT sync_status AS status, COUNT(*) AS count,
              COUNT(*) FILTER (WHERE managed = true) AS managed_count
       FROM x_provider_watches WHERE provider = '6551'
       GROUP BY sync_status`
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
    latestHeartbeat(['ingestion', 'all'], executor).catch(() => null)
  ]);

  const watches = countsByStatus(watchRows.rows);
  const inbox = countsByStatus(eventRows.rows);
  const totals = eventTotals.rows[0] || {};
  const observedMonth = Number(totals.month || 0);
  const messageLimit = Math.max(1, Number(process.env.X_6551_MONTHLY_MESSAGE_LIMIT || 2000000));
  const messageUsagePct = Number(((observedMonth / messageLimit) * 100).toFixed(2));

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
      total: Object.values(watches).reduce((total, count) => total + count, 0),
      managed: watchRows.rows.reduce(
        (total, row) => total + Number(row.managed_count || 0),
        0
      )
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

module.exports = { countsByStatus, get6551Status, monthlyProjection, usageLevel };
