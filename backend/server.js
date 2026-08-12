require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const WebSocket = require('ws');
const logger = require('./lib/logger');
const {
  authorizeWebSocketRequest,
  selectWebSocketProtocol
} = require('./lib/websocket-auth');
const { getProcessRole, roleCapabilities } = require('./lib/process-role');
const { legacyShadowEnabled, legacyXProvidersEnabled } = require('./lib/legacy-features');
const { consumer: x6551Consumer } = require('./domains/x-monitor/6551/wss-consumer');
const { watchSyncWorker } = require('./jobs/6551-watch-sync');
const { reconciler } = require('./domains/trade/reconciliation-service');
const { tradeRetryOrchestrator } = require('./domains/trade/trade-retry-orchestrator');
const {
  getSnapshot: getReadinessSnapshot,
  monitor: readinessMonitor,
  TRANSIENT_BLOCKERS
} = require('./domains/trade/readiness-service');
const { outboxWorker } = require('./jobs/notification-outbox');
const { whitelistActivationWorker } = require('./jobs/whitelist-activation');
const { liveExecutionQueue } = require('./domains/trade/live-execution-queue');
const { shadowLiveEvaluator } = require('./jobs/shadow-live-evaluator');
const providerRateRecorder = require('./lib/provider-rate-recorder');
const { serviceHeartbeat } = require('./lib/service-heartbeat');
const { researchQueue } = require('./domains/research/queue');
const { kolProfileEnrichmentWorker } = require('./jobs/kol-profile-enrichment');
const { dynamicSignalWorker } = require('./domains/dynamic-signal/event-worker');
const { dynamicPaperSessionWorker } = require('./domains/dynamic-signal/paper-worker');
const { actorScreeningWorker } = require('./domains/actor-screening/worker');
const { followDiscoveryWorker } = require('./domains/follow-discovery/event-worker');
const { releaseInfo } = require('./lib/release-info');
const processRole = getProcessRole();
const capabilities = roleCapabilities(processRole);

// Global boundary error logging
process.on('uncaughtException', (err) => {
  logger.error('server', 'Uncaught Exception', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('server', 'Unhandled Rejection', { reason: reason ? reason.message || reason : 'unknown' });
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  path: '/ws',
  handleProtocols: selectWebSocketProtocol,
  verifyClient: ({ req }, done) => {
    const authorized = authorizeWebSocketRequest(req, process.env.ADMIN_TOKEN);
    done(authorized, authorized ? undefined : 401, authorized ? undefined : 'Unauthorized');
  }
});

app.use(helmet());
app.use(cors());
app.use(express.json());

// Auth middleware
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (req.path === '/api/x-monitor/webhook/twitterapi'
      && legacyXProvidersEnabled()
      && String(process.env.X_DATA_PROVIDER || '').toLowerCase() === 'twitterapi') return next();
  if (req.path.startsWith('/api/')) {
    const token = req.headers.authorization;
    const expected = `Bearer ${process.env.ADMIN_TOKEN}`;
    if (!token || token !== expected) {
      return res.status(401).json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
  }
  next();
});

// Domain routers
app.use('/api/whitelist', require('./domains/whitelist/routes'));
app.use('/api/launch-monitors', require('./domains/launch-monitor/routes'));
app.use('/api/research', require('./domains/research/routes'));
app.use('/api/x-monitor', require('./domains/x-monitor/routes'));
app.use('/api/config', require('./domains/config/routes'));
app.use('/api/system', require('./domains/system/routes'));
app.use('/api/kol', require('./domains/kol/routes'));
app.use('/api/trade', require('./domains/trade/routes'));
app.use('/api/dynamic-signal', require('./domains/dynamic-signal/routes'));
app.use('/api/actor-screening', require('./domains/actor-screening/routes'));
app.use('/api/follow-discovery', require('./domains/follow-discovery/routes'));

app.get('/api/health', async (req, res) => {
  res.json({ ok: true, status: 'ok', ...(await releaseInfo(processRole)) });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('server', 'Unhandled error', { err: err.message });
  res.status(500).json({ ok: false, error: 'Internal Server Error', code: 'INTERNAL_ERROR' });
});

// WebSocket broadcast
function wsBroadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}
app.set('wsBroadcast', wsBroadcast);

const db = require('./lib/db');

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server', `Received ${signal}. Starting graceful shutdown...`);
  if (capabilities.ingestion) {
    watchSyncWorker.stop();
    await x6551Consumer.stop().catch((error) => {
      logger.error('server', `Failed to stop 6551 consumer: ${error.message}`);
    });
  }
  if (capabilities.execution) {
    kolProfileEnrichmentWorker.stop();
    dynamicSignalWorker.stop();
    dynamicPaperSessionWorker.stop();
    actorScreeningWorker.stop();
    followDiscoveryWorker.stop();
    researchQueue.stop();
    reconciler.stop();
    tradeRetryOrchestrator.stop();
    readinessMonitor.stop();
    outboxWorker.stop();
    whitelistActivationWorker.stop();
    await liveExecutionQueue.stop();
    shadowLiveEvaluator.stop();
    providerRateRecorder.stop();
  }
  if (server.listening) {
    await new Promise((resolve) => server.close(resolve));
    logger.info('server', 'Express server closed.');
  }
  await serviceHeartbeat.stop();
  await db.pool.end();
  logger.info('server', 'Database pool ended. Exiting process.');
  process.exit(0);
}
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

