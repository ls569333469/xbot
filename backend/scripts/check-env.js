const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { getProcessRole } = require('../lib/process-role');
const {
  legacyPaperEnabled,
  legacyShadowEnabled,
  legacyXProvidersEnabled
} = require('../lib/legacy-features');
const { getGmgnCredentials } = require('../lib/gmgn-credentials');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

async function checkDb() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'pm_user',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'xbot'
  });

  try {
    await client.connect();
    console.log('[check-env] Database connection successful.');
  } finally {
    await client.end();
  }
}

function checkVars() {
  const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'ADMIN_TOKEN', 'TRADING_MODE'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required .env variables: ${missing.join(', ')}`);
  }

  const modes = new Set(['signal', 'paper', 'live']);
  if (!modes.has(process.env.TRADING_MODE)) {
    throw new Error('TRADING_MODE must be signal, paper, or live.');
  }
  if (process.env.TRADING_MODE === 'paper' && !legacyPaperEnabled()) {
    throw new Error('TRADING_MODE=paper requires XBOT_LEGACY_PAPER_ENABLED=true.');
  }

  const processRole = getProcessRole();
  if (process.env.NODE_ENV === 'production' && processRole === 'all') {
    throw new Error('Production requires separate --role=ingestion and --role=execution processes.');
  }

  const credentials = getGmgnCredentials();
  const apiKey = credentials.apiKey;
  const privateKey = credentials.privateKey;

  if (apiKey && !apiKey.startsWith('gmgn')) {
    throw new Error('GMGN_API_KEY has an invalid format.');
  }

  if (privateKey) {
    try {
      crypto.createPrivateKey(privateKey);
    } catch (err) {
      throw new Error(`GMGN_PRIVATE_KEY must be a valid PEM signing key: ${err.message}`);
    }
  }


  if (process.env.X_DATA_PROVIDER === 'socialdata' && !process.env.SOCIALDATA_API_KEY) {
    throw new Error('SOCIALDATA_API_KEY is required when X_DATA_PROVIDER=socialdata.');
  }

  const providers = new Set(['mock', 'socialdata', 'twitterapi', '6551']);
  const provider = process.env.X_DATA_PROVIDER || 'mock';
  if (!providers.has(provider)) {
    throw new Error('X_DATA_PROVIDER must be mock, socialdata, twitterapi, or 6551.');
  }
  if (provider !== '6551' && !legacyXProvidersEnabled()) {
    throw new Error('Production X_DATA_PROVIDER must be 6551; legacy providers require XBOT_LEGACY_X_PROVIDERS_ENABLED=true.');
  }
  if (provider === 'twitterapi' && !process.env.TWITTERAPI_IO_API_KEY) {
    throw new Error('TWITTERAPI_IO_API_KEY is required when X_DATA_PROVIDER=twitterapi.');
  }
  if (provider === '6551' && !process.env.OPENNEWS_TOKEN) {
    throw new Error('OPENNEWS_TOKEN is required when X_DATA_PROVIDER=6551.');
  }
  if (provider !== 'twitterapi'
      && String(process.env.TWITTER_STREAM_ENABLED || 'false').toLowerCase() === 'true') {
    throw new Error('TWITTER_STREAM_ENABLED is only supported when X_DATA_PROVIDER=twitterapi.');
  }

  if (String(process.env.SHADOW_LIVE_ENABLED || 'false').toLowerCase() === 'true'
      && !legacyShadowEnabled()) {
    throw new Error('SHADOW_LIVE_ENABLED=true requires XBOT_LEGACY_SHADOW_ENABLED=true.');
  }

  for (const [key, fallback, minimum] of [
    ['X_6551_HEARTBEAT_MS', 20000, 5000],
    ['X_6551_RECONNECT_MAX_MS', 1000, 1000],
    ['X_6551_MONTHLY_MESSAGE_LIMIT', 2000000, 1]
  ]) {
    const value = Number(process.env[key] || fallback);
    if (!Number.isFinite(value) || value < minimum) {
      throw new Error(`${key} must be at least ${minimum}.`);
    }
  }

  const followIntervalMs = Number(process.env.TWITTERAPI_IO_FOLLOW_INTERVAL_MS || 60000);
  if (!Number.isFinite(followIntervalMs) || followIntervalMs < 30000) {
    throw new Error('TWITTERAPI_IO_FOLLOW_INTERVAL_MS must be at least 30000.');
  }

  const dailyCreditLimit = Number(process.env.TWITTERAPI_IO_DAILY_CREDIT_LIMIT || 50000);
  if (!Number.isFinite(dailyCreditLimit) || dailyCreditLimit <= 0) {
    throw new Error('TWITTERAPI_IO_DAILY_CREDIT_LIMIT must be a positive number.');
  }

  if (String(process.env.TWITTER_STREAM_ENABLED || 'false').toLowerCase() === 'true'
      && !process.env.TWITTERAPI_IO_WEBHOOK_SECRET) {
    throw new Error('TWITTERAPI_IO_WEBHOOK_SECRET is required when TWITTER_STREAM_ENABLED=true.');
  }

}

async function run() {
  console.log('=== [check-env] Starting startup checks ===');
  checkVars();
  await checkDb();
  console.log('=== [check-env] All startup checks passed ===\n');
}

if (require.main === module) {
  run().catch((err) => {
    console.error('\n=== [check-env] Startup checks failed ===');
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = run;
module.exports.checkVars = checkVars;
