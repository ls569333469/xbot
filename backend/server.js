require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('./lib/logger');
const { getProcessRole, roleCapabilities } = require('./lib/process-role');
const { consumer: x6551Consumer } = require('./domains/x-monitor/6551/wss-consumer');
const { reconciler } = require('./domains/trade/reconciliation-service');
const {
  getSnapshot: getReadinessSnapshot,
  monitor: readinessMonitor
} = require('./domains/trade/readiness-service');
const { outboxWorker } = require('./jobs/notification-outbox');
const { cacheWarmer } = require('./jobs/gmgn-cache-warmup');
const { liveExecutionQueue } = require('./domains/trade/live-execution-queue');
const { shadowLiveEvaluator } = require('./jobs/shadow-live-evaluator');
const providerRateRecorder = require('./lib/provider-rate-recorder');
const { serviceHeartbeat } = require('./lib/service-heartbeat');
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
  verifyClient: ({ req }, done) => {
    const expected = String(process.env.ADMIN_TOKEN || '');
    const actual = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    const authorized = expectedBuffer.length > 0
      && expectedBuffer.length === actualBuffer.length
      && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
    done(authorized, authorized ? undefined : 401, authorized ? undefined : 'Unauthorized');
  }
});

app.use(helmet());
app.use(cors());
app.use(express.json());

// Auth middleware
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (req.path === '/api/x-monitor/webhook/twitterapi') return next();
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
app.use('/api/x-monitor', require('./domains/x-monitor/routes'));
app.use('/api/config', require('./domains/config/routes'));
app.use('/api/system', require('./domains/system/routes'));
app.use('/api/kol', require('./domains/kol/routes'));
app.use('/api/trade', require('./domains/trade/routes'));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'ok', process_role: processRole });
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

// Load and register cron jobs after startup safety checks.
const jobsRunning = {};
function safeRun(jobId, handler) {
  return async () => {
    if (jobsRunning[jobId]) return;
    jobsRunning[jobId] = true;
    try {
      await handler({ wsBroadcast });
    } catch (err) {
      logger.error('cron', `Job ${jobId} failed`, { error: err.message });
    } finally {
      jobsRunning[jobId] = false;
    }
  };
}

function registerCronJobs() {
  if (String(process.env.CRON_ENABLED || 'true').toLowerCase() === 'false') {
    logger.warn('cron', 'Cron registration disabled by CRON_ENABLED=false');
    return;
  }
  try {
    const cronConfigPath = path.join(__dirname, 'cron.json');
    if (fs.existsSync(cronConfigPath)) {
      const jobs = JSON.parse(fs.readFileSync(cronConfigPath, 'utf8'));
      jobs.forEach(job => {
        if (job.enabled) {
          const handler = require(job.handler).run;
          cron.schedule(job.schedule, safeRun(job.id, handler));
          logger.info('cron', `Registered job: ${job.name} (${job.schedule})`);
        }
      });
    }
  } catch (err) {
    logger.error('server', 'Failed to load cron jobs', { error: err.message });
  }
}

const db = require('./lib/db');

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server', `Received ${signal}. Starting graceful shutdown...`);
  if (capabilities.ingestion) {
    await x6551Consumer.stop().catch((error) => {
      logger.error('server', `Failed to stop 6551 consumer: ${error.message}`);
    });
  }
  if (capabilities.execution) {
    reconciler.stop();
    readinessMonitor.stop();
    outboxWorker.stop();
    cacheWarmer.stop();
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
  const checkEnv = require('./scripts/check-env');
  await checkEnv();

  const { runMigrations } = require('./lib/migrations');
  await runMigrations();

  if (capabilities.execution) {
    const engineState = require('./lib/engine-state');
    await engineState.init();

    // Recovery completes once before the new-order gate can become ready.
    await reconciler.runOnce();
    reconciler.start({ wsBroadcast, intervalMs: 1000 });
    providerRateRecorder.start({ wsBroadcast });
    outboxWorker.start({ wsBroadcast, intervalMs: 2000 });
    cacheWarmer.start({ intervalMs: 2000 });
    liveExecutionQueue.configure({ wsBroadcast });
    await liveExecutionQueue.start({ intervalMs: 500 });
    if (String(process.env.SHADOW_LIVE_ENABLED || 'false').toLowerCase() === 'true'
        && String(process.env.TRADING_MODE || '').toLowerCase() !== 'live') {
      shadowLiveEvaluator.start({ intervalMs: 500 });
    }
    readinessMonitor.start();
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
  }

  serviceHeartbeat.start({
    role: processRole,
    statusProvider: async () => ({
      status: 'running',
      processRole,
      ...(capabilities.ingestion ? { wss: x6551Consumer.getStatus() } : {}),
      ...(capabilities.execution ? {
        engine: {
          armed: require('./lib/engine-state').getArmed(),
          liveQueue: liveExecutionQueue.getStatus(),
          reconciler: await reconciler.getStatus()
        }
      } : {})
    })
  });

  if (capabilities.execution) {
    registerCronJobs();
    const recovery = await require('./lib/engine-state').restoreDesiredState(
      () => getReadinessSnapshot({ probe: true }),
      {
        maxAttempts: 16,
        retryDelayMs: 1000,
        retryableBlockers: ['X_6551_INGESTION_UNHEALTHY']
      }
    );
    logger.info('engine-state', `Startup recovery result: ${recovery.status}`);
  }
  logger.info('server', `Process role ready: ${processRole}`);
}

startServer().catch(err => {
  void x6551Consumer.stop().catch(() => {});
  reconciler.stop();
  readinessMonitor.stop();
  outboxWorker.stop();
  cacheWarmer.stop();
  providerRateRecorder.stop();
  shadowLiveEvaluator.stop();
  void serviceHeartbeat.stop();
  logger.error('server', `Failed to start server: ${err.message}`);
  process.exit(1);
});
