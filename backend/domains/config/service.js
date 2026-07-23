const db = require('../../lib/db');

const CONFIG_KEYS = new Set(['chain_configs', 'live_policy', 'risk_config', 'x_monitor_config']);
const LIVE_PROVIDERS = new Set(['6551']);
const LIVE_EVENT_TYPES = new Set(['tweet', 'retweet', 'quote', 'reply', 'follow']);
const LIVE_CHAINS = new Set(['sol', 'bsc', 'base', 'eth']);

function configError(message, code = 'CONFIG_VALUE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertConfigKey(key) {
  if (!CONFIG_KEYS.has(String(key))) {
    throw configError(`Configuration key is not allowed: ${key}`, 'CONFIG_KEY_NOT_ALLOWED');
  }
}

function uniqueAllowed(values, allowed, field) {
  if (!Array.isArray(values)) throw configError(`${field} must be an array`);
  const normalized = [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  if (normalized.some((value) => !allowed.has(value))) {
    throw configError(`${field} contains an unsupported value`);
  }
  return normalized;
}

function validateLivePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('live_policy must be an object');
  }
  const whitelistIds = Array.isArray(value.whitelist_ids)
    ? [...new Set(value.whitelist_ids.map(Number))]
    : [];
  if (whitelistIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw configError('live_policy.whitelist_ids must contain positive integers');
  }
  const maxSignalAgeSeconds = Number(value.max_signal_age_seconds ?? 30);
  if (!Number.isInteger(maxSignalAgeSeconds) || maxSignalAgeSeconds < 1 || maxSignalAgeSeconds > 300) {
    throw configError('live_policy.max_signal_age_seconds must be between 1 and 300');
  }
  return {
    providers: uniqueAllowed(value.providers || [], LIVE_PROVIDERS, 'live_policy.providers'),
    event_types: uniqueAllowed(value.event_types || [], LIVE_EVENT_TYPES, 'live_policy.event_types'),
    chains: uniqueAllowed(value.chains || [], LIVE_CHAINS, 'live_policy.chains'),
    whitelist_ids: whitelistIds.sort((left, right) => left - right),
    max_signal_age_seconds: maxSignalAgeSeconds
  };
}

function validateChainConfigs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('chain_configs must be an object');
  }
  const normalized = {};
  for (const [chain, config] of Object.entries(value)) {
    if (chain === 'robinhood' && config && typeof config === 'object' && !Array.isArray(config)) {
      if (config.enabled) throw configError('Legacy robinhood configuration cannot be enabled by P9.1');
      normalized[chain] = { ...config, enabled: false };
      continue;
    }
    if (!LIVE_CHAINS.has(chain) || !config || typeof config !== 'object' || Array.isArray(config)) {
      throw configError(`Unsupported chain configuration: ${chain}`);
    }
    const next = { ...config, enabled: Boolean(config.enabled) };
    for (const field of ['dailyBudget', 'weeklyBudget', 'maxPerTrade', 'maxOpenPositions', 'dailyLossLimit']) {
      const numeric = Number(config[field]);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        throw configError(`chain_configs.${chain}.${field} must be a positive number`);
      }
      next[field] = numeric;
    }
    if (!Number.isInteger(next.maxOpenPositions)) {
      throw configError(`chain_configs.${chain}.maxOpenPositions must be an integer`);
    }
    if (next.maxPerTrade > next.dailyBudget || next.dailyBudget > next.weeklyBudget) {
      throw configError(
        `chain_configs.${chain} must satisfy maxPerTrade <= dailyBudget <= weeklyBudget`
      );
    }
    normalized[chain] = next;
  }
  return normalized;
}

function validateNumericObject(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError(`${key} must be an object`);
  }
  const normalized = { ...value };
  for (const [field, raw] of Object.entries(value)) {
    if (typeof raw === 'boolean' || typeof raw === 'string') continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      throw configError(`${key}.${field} must be a finite non-negative value`);
    }
    normalized[field] = raw;
  }
  return normalized;
}

function validateRiskConfig(value) {
  const allowed = new Set([
    'security_check_enabled', 'max_buy_tax', 'max_sell_tax', 'max_rug_ratio',
    'consecutive_failure_lock', 'reject_cooldown_ms', 'min_liquidity_usd',
    'max_slippage_pct', 'consecutive_loss_limit', 'ca_cooldown_min'
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('risk_config must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw configError(`Unsupported risk_config field: ${key}`);
  }
  if (value.security_check_enabled !== undefined && typeof value.security_check_enabled !== 'boolean') {
    throw configError('risk_config.security_check_enabled must be true or false');
  }
  const defaults = {
    security_check_enabled: true,
    max_buy_tax: 5,
    max_sell_tax: 10,
    max_rug_ratio: 0.3,
    consecutive_failure_lock: 3,
    reject_cooldown_ms: 600000,
    min_liquidity_usd: 10000,
    max_slippage_pct: 15,
    consecutive_loss_limit: 5,
    ca_cooldown_min: 30
  };
  const source = { ...defaults, ...value };
  const normalized = { ...source, security_check_enabled: true };
  const ranges = {
    max_buy_tax: [0, 100],
    max_sell_tax: [0, 100],
    max_rug_ratio: [0, 1],
    consecutive_failure_lock: [1, 100],
    reject_cooldown_ms: [0, 86_400_000],
    min_liquidity_usd: [0, 1_000_000_000],
    max_slippage_pct: [0, 100],
    consecutive_loss_limit: [1, 100],
    ca_cooldown_min: [0, 10_080]
  };
  for (const [field, [minimum, maximum]] of Object.entries(ranges)) {
    const numeric = Number(source[field]);
    if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
      throw configError(`risk_config.${field} must be between ${minimum} and ${maximum}`);
    }
    normalized[field] = numeric;
  }
  return normalized;
}

function validateConfig(key, value) {
  assertConfigKey(key);
  if (key === 'live_policy') return validateLivePolicy(value);
  if (key === 'chain_configs') return validateChainConfigs(value);
  if (key === 'risk_config') return validateRiskConfig(value);
  return validateNumericObject(value, key);
}

async function get(key) {
  const res = await db.query('SELECT value_json FROM config WHERE key = $1', [key]);
  return res.rows[0] ? res.rows[0].value_json : null;
}

async function set(key, value) {
  const normalized = validateConfig(key, value);
  const res = await db.query(
    'INSERT INTO config (key, value_json) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW() RETURNING *',
    [key, JSON.stringify(normalized)]
  );
  return res.rows[0].value_json;
}

module.exports = {
  CONFIG_KEYS,
  assertConfigKey,
  get,
  set,
  validateChainConfigs,
  validateConfig,
  validateLivePolicy,
  validateRiskConfig
};
