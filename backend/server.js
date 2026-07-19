require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const logger = require('./lib/logger');

// Global boundary error logging
process.on('uncaughtException', (err) => {
  logger.error('server', 'Uncaught Exception', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('server', 'Unhandled Rejection', { reason: reason ? reason.message || reason : 'unknown' });
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(helmet());
app.use(cors());
app.use(express.json());

// Auth middleware
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
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
  res.json({ ok: true, status: 'ok' });
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

// Load and register cron jobs
let jobsRunning = {};
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

setTimeout(() => {
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
}, 5000); // 5s cooldown for local test/dev

const db = require('./lib/db');

function gracefulShutdown(signal) {
  logger.info('server', `Received ${signal}. Starting graceful shutdown...`);
  server.close(() => {
    logger.info('server', 'Express server closed.');
    db.pool.end(() => {
      logger.info('server', 'Database pool ended. Exiting process.');
      process.exit(0);
    });
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function startServer() {
  const checkEnv = require('./scripts/check-env');
  await checkEnv();

  await Promise.all([
    db.query("ALTER TABLE positions ADD COLUMN IF NOT EXISTS sim_peaks JSONB DEFAULT '{}'"),
    db.query("ALTER TABLE positions ADD COLUMN IF NOT EXISTS sell_tx_hash TEXT")
  ]);
  logger.info('server', 'Database positions schema verified (sim_peaks and sell_tx_hash verified)');

  const port = process.env.BACKEND_PORT || 3011;
  server.listen(port, () => {
    logger.info('server', `xbot backend listening on port ${port}`);
  });
}

startServer().catch(err => {
  logger.error('server', `Failed to start server: ${err.message}`);
  process.exit(1);
});
