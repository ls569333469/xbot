const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.resolve(__dirname, '../../.env');
const MASK = '********';
const SECRET_KEYS = new Set([
  'DB_PASSWORD', 'GMGN_API_KEY', 'GMGN_PRIVATE_KEY', 'SOCIALDATA_API_KEY',
  'OPENNEWS_TOKEN', 'TWITTERAPI_IO_API_KEY', 'TWITTERAPI_IO_WEBHOOK_SECRET',
  'ADMIN_TOKEN'
]);
const CRITICAL_KEYS = new Set([
  'TRADING_MODE', 'LIVE_TRADING_ENABLED', 'GMGN_PRIVATE_KEY', 'XBOT_PROCESS_ROLE'
]);
const ALLOWED_KEYS = [
  'BACKEND_PORT', 'BACKEND_HOST', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'TRADING_MODE', 'GMGN_API_KEY', 'GMGN_PRIVATE_KEY', 'GMGN_KEY_EXCLUSIVE',
  'GMGN_FAST_CACHE_TTL_MS', 'GMGN_WALLET_CACHE_TTL_MS', 'GMGN_TOKEN_CACHE_TTL_MS',
  'GMGN_MAX_FEE_RESERVE_SOL', 'GMGN_MAX_FEE_RESERVE_BSC', 'GMGN_MAX_FEE_RESERVE_BASE',
  'GMGN_MAX_FEE_RESERVE_ETH', 'GMGN_MIN_GAS_RESERVE_SOL', 'GMGN_MIN_GAS_RESERVE_BSC',
  'GMGN_MIN_GAS_RESERVE_BASE', 'GMGN_MIN_GAS_RESERVE_ETH', 'GMGN_GLOBAL_DAILY_USD_LIMIT',
  'GMGN_GLOBAL_WEEKLY_USD_LIMIT',
  'SOLANA_RPC_URL', 'BSC_RPC_URL', 'BASE_RPC_URL', 'ETH_RPC_URL',
  'TRADE_ALERTS_VERIFIED', 'SHADOW_LIVE_ENABLED',
  'EMERGENCY_STOP',
  'X_DATA_PROVIDER', 'SOCIALDATA_API_KEY', 'OPENNEWS_TOKEN', 'TWITTERAPI_IO_API_KEY',
  'TWITTERAPI_IO_FOLLOW_INTERVAL_MS', 'TWITTERAPI_IO_MIN_INTERVAL_MS',
  'TWITTERAPI_IO_DAILY_CREDIT_LIMIT', 'TWITTERAPI_IO_CREDIT_WARNING_PCT', 'TWITTERAPI_IO_MAX_PAGES',
  'TWITTERAPI_IO_FOLLOW_INCREMENTAL_MAX_PAGES', 'TWITTERAPI_IO_TIMEOUT_MS',
  'TWITTER_STREAM_ENABLED', 'TWITTERAPI_IO_WEBHOOK_SECRET', 'TWITTER_WEBHOOK_MAX_AGE_MS',
  'SIGNAL_MAX_AGE_SECONDS', 'P8_VERIFIED_LIVE_EVENT_TYPES', 'X_6551_TIMEOUT_MS', 'X_6551_WSS_ENABLED',
  'X_6551_WATCH_APPLY_ENABLED', 'X_6551_WATCH_UNFOLLOW_ENABLED', 'X_6551_HEARTBEAT_MS',
  'X_6551_RECONNECT_MAX_MS', 'X_6551_MONTHLY_MESSAGE_LIMIT', 'CRON_ENABLED',
  'LIVE_TRADING_ENABLED', 'ADMIN_TOKEN', 'XBOT_PROCESS_ROLE'
];

const BOOLEAN_KEYS = new Set([
  'GMGN_KEY_EXCLUSIVE', 'TRADE_ALERTS_VERIFIED',
  'SHADOW_LIVE_ENABLED', 'EMERGENCY_STOP',
  'TWITTER_STREAM_ENABLED', 'X_6551_WSS_ENABLED', 'X_6551_WATCH_APPLY_ENABLED',
  'X_6551_WATCH_UNFOLLOW_ENABLED', 'CRON_ENABLED', 'LIVE_TRADING_ENABLED'
]);

