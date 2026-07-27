const db = require('../../lib/db');
const { CHAIN_REGISTRY, getExecutionChains } = require('../../lib/chain-config');

const CONFIG_KEYS = new Set(['chain_configs', 'live_policy', 'risk_config']);
const LIVE_PROVIDERS = new Set(['6551']);
const LIVE_EVENT_TYPES = new Set(['tweet', 'retweet', 'quote', 'reply', 'follow']);
const LIVE_CHAINS = new Set(getExecutionChains().map((chain) => chain.id));
const CONFIGURABLE_CHAINS = new Set(Object.keys(CHAIN_REGISTRY));

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
  const operationalFields = new Set([
    'retryEnabled', 'maxRetries', 'retryWindowMs',
    'failureEvidenceWindowMs', 'feeEscalationEnabled', 'maxRetryFeeNative',
    'exitGasReserve'
  ]);
  const legacyFields = new Set([
    'enabled', 'nativeSymbol', 'dailyBudget', 'weeklyBudget', 'maxPerTrade',
    'maxOpenPositions', 'dailyLossLimit', 'defaultTpPct', 'defaultSlPct',
    'defaultSlippage'
  ]);
  for (const [chain, config] of Object.entries(value)) {
    if (!CONFIGURABLE_CHAINS.has(chain) || !config || typeof config !== 'object' || Array.isArray(config)) {
      throw configError(`Unsupported chain configuration: ${chain}`);
    }
    const unknownFields = Object.keys(config)
      .filter((field) => !operationalFields.has(field) && !legacyFields.has(field));
    if (unknownFields.length > 0) {
      throw configError(`chain_configs.${chain} contains unsupported fields: ${unknownFields.join(', ')}`);
    }
    const next = { retryEnabled: Boolean(config.retryEnabled) };
    const defaults = CHAIN_REGISTRY[chain].retryDefault;
    const maxRetries = Number(config.maxRetries ?? defaults.maxRetries);
    const retryWindowMs = Number(config.retryWindowMs ?? defaults.retryWindowMs);
    const failureEvidenceWindowMs = Number(
      config.failureEvidenceWindowMs ?? defaults.failureEvidenceWindowMs
    );
    const maxRetryFeeNative = Number(config.maxRetryFeeNative ?? 0);
    const exitGasReserve = Number(config.exitGasReserve ?? 0);
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
      throw configError(`chain_configs.${chain}.maxRetries must be an integer between 0 and 2`);
    }
    if (!Number.isInteger(retryWindowMs) || retryWindowMs < 1000 || retryWindowMs > 300000) {
      throw configError(`chain_configs.${chain}.retryWindowMs must be between 1000 and 300000`);
    }
    if (!Number.isInteger(failureEvidenceWindowMs)
        || failureEvidenceWindowMs < 5000 || failureEvidenceWindowMs > 600000) {
      throw configError(`chain_configs.${chain}.failureEvidenceWindowMs must be between 5000 and 600000`);
    }
    if (![maxRetryFeeNative, exitGasReserve].every((number) => Number.isFinite(number) && number >= 0)) {
      throw configError(`chain_configs.${chain} retry fee and exit reserve must be non-negative`);
    }
    if (next.retryEnabled && (maxRetries === 0 || maxRetryFeeNative <= 0)) {
      throw configError(`chain_configs.${chain} retry requires retries and a fee cap`);
    }
    if (!CHAIN_REGISTRY[chain].executionImplemented && next.retryEnabled) {
      throw configError(`chain_configs.${chain}.retryEnabled is not available before live validation`);
    }
    next.maxRetries = maxRetries;
    next.retryWindowMs = retryWindowMs;
    next.failureEvidenceWindowMs = failureEvidenceWindowMs;
    next.feeEscalationEnabled = Boolean(config.feeEscalationEnabled);
    if (next.feeEscalationEnabled && !next.retryEnabled) {
      throw configError(`chain_configs.${chain}.feeEscalationEnabled requires retryEnabled`);
    }
    next.maxRetryFeeNative = maxRetryFeeNative;
    next.exitGasReserve = exitGasReserve;
    next.nativeSymbol = CHAIN_REGISTRY[chain].nativeSymbol;
    normalized[chain] = next;
  }
  return normalized;
}

function positiveManagedLimit(env, key) {
  const value = Number(env[key]);
  if (!Number.isFinite(value) || value <= 0) {
    throw configError(`${key} must be configured before enabling automatic retry`, 'CONFIG_RETRY_LIMIT_MISSING');
  }
  return value;
}

function buildManagedRetryConfigs(value, enabled, env = process.env) {
  const current = validateChainConfigs(value || {});
  const next = { ...current };

  for (const chain of getExecutionChains()) {
    const existing = current[chain.id] || {};
    const defaults = chain.retryDefault;
    if (!enabled) {
      next[chain.id] = {
        ...existing,
        retryEnabled: false,
        feeEscalationEnabled: false
      };
      continue;
    }

    const suffix = chain.id.toUpperCase();
    const configuredFeeCap = positiveManagedLimit(env, `GMGN_MAX_FEE_RESERVE_${suffix}`);
    const configuredGasReserve = positiveManagedLimit(env, `GMGN_MIN_GAS_RESERVE_${suffix}`);
    const existingFeeCap = Number(existing.maxRetryFeeNative);
    const existingGasReserve = Number(existing.exitGasReserve);
    const existingRetries = Number(existing.maxRetries);

    next[chain.id] = {
      ...existing,
      retryEnabled: true,
      maxRetries: Number.isInteger(existingRetries) && existingRetries > 0
        ? Math.min(existingRetries, 2)
        : Math.max(1, Math.min(Number(defaults.maxRetries) || 1, 2)),
      retryWindowMs: Number(existing.retryWindowMs) || defaults.retryWindowMs,
      failureEvidenceWindowMs: Number(existing.failureEvidenceWindowMs)
        || defaults.failureEvidenceWindowMs,
      feeEscalationEnabled: chain.feeCapabilities.length > 0,
      maxRetryFeeNative: Number.isFinite(existingFeeCap) && existingFeeCap > 0
        ? Math.min(existingFeeCap, configuredFeeCap)
        : configuredFeeCap,
      exitGasReserve: Number.isFinite(existingGasReserve) && existingGasReserve > 0
        ? Math.max(existingGasReserve, configuredGasReserve)
        : configuredGasReserve
    };
  }

  return validateChainConfigs(next);
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
  const consecutiveFailureLock = Number(value.consecutive_failure_lock ?? 3);
  if (!Number.isInteger(consecutiveFailureLock)
      || consecutiveFailureLock < 1 || consecutiveFailureLock > 100) {
    throw configError('risk_config.consecutive_failure_lock must be an integer between 1 and 100');
  }
  return { consecutive_failure_lock: consecutiveFailureLock };
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
  buildManagedRetryConfigs,
  validateChainConfigs,
  validateConfig,
  validateLivePolicy,
  validateRiskConfig
};
