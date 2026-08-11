const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.resolve(__dirname, '../../.env');
const MASK = '********';
const SECRET_KEYS = new Set([
  'DB_PASSWORD', 'GMGN_API_KEY', 'GMGN_PRIVATE_KEY',
  'GMGN_TEST_API_KEY', 'GMGN_TEST_PRIVATE_KEY', 'OPENNEWS_TOKEN',
  'XAI_API_KEY', 'ADMIN_TOKEN'
]);
const CRITICAL_KEYS = new Set([
  'TRADING_MODE', 'LIVE_TRADING_ENABLED', 'GMGN_PRIVATE_KEY', 'GMGN_TEST_PRIVATE_KEY', 'XBOT_PROCESS_ROLE'
]);
const IMPACT_PRIORITY = [
  'research_only', 'observability', 'cache_runtime', 'chain_scoped',
  'monitoring_critical', 'global_execution', 'global_control', 'process_infrastructure'
];
const ALLOWED_KEYS = [
  'BACKEND_PORT', 'BACKEND_HOST', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'TRADING_MODE', 'GMGN_CREDENTIAL_PROFILE', 'GMGN_API_KEY', 'GMGN_PRIVATE_KEY',
  'GMGN_TEST_API_KEY', 'GMGN_TEST_PRIVATE_KEY', 'GMGN_KEY_EXCLUSIVE',
  'GMGN_CACHE_WARMER_ENABLED', 'P20_CANDIDATE_WARMUP_ENABLED',
  'P22_GMGN_SHARED_LIMIT_ENABLED', 'P22_GMGN_RATE_SCOPE',
  'GMGN_FAST_CACHE_TTL_MS', 'GMGN_WALLET_CACHE_TTL_MS', 'GMGN_TOKEN_CACHE_TTL_MS',
  'GMGN_MAX_FEE_RESERVE_SOL', 'GMGN_MAX_FEE_RESERVE_BSC', 'GMGN_MAX_FEE_RESERVE_BASE',
  'GMGN_MAX_FEE_RESERVE_ETH', 'GMGN_MAX_FEE_RESERVE_ROBINHOOD',
  'GMGN_MIN_GAS_RESERVE_SOL', 'GMGN_MIN_GAS_RESERVE_BSC',
  'GMGN_MIN_GAS_RESERVE_BASE', 'GMGN_MIN_GAS_RESERVE_ETH',
  'GMGN_MIN_GAS_RESERVE_ROBINHOOD',
  'SOLANA_RPC_URL', 'BSC_RPC_URL', 'BASE_RPC_URL', 'ETH_RPC_URL', 'ROBINHOOD_RPC_URL',
  'TRADE_ALERTS_VERIFIED',
  'EMERGENCY_STOP',
  'OPENNEWS_TOKEN', 'XAI_API_KEY', 'XAI_BASE_URL', 'XAI_MODEL',
  'P21_FOLLOW_DISCOVERY_ENABLED',
  'SIGNAL_MAX_AGE_SECONDS',
  'LIVE_TRADING_ENABLED', 'ADMIN_TOKEN', 'XBOT_PROCESS_ROLE'
];

const BOOLEAN_KEYS = new Set([
  'GMGN_KEY_EXCLUSIVE', 'TRADE_ALERTS_VERIFIED',
  'GMGN_CACHE_WARMER_ENABLED', 'P20_CANDIDATE_WARMUP_ENABLED',
  'P22_GMGN_SHARED_LIMIT_ENABLED',
  'EMERGENCY_STOP', 'LIVE_TRADING_ENABLED',
  'P21_FOLLOW_DISCOVERY_ENABLED'
]);

const NON_NEGATIVE_NUMBER_KEYS = new Set([
  'GMGN_MAX_FEE_RESERVE_SOL', 'GMGN_MAX_FEE_RESERVE_BSC', 'GMGN_MAX_FEE_RESERVE_BASE',
  'GMGN_MAX_FEE_RESERVE_ETH', 'GMGN_MAX_FEE_RESERVE_ROBINHOOD',
  'GMGN_MIN_GAS_RESERVE_SOL', 'GMGN_MIN_GAS_RESERVE_BSC',
  'GMGN_MIN_GAS_RESERVE_BASE', 'GMGN_MIN_GAS_RESERVE_ETH',
  'GMGN_MIN_GAS_RESERVE_ROBINHOOD'
]);