const NON_NEGATIVE_NUMBER_KEYS = new Set([
  'GMGN_MAX_FEE_RESERVE_SOL', 'GMGN_MAX_FEE_RESERVE_BSC', 'GMGN_MAX_FEE_RESERVE_BASE',
  'GMGN_MAX_FEE_RESERVE_ETH', 'GMGN_MIN_GAS_RESERVE_SOL', 'GMGN_MIN_GAS_RESERVE_BSC',
  'GMGN_MIN_GAS_RESERVE_BASE', 'GMGN_MIN_GAS_RESERVE_ETH', 'GMGN_GLOBAL_DAILY_USD_LIMIT',
  'GMGN_GLOBAL_WEEKLY_USD_LIMIT'
]);

const POSITIVE_INTEGER_KEYS = new Set([
  'GMGN_FAST_CACHE_TTL_MS', 'GMGN_WALLET_CACHE_TTL_MS', 'GMGN_TOKEN_CACHE_TTL_MS',
  'TWITTERAPI_IO_FOLLOW_INTERVAL_MS', 'TWITTERAPI_IO_MIN_INTERVAL_MS',
  'TWITTERAPI_IO_DAILY_CREDIT_LIMIT', 'TWITTERAPI_IO_MAX_PAGES',
  'TWITTERAPI_IO_FOLLOW_INCREMENTAL_MAX_PAGES', 'TWITTERAPI_IO_TIMEOUT_MS',
  'TWITTER_WEBHOOK_MAX_AGE_MS', 'SIGNAL_MAX_AGE_SECONDS', 'X_6551_TIMEOUT_MS',
  'X_6551_HEARTBEAT_MS', 'X_6551_RECONNECT_MAX_MS', 'X_6551_MONTHLY_MESSAGE_LIMIT'
]);

function readEnv() {
  const values = {};
  if (!fs.existsSync(ENV_PATH)) return values;
  fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index <= 0) return;
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  });
  return values;
}

