const express = require('express');
const router = express.Router();
const service = require('./service');
const db = require('../../lib/db');
const engineState = require('../../lib/engine-state');
const { CHAIN_REGISTRY } = require('../../lib/chain-config');
const livePolicy = require('../signal/live-policy');

function operatorId(req) {
  return String(req.get('x-operator-id') || 'admin').slice(0, 128);
}

async function audit(req, action, key) {
  await db.query(
    `INSERT INTO system_logs(level, module, message, meta)
     VALUES ('audit', 'config-control', $1, $2)`,
    [action, { key, operator: operatorId(req) }]
  );
}

function sendError(res, error) {
  const status = String(error.code || '').startsWith('CONFIG_') ? 400 : 500;
  res.status(status).json({ ok: false, error: error.message, code: error.code || 'INTERNAL_ERROR' });
}

router.get('/chains', async (req, res) => {
  try {
    const config = await service.get('chain_configs');
    res.json({ ok: true, data: service.validateChainConfigs(config || {}) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

router.put('/chains/retry', async (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      const error = new Error('Automatic retry requires an enabled boolean');
      error.code = 'CONFIG_VALUE_INVALID';
      throw error;
    }
    const chains = await service.get('chain_configs') || {};
    const next = service.buildManagedRetryConfigs(chains, req.body.enabled);
    await engineState.setFaulted({
      preserveIntent: false,
      operator: operatorId(req),
      reason: 'CHAIN_CONFIGURATION_CHANGED'
    });
    const result = await service.set('chain_configs', next);
    await audit(req, req.body.enabled
      ? 'MANAGED_RETRY_ENABLED_AND_DISARMED'
      : 'MANAGED_RETRY_DISABLED_AND_DISARMED', 'chain_configs');
    res.json({ ok: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/chains/:chainId', async (req, res) => {
  try {
    const chainId = String(req.params.chainId || '').toLowerCase();
    if (!CHAIN_REGISTRY[chainId]) {
      const error = new Error('Unsupported chain configuration');
      error.code = 'CONFIG_VALUE_INVALID';
      throw error;
    }
    const chains = await service.get('chain_configs') || {};
    chains[chainId] = { ...chains[chainId], ...req.body };
    const result = await service.set('chain_configs', chains);
    await engineState.setFaulted({
      preserveIntent: false,
      operator: operatorId(req),
      reason: 'CHAIN_CONFIGURATION_CHANGED'
    });
    await audit(req, 'CHAIN_CONFIG_UPDATED_AND_DISARMED', chainId);
    res.json({ ok: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:key', async (req, res) => {
  try {
    service.assertConfigKey(req.params.key);
    if (req.params.key === 'live_policy') {
      const policy = await livePolicy.getPolicy();
      return res.json({ ok: true, data: {
        providers: policy.providers,
        event_types: policy.eventTypes,
        chains: policy.chains,
        whitelist_ids: policy.whitelistIds,
        max_signal_age_seconds: policy.maxSignalAgeSeconds,
        source: 'active_whitelist_relations',
        read_only: true
      } });
    }
    const config = await service.get(req.params.key);
    res.json({ ok: true, data: config });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/:key', async (req, res) => {
  try {
    if (req.params.key === 'chain_configs' || req.params.key === 'live_policy') {
      const error = new Error(req.params.key === 'live_policy'
        ? 'Live policy is derived from active whitelist relations and is read-only'
        : 'Use the dedicated chain configuration endpoint');
      error.code = 'CONFIG_KEY_NOT_ALLOWED';
      throw error;
    }
    const result = await service.set(req.params.key, req.body);
    await engineState.setFaulted({
      preserveIntent: false,
      operator: operatorId(req),
      reason: 'LIVE_CONFIGURATION_CHANGED',
      details: { key: req.params.key }
    });
    await audit(req, 'CONFIG_UPDATED_AND_DISARMED', req.params.key);
    res.json({ ok: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