async function startServer() {
  require('./lib/p20-features').validateP20Runtime();
  const checkEnv = require('./scripts/check-env');
  await checkEnv();

  const shouldRunMigrations = processRole === 'all'
    || String(process.env.XBOT_RUN_MIGRATIONS || 'false').toLowerCase() === 'true';
  if (shouldRunMigrations) {
    const { runMigrations } = require('./lib/migrations');
    await runMigrations();
  } else {
    logger.info('migrations', `Migration phase owned by supervisor; skipped in ${processRole} role`);
  }

  if (capabilities.execution) {
    const engineState = require('./lib/engine-state');
    await engineState.init();

    // Recovery completes once before the new-order gate can become ready.
    await reconciler.runOnce();
    reconciler.start({ wsBroadcast, intervalMs: 1000 });
    await tradeRetryOrchestrator.runOnce();
    tradeRetryOrchestrator.start({ intervalMs: 100 });
    providerRateRecorder.start({ wsBroadcast });
    outboxWorker.start({ wsBroadcast, intervalMs: 2000 });
    whitelistActivationWorker.start({ intervalMs: 1000 });
    liveExecutionQueue.configure({ wsBroadcast });
    await liveExecutionQueue.start({ intervalMs: 500 });
    if (legacyShadowEnabled()
        && String(process.env.SHADOW_LIVE_ENABLED || 'false').toLowerCase() === 'true'
        && String(process.env.TRADING_MODE || '').toLowerCase() !== 'live') {
      shadowLiveEvaluator.start({ intervalMs: 500 });
    }
    readinessMonitor.start();
    kolProfileEnrichmentWorker.start({ intervalMs: 5000 });
    dynamicSignalWorker.start({ wsBroadcast, intervalMs: 500 });
    dynamicPaperSessionWorker.start({ intervalMs: 60_000 });
    actorScreeningWorker.start({ intervalMs: 2000 });
    followDiscoveryWorker.start({ intervalMs: 1000 });
  }

  if (capabilities.api) {
    const port = process.env.BACKEND_PORT || 3011;
    const host = process.env.BACKEND_HOST || '127.0.0.1';
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        logger.info('server', `xbot backend listening on ${host}:${port} (${processRole})`);
        resolve();
      });
    });
  }

  if (capabilities.ingestion) {
    try {
      const result = await x6551Consumer.start({
        wsBroadcast: capabilities.api ? wsBroadcast : undefined,
        onSignals: capabilities.execution
          ? (signals, context) => liveExecutionQueue.enqueue(signals, context)
          : undefined
      });
      logger.info('6551-wss', `Consumer startup: ${result.reason || (result.started ? 'started' : 'not_started')}`);
    } catch (error) {
      logger.error('6551-wss', `Consumer startup failed: ${error.message}`);
    }
    watchSyncWorker.start({ intervalMs: 1000 });
  }

  serviceHeartbeat.start({
    role: processRole,
    statusProvider: async () => ({
      status: 'running',
      processRole,
      ...(capabilities.ingestion ? {
        wss: x6551Consumer.getStatus(),
        watchSync: watchSyncWorker.getStatus()
      } : {}),
      ...(capabilities.execution ? {
        engine: {
          armed: require('./lib/engine-state').getArmed(),
          liveQueue: liveExecutionQueue.getStatus(),
          reconciler: await reconciler.getStatus(),
          retryOrchestrator: await tradeRetryOrchestrator.getStatus(),
          whitelistActivation: whitelistActivationWorker.getStatus()
        },
        kolProfileEnrichment: kolProfileEnrichmentWorker.getStatus(),
        followDiscovery: followDiscoveryWorker.getStatus()
      } : {})
    })
  });

  if (capabilities.execution) {
    const engineState = require('./lib/engine-state');
    const recovery = await engineState.restoreDesiredState(
      (options = {}) => getReadinessSnapshot({
        // Startup recovery must not fan out into GMGN diagnostics. Explicit
        // arm preparation remains the place for an operator-requested probe.
        probe: false,
        scope: options.scope || engineState.getScopeInput()
      }),
      {
        maxAttempts: 16,
        retryDelayMs: 1000,
        retryableBlockers: [...TRANSIENT_BLOCKERS],
        pauseOnRetryableExhaustion: true
      }
    );
    logger.info('engine-state', `Startup recovery result: ${recovery.status}`);
    researchQueue.start({ intervalMs: 1000 });
  }
  logger.info('server', `Process role ready: ${processRole}`);
}

startServer().catch(err => {
  void x6551Consumer.stop().catch(() => {});
  watchSyncWorker.stop();
  reconciler.stop();
  tradeRetryOrchestrator.stop();
  readinessMonitor.stop();
  outboxWorker.stop();
  whitelistActivationWorker.stop();
  kolProfileEnrichmentWorker.stop();
  followDiscoveryWorker.stop();
  providerRateRecorder.stop();
  shadowLiveEvaluator.stop();
  void serviceHeartbeat.stop();
  logger.error('server', `Failed to start server: ${err.message}`);
  process.exit(1);
});