const POSITIVE_INTEGER_KEYS = new Set([
  'GMGN_FAST_CACHE_TTL_MS', 'GMGN_WALLET_CACHE_TTL_MS', 'GMGN_TOKEN_CACHE_TTL_MS',
  'SIGNAL_MAX_AGE_SECONDS'
]);

function impactScopeForKey(key) {
  if (['XAI_API_KEY', 'XAI_BASE_URL', 'XAI_MODEL'].includes(key)) return 'research_only';
  if (key === 'TRADE_ALERTS_VERIFIED') return 'observability';
  if (['GMGN_CACHE_WARMER_ENABLED', 'P20_CANDIDATE_WARMUP_ENABLED',
    'P22_GMGN_SHARED_LIMIT_ENABLED', 'P22_GMGN_RATE_SCOPE',
    'GMGN_FAST_CACHE_TTL_MS', 'GMGN_WALLET_CACHE_TTL_MS', 'GMGN_TOKEN_CACHE_TTL_MS'].includes(key)) {
    return 'cache_runtime';
  }
  if (['OPENNEWS_TOKEN', 'P21_FOLLOW_DISCOVERY_ENABLED'].includes(key)) {
    return 'monitoring_critical';
  }
  if (key.endsWith('_RPC_URL') || key.startsWith('GMGN_MAX_FEE_RESERVE_')
      || key.startsWith('GMGN_MIN_GAS_RESERVE_')) return 'chain_scoped';
  if (['GMGN_CREDENTIAL_PROFILE', 'GMGN_API_KEY', 'GMGN_PRIVATE_KEY',
    'GMGN_TEST_API_KEY', 'GMGN_TEST_PRIVATE_KEY', 'GMGN_KEY_EXCLUSIVE',
    'SIGNAL_MAX_AGE_SECONDS'].includes(key)) {
    return 'global_execution';
  }
  if (['TRADING_MODE', 'LIVE_TRADING_ENABLED', 'EMERGENCY_STOP', 'XBOT_PROCESS_ROLE'].includes(key)) {
    return 'global_control';
  }
  if (['BACKEND_PORT', 'BACKEND_HOST', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER',
    'DB_PASSWORD', 'ADMIN_TOKEN'].includes(key)) return 'process_infrastructure';
  return 'observability';
}