function validateValue(key, value) {
  if (!ALLOWED_KEYS.includes(key)) {
    const error = new Error(`Environment key is not allowed: ${key}`);
    error.code = 'ENV_KEY_NOT_ALLOWED';
    throw error;
  }
  let normalized = String(value ?? '').trim();
  if (key !== 'GMGN_PRIVATE_KEY' && /[\r\n]/.test(normalized)) {
    const error = new Error(`${key} cannot contain newlines`);
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (BOOLEAN_KEYS.has(key) && normalized === '') normalized = 'false';
  if (BOOLEAN_KEYS.has(key) && !['true', 'false'].includes(normalized.toLowerCase())) {
    const error = new Error(`${key} must be true or false`);
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (key === 'TRADING_MODE' && !['signal', 'paper', 'live'].includes(normalized)) {
    const error = new Error('TRADING_MODE must be signal, paper, or live');
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (key === 'XBOT_PROCESS_ROLE' && !['all', 'ingestion', 'execution'].includes(normalized)) {
    const error = new Error('XBOT_PROCESS_ROLE must be all, ingestion, or execution');
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (key === 'X_DATA_PROVIDER' && !['mock', 'socialdata', 'twitterapi', '6551'].includes(normalized)) {
    const error = new Error('X_DATA_PROVIDER is invalid');
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (key === 'P8_VERIFIED_LIVE_EVENT_TYPES') {
    const allowed = new Set(['tweet', 'retweet', 'quote', 'reply', 'follow']);
    const values = [...new Set(normalized.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
    if (values.some((item) => !allowed.has(item))) {
      const error = new Error('P8_VERIFIED_LIVE_EVENT_TYPES contains an unsupported event type');
      error.code = 'ENV_VALUE_INVALID';
      throw error;
    }
    normalized = values.join(',');
  }
  if (['BACKEND_PORT', 'DB_PORT'].includes(key) && normalized) {
    const port = Number(normalized);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      const error = new Error(`${key} must be an integer between 1 and 65535`);
      error.code = 'ENV_VALUE_INVALID';
      throw error;
    }
  }
  if (key === 'BACKEND_HOST' && !['127.0.0.1', 'localhost'].includes(normalized)) {
    const error = new Error('BACKEND_HOST is restricted to localhost until remote HTTPS access controls are implemented');
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (key === 'GMGN_API_KEY' && normalized && normalized !== MASK && !normalized.startsWith('gmgn')) {
    const error = new Error('GMGN_API_KEY has an invalid format');
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (NON_NEGATIVE_NUMBER_KEYS.has(key) && normalized) {
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric) || numeric < 0) {
      const error = new Error(`${key} must be a non-negative number`);
      error.code = 'ENV_VALUE_INVALID';
      throw error;
    }
  }
  if (POSITIVE_INTEGER_KEYS.has(key) && normalized) {
    const numeric = Number(normalized);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      const error = new Error(`${key} must be a positive integer`);
      error.code = 'ENV_VALUE_INVALID';
      throw error;
    }
    const minimums = {
      TWITTERAPI_IO_FOLLOW_INTERVAL_MS: 30000,
      X_6551_HEARTBEAT_MS: 5000,
      X_6551_RECONNECT_MAX_MS: 1000,
      X_6551_TIMEOUT_MS: 1000,
      TWITTERAPI_IO_TIMEOUT_MS: 1000
    };
    if (minimums[key] && numeric < minimums[key]) {
      const error = new Error(`${key} must be at least ${minimums[key]}`);
      error.code = 'ENV_VALUE_INVALID';
      throw error;
    }
    if (key === 'SIGNAL_MAX_AGE_SECONDS' && numeric > 300) {
      const error = new Error('SIGNAL_MAX_AGE_SECONDS cannot exceed 300');
      error.code = 'ENV_VALUE_INVALID';
      throw error;
    }
  }
  if (key === 'TWITTERAPI_IO_CREDIT_WARNING_PCT' && normalized
      && (!Number.isFinite(Number(normalized)) || Number(normalized) < 1 || Number(normalized) > 100)) {
    const error = new Error('TWITTERAPI_IO_CREDIT_WARNING_PCT must be between 1 and 100');
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (key.endsWith('_RPC_URL') && normalized) {
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      const error = new Error(`${key} must be a valid HTTP(S) URL`);
      error.code = 'ENV_VALUE_INVALID';
      throw error;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      const error = new Error(`${key} must use HTTP or HTTPS`);
      error.code = 'ENV_VALUE_INVALID';
      throw error;
    }
  }
  return normalized;
}

function writeEnv(values) {
  const lines = ['# xbot environment (managed by Settings API)', ''];
  for (const key of ALLOWED_KEYS) lines.push(`${key}=${values[key] || ''}`);
  fs.writeFileSync(ENV_PATH, `${lines.join('\n')}\n`, 'utf8');
}

function publicConfig() {
  const values = readEnv();
  const result = {};
  for (const key of ALLOWED_KEYS) {
    if (key === 'GMGN_PRIVATE_KEY') continue;
    result[key] = SECRET_KEYS.has(key) ? (values[key] ? MASK : '') : (values[key] || '');
  }
  result.GMGN_PRIVATE_KEY_CONFIGURED = Boolean(values.GMGN_PRIVATE_KEY);
  return result;
}

function updateGeneral(input) {
  const values = readEnv();
  for (const [key, raw] of Object.entries(input || {})) {
    if (key === 'GMGN_PRIVATE_KEY_CONFIGURED') continue;
    if (CRITICAL_KEYS.has(key)) {
      const current = values[key] || '';
      if (String(raw ?? '') !== current && String(raw ?? '') !== MASK) {
        const error = new Error(`${key} must be changed through its dedicated action`);
        error.code = 'DEDICATED_ENV_ACTION_REQUIRED';
        throw error;
      }
      continue;
    }
    const next = validateValue(key, raw);
    if (SECRET_KEYS.has(key) && next === MASK) continue;
    values[key] = next;
  }
  writeEnv(values);
  return publicConfig();
}

function updateCritical(key, value) {
  const values = readEnv();
  values[key] = validateValue(key, value);
  writeEnv(values);
}

function replaceGmgnPrivateKey(privateKey) {
  const normalized = String(privateKey || '').replace(/\\n/g, '\n').trim();
  if (!normalized) {
    const error = new Error('GMGN private key is required');
    error.code = 'GMGN_PRIVATE_KEY_MISSING';
    throw error;
  }
  crypto.createPrivateKey(normalized);
  updateCritical('GMGN_PRIVATE_KEY', normalized.replace(/\r?\n/g, '\\n'));
}

module.exports = {
  ALLOWED_KEYS,
  CRITICAL_KEYS,
  ENV_PATH,
  MASK,
  publicConfig,
  readEnv,
  replaceGmgnPrivateKey,
  updateCritical,
  updateGeneral,
  validateValue
};
