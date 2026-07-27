const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertConfigKey,
  buildManagedRetryConfigs,
  validateChainConfigs,
  validateLivePolicy,
  validateRiskConfig
} = require('../domains/config/service');

const MANAGED_RETRY_ENV = {
  GMGN_MAX_FEE_RESERVE_SOL: '0.01',
  GMGN_MIN_GAS_RESERVE_SOL: '0.02',
  GMGN_MAX_FEE_RESERVE_BSC: '0.001',
  GMGN_MIN_GAS_RESERVE_BSC: '0.002',
  GMGN_MAX_FEE_RESERVE_BASE: '0.003',
  GMGN_MIN_GAS_RESERVE_BASE: '0.004',
  GMGN_MAX_FEE_RESERVE_ETH: '0.005',
  GMGN_MIN_GAS_RESERVE_ETH: '0.006',
  GMGN_MAX_FEE_RESERVE_ROBINHOOD: '0.007',
  GMGN_MIN_GAS_RESERVE_ROBINHOOD: '0.008'
};

test('configuration service rejects arbitrary database config keys', () => {
  assert.throws(() => assertConfigKey('engine_armed'), { code: 'CONFIG_KEY_NOT_ALLOWED' });
  assert.throws(() => assertConfigKey('x_monitor_config'), { code: 'CONFIG_KEY_NOT_ALLOWED' });
  assert.doesNotThrow(() => assertConfigKey('live_policy'));
});

test('live policy is normalized and limited to P9.1 providers and event types', () => {
  assert.deepEqual(validateLivePolicy({
    providers: ['6551', '6551'],
    event_types: ['Reply', 'follow'],
    chains: ['SOL', 'base'],
    whitelist_ids: [4, '2', 4],
    max_signal_age_seconds: 30
  }), {
    providers: ['6551'],
    event_types: ['reply', 'follow'],
    chains: ['sol', 'base'],
    whitelist_ids: [2, 4],
    max_signal_age_seconds: 30
  });
  assert.throws(() => validateLivePolicy({
    providers: ['twitterapi'], event_types: [], chains: [], whitelist_ids: []
  }), { code: 'CONFIG_VALUE_INVALID' });
});

test('chain configuration keeps execution retry settings and drops legacy business limits', () => {
  assert.throws(() => validateChainConfigs({ polygon: {} }), { code: 'CONFIG_VALUE_INVALID' });
  assert.deepEqual(validateChainConfigs({
    eth: {
      enabled: false,
      dailyBudget: 0.5,
      weeklyBudget: 2,
      maxPerTrade: 0.1,
      maxOpenPositions: 3,
      dailyLossLimit: 0.3
    }
  }).eth, {
    nativeSymbol: 'ETH',
    retryEnabled: false,
    maxRetries: 2,
    retryWindowMs: 30000,
    failureEvidenceWindowMs: 30000,
    feeEscalationEnabled: false,
    maxRetryFeeNative: 0,
    exitGasReserve: 0
  });
  assert.throws(() => validateChainConfigs({
    sol: {
      enabled: true,
      dailyBudget: 1,
      weeklyBudget: 2,
      maxPerTrade: 0.1,
      maxOpenPositions: 1,
      dailyLossLimit: 1,
      retryEnabled: true,
      maxRetries: 2,
      maxRetryFeeNative: 0
    }
  }), /retry requires retries and a fee cap/);
  assert.deepEqual(validateChainConfigs({
    robinhood: {
      retryEnabled: true,
      maxRetries: 1,
      maxRetryFeeNative: 0.001
    }
  }).robinhood, {
    nativeSymbol: 'ETH',
    retryEnabled: true,
    maxRetries: 1,
    retryWindowMs: 30000,
    failureEvidenceWindowMs: 30000,
    feeEscalationEnabled: false,
    maxRetryFeeNative: 0.001,
    exitGasReserve: 0
  });
});

test('managed retry derives all chain limits from backend-owned defaults', () => {
  const enabled = buildManagedRetryConfigs({
    sol: { maxRetryFeeNative: 0.004 }
  }, true, MANAGED_RETRY_ENV);

  assert.equal(Object.keys(enabled).length, 5);
  assert.equal(enabled.sol.retryEnabled, true);
  assert.equal(enabled.sol.maxRetries, 2);
  assert.equal(enabled.sol.maxRetryFeeNative, 0.004);
  assert.equal(enabled.sol.exitGasReserve, 0.02);
  assert.equal(enabled.sol.feeEscalationEnabled, true);
  assert.equal(enabled.robinhood.retryEnabled, true);
  assert.equal(enabled.robinhood.maxRetries, 1);
  assert.equal(enabled.robinhood.maxRetryFeeNative, 0.007);
  assert.equal(enabled.robinhood.exitGasReserve, 0.008);
  assert.equal(enabled.robinhood.feeEscalationEnabled, false);

  const disabled = buildManagedRetryConfigs(enabled, false, {});
  assert.equal(Object.values(disabled).every(config => !config.retryEnabled), true);
  assert.throws(() => buildManagedRetryConfigs({}, true, {
    ...MANAGED_RETRY_ENV,
    GMGN_MAX_FEE_RESERVE_ETH: ''
  }), { code: 'CONFIG_RETRY_LIMIT_MISSING' });
});

test('risk configuration retains only the infrastructure failure circuit threshold', () => {
  const valid = validateRiskConfig({
    security_check_enabled: false,
    max_buy_tax: 5,
    max_sell_tax: 10,
    max_rug_ratio: 0.3,
    consecutive_failure_lock: 3,
    reject_cooldown_ms: 600000,
    min_liquidity_usd: 10000,
    max_slippage_pct: 15,
    consecutive_loss_limit: 5,
    ca_cooldown_min: 30
  });
  assert.deepEqual(valid, { consecutive_failure_lock: 3 });
  assert.throws(() => validateRiskConfig({ ...valid, typo_limit: 1 }), /Unsupported risk_config field/);
  assert.throws(() => validateRiskConfig({ consecutive_failure_lock: 0 }), /consecutive_failure_lock/);
});