function impactForKeys(keys = []) {
  const changedKeys = [...new Set(keys)].filter((key) => ALLOWED_KEYS.includes(key)).sort();
  const scopes = [...new Set(changedKeys.map(impactScopeForKey))];
  const impactScope = scopes.sort(
    (left, right) => IMPACT_PRIORITY.indexOf(right) - IMPACT_PRIORITY.indexOf(left)
  )[0] || 'observability';
  const restartRoles = new Set();
  if (scopes.includes('monitoring_critical')) restartRoles.add('ingestion');
  if (scopes.some((scope) => ['global_execution', 'global_control'].includes(scope))) {
    restartRoles.add('execution');
  }
  if (scopes.includes('process_infrastructure')) {
    restartRoles.add('ingestion');
    restartRoles.add('execution');
  }
  return {
    impact_scope: impactScope,
    impact_scopes: scopes,
    changed_keys: changedKeys,
    restart_required: restartRoles.size > 0,
    restart_roles: [...restartRoles],
    manual_rearm_required: scopes.some((scope) => (
      scope === 'global_execution' || scope === 'global_control' || scope === 'process_infrastructure'
    ))
  };
}

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
  if (!['GMGN_PRIVATE_KEY', 'GMGN_TEST_PRIVATE_KEY'].includes(key) && /[\r\n]/.test(normalized)) {
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
  if (key === 'TRADING_MODE' && !['signal', 'live'].includes(normalized)) {
    const error = new Error('TRADING_MODE must be signal or live in the production settings API');
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (key === 'XBOT_PROCESS_ROLE' && !['all', 'ingestion', 'execution'].includes(normalized)) {
    const error = new Error('XBOT_PROCESS_ROLE must be all, ingestion, or execution');
    error.code = 'ENV_VALUE_INVALID';
    throw error;
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
  if (key === 'XAI_BASE_URL' && normalized) {
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      const error = new Error('XAI_BASE_URL must be a valid HTTPS URL');
      error.code = 'ENV_VALUE_INVALID';
      throw error;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      const error = new Error('XAI_BASE_URL must use HTTPS without credentials, query, or fragment');
      error.code = 'ENV_VALUE_INVALID';
      throw error;
    }
    normalized = normalized.replace(/\/+$/, '');
  }
  if (key === 'XAI_MODEL' && normalized && !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    const error = new Error('XAI_MODEL contains unsupported characters');
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (key === 'GMGN_API_KEY' && normalized && normalized !== MASK && !normalized.startsWith('gmgn')) {
    const error = new Error('GMGN_API_KEY has an invalid format');
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (key === 'GMGN_TEST_API_KEY' && normalized && normalized !== MASK && !normalized.startsWith('gmgn')) {
    const error = new Error('GMGN_TEST_API_KEY has an invalid format');
    error.code = 'ENV_VALUE_INVALID';
    throw error;
  }
  if (key === 'GMGN_CREDENTIAL_PROFILE' && !['primary', 'test'].includes(normalized.toLowerCase())) {
    const error = new Error('GMGN_CREDENTIAL_PROFILE must be primary or test');
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
    if (key === 'SIGNAL_MAX_AGE_SECONDS' && numeric > 300) {
      const error = new Error('SIGNAL_MAX_AGE_SECONDS cannot exceed 300');
      error.code = 'ENV_VALUE_INVALID';
      throw error;
    }
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

function mergeEnvContent(existing, updates) {
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const nextValues = new Map(Object.entries(updates || {}));
  const seen = new Set();
  const lines = existing.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/);
    if (!match || !nextValues.has(match[2])) return line;
    const value = nextValues.get(match[2]);
    seen.add(match[2]);
    return `${match[1]}${match[2]}${match[3]}=${value ?? ''}`;
  });
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of nextValues) {
    if (!seen.has(key)) lines.push(`${key}=${value ?? ''}`);
  }
  return `${lines.join(newline)}${newline}`;
}

function writeEnv(updates) {
  const existing = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, 'utf8')
    : '# xbot environment (managed by Settings API)\n';
  const content = mergeEnvContent(existing, updates);
  const temporaryPath = `${ENV_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(temporaryPath, ENV_PATH);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function publicConfig() {
  const values = readEnv();
  const result = {};
  for (const key of ALLOWED_KEYS) {
    if (['GMGN_PRIVATE_KEY', 'GMGN_TEST_PRIVATE_KEY'].includes(key)) continue;
    result[key] = SECRET_KEYS.has(key) ? (values[key] ? MASK : '') : (values[key] || '');
  }
  result.GMGN_PRIVATE_KEY_CONFIGURED = Boolean(values.GMGN_PRIVATE_KEY);
  result.GMGN_TEST_PRIVATE_KEY_CONFIGURED = Boolean(values.GMGN_TEST_PRIVATE_KEY);
  return result;
}

function updateGeneralWithImpact(input) {
  const values = readEnv();
  const updates = {};
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
    updates[key] = next;
  }
  const changedKeys = Object.keys(updates).filter((key) => (readEnv()[key] || '') !== updates[key]);
  writeEnv(updates);
  const impact = impactForKeys(changedKeys);
  for (const key of changedKeys) {
    if (!impact.restart_roles.includes('execution')) process.env[key] = updates[key];
  }
  return { config: publicConfig(), impact };
}

function updateGeneral(input) {
  return updateGeneralWithImpact(input).config;
}

function updateCritical(key, value) {
  writeEnv({ [key]: validateValue(key, value) });
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
  IMPACT_PRIORITY,
  impactForKeys,
  impactScopeForKey,
  MASK,
  mergeEnvContent,
  publicConfig,
  readEnv,
  replaceGmgnPrivateKey,
  updateCritical,
  updateGeneral,
  updateGeneralWithImpact,
  validateValue,
  writeEnv
};
