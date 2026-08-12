const express = require('express');
const router = express.Router();
const db = require('../../lib/db');
const signalQueries = require('../signal/queries');
const engineState = require('../../lib/engine-state');
const { getTradingMode } = require('../../lib/runtime-mode');
const readinessService = require('../trade/readiness-service');
const livePolicy = require('../signal/live-policy');
const { CHAIN_REGISTRY } = require('../../lib/chain-config');
const armPreparation = require('./arm-preparation-service');
const { getRuntimeSummary } = require('../trade/runtime-policy-summary');
const { enqueueWhitelistActivation } = require('../whitelist/activation-outbox');
const { cache: gmgnCache } = require('../../lib/gmgn-cache');
const runtimeScopeService = require('../trade/runtime-scope-service');
const signalPublicQueries = require('../signal/public-queries');

function operatorId(req) {
  return String(req.get('x-operator-id') || 'admin').slice(0, 128);
}

async function auditControl(req, action, details = {}) {
  await db.query(
    `INSERT INTO system_logs(level, module, message, meta)
     VALUES ('audit', 'system-control', $1, $2)`,
    [action, { ...details, operator: operatorId(req) }]
  );
}

router.get('/dashboard', async (req, res) => {
  try {
    const kols = await db.query('SELECT COUNT(*) FROM x_kol_accounts');
    const wl = await db.query('SELECT COUNT(*) FROM ca_whitelist');
    const signalsToday = await db.query("SELECT COUNT(*) FROM trade_signals WHERE created_at >= NOW() - INTERVAL '1 day'");
    const tradesToday = await db.query("SELECT COUNT(*) FROM positions WHERE opened_at >= NOW() - INTERVAL '1 day'");
    const activePositions = await db.query("SELECT COUNT(*) FROM positions WHERE status = 'open'");
    const pnlRes = await db.query(
      `SELECT chain_id, COALESCE(SUM(pnl), 0) AS pnl
       FROM positions
       WHERE status IN ('closed','partially_closed','manual_close','tp_hit','sl_hit')
       GROUP BY chain_id
       ORDER BY chain_id`
    );
    
    res.json({ 
      ok: true, 
      data: { 
        kols: parseInt(kols.rows[0].count, 10), 
        whitelists: parseInt(wl.rows[0].count, 10),
        signalsToday: parseInt(signalsToday.rows[0].count, 10),
        tradesToday: parseInt(tradesToday.rows[0].count, 10),
        activePositions: parseInt(activePositions.rows[0].count, 10),
        pnlByChain: pnlRes.rows.map((row) => ({
          chain: row.chain_id,
          nativeSymbol: CHAIN_REGISTRY[row.chain_id]?.nativeSymbol || row.chain_id.toUpperCase(),
          pnlNative: Number(row.pnl || 0)
        }))
      } 
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/runtime-summary', async (req, res) => {
  try {
    res.json({ ok: true, data: await getRuntimeSummary() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: err.code || 'RUNTIME_SUMMARY_FAILED' });
  }
});

router.get('/runtime-scopes', async (req, res) => {
  try {
    res.json({ ok: true, data: await runtimeScopeService.listActiveScopes() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: err.code || 'RUNTIME_SCOPES_FAILED' });
  }
});

router.post('/arm/prepare', async (req, res) => {
  try {
    if (String(process.env.LIVE_TRADING_ENABLED || 'false').toLowerCase() !== 'true') {
      return res.status(409).json({ ok: false, error: 'Live trading is disabled by configuration', code: 'LIVE_DISABLED' });
    }
    const data = await armPreparation.prepare(operatorId(req), {
      scope: req.body?.scope || req.body || {},
      probe: req.body?.probe === true
    });
    await auditControl(req, 'LIVE_ENGINE_ARM_PREPARED', {
      preparation_id: data.preparation_id,
      counts: data.summary.counts
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message, code: err.code || 'ARM_PREPARE_FAILED', details: err.details || undefined });
  }
});

router.get('/arm/preparations/:id', async (req, res) => {
  try {
    const data = await armPreparation.getPreparation(req.params.id, operatorId(req));
    if (!data) {
      return res.status(404).json({ ok: false, error: 'Arm preparation not found', code: 'ARM_PREPARATION_NOT_FOUND' });
    }
    res.json({ ok: true, data });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'ARM_PREPARATION_READ_FAILED' });
  }
});

router.post('/arm/confirm', async (req, res) => {
  try {
    if (req.body?.confirmation !== 'ARM LIVE TRADING') {
      return res.status(400).json({ ok: false, error: 'Explicit live confirmation is required', code: 'CONFIRMATION_REQUIRED' });
    }
    const runtime = await armPreparation.confirm(req.body, operatorId(req));
    await auditControl(req, 'LIVE_ENGINE_ARMED', {
      preparation_id: Number(req.body.preparation_id)
    });
    res.json({ ok: true, data: { ...runtime, mode: getTradingMode() } });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message, code: err.code || 'ARM_CONFIRM_FAILED', details: err.details || undefined });
  }
});

router.post('/arm', (req, res) => {
  res.status(410).json({
    ok: false,
    error: 'The legacy arm endpoint has been replaced by prepare and confirm',
    code: 'LEGACY_ARM_ENDPOINT_REMOVED'
  });
});

router.post('/disarm', async (req, res) => {
  const runtime = await engineState.stop({ operator: operatorId(req), reason: 'OPERATOR_STOPPED' });
  await auditControl(req, 'LIVE_ENGINE_DISARMED');
  res.json({ ok: true, data: runtime });
});

router.get('/engine-status', (req, res) => {
  res.json({ ok: true, data: { ...engineState.getStatus(), mode: getTradingMode() } });
});

router.get('/readiness', async (req, res) => {
  try {
    const probe = String(req.query.probe || 'false').toLowerCase() === 'true';
    const scope = req.query.scope_type ? {
      scope_type: req.query.scope_type,
      scope_id: req.query.scope_id || null,
      chain_ids: String(req.query.chain_ids || '').split(',').filter(Boolean)
    } : engineState.getScopeInput();
    res.json({ ok: true, data: await readinessService.getSnapshot({ probe, scope }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: err.code || 'READINESS_FAILED' });
  }
});

router.get('/budgets', async (req, res) => {
  try {
    const budgets = await db.query(
      `WITH ledger AS (
         SELECT chain,
                COALESCE(SUM(amount_native), 0) AS principal_committed,
                COALESCE(SUM(fee_native), 0) AS fees_committed
         FROM budget_ledger
         WHERE entry_type IN ('commit','fee_commit','deficit')
           AND created_at >= date_trunc('day', NOW())
         GROUP BY chain
       ), reservations AS (
         SELECT chain,
                COALESCE(SUM(amount_native), 0) AS principal_reserved,
                COALESCE(SUM(fee_native), 0) AS fees_reserved
         FROM budget_reservations
         WHERE status = 'reserved'
         GROUP BY chain
       ), chains AS (
         SELECT chain FROM ledger UNION SELECT chain FROM reservations
       )
       SELECT chains.chain AS chain_id,
              COALESCE(ledger.principal_committed, 0) AS principal_committed,
              COALESCE(ledger.fees_committed, 0) AS fees_committed,
              COALESCE(reservations.principal_reserved, 0) AS principal_reserved,
              COALESCE(reservations.fees_reserved, 0) AS fees_reserved
       FROM chains
       LEFT JOIN ledger ON ledger.chain = chains.chain
       LEFT JOIN reservations ON reservations.chain = chains.chain
       ORDER BY chains.chain`
    );
    res.json({ ok: true, data: budgets.rows.map((row) => ({
      ...row,
      native_symbol: CHAIN_REGISTRY[row.chain_id]?.nativeSymbol || row.chain_id.toUpperCase()
    })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/alerts/test', async (req, res) => {
  try {
    const result = await db.query(
      `INSERT INTO notification_outbox(topic, aggregate_type, aggregate_id, payload)
       VALUES ('trade.alert_test', 'system', 'readiness', $1) RETURNING id, created_at`,
      [{ operator: req.get('x-operator-id') || 'admin', requested_at: new Date() }]
    );
    res.status(202).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'ALERT_TEST_FAILED' });
  }
});

// ── Signals ──
router.get('/signals', async (req, res) => {
  try {
    const result = await signalPublicQueries.listSignals(req.query);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/signals/stats', async (req, res) => {
  try {
    const stats = await signalQueries.getStats();
    res.json({ ok: true, data: stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Environment Variables Edit & Restart APIs ──
const envSettings = require('./env-settings');

function configurationResponse(res, data, impact) {
  res.json({
    ok: true,
    data,
    meta: impact,
    message: impact?.restart_required
      ? `Configuration saved. Restarting ${impact.restart_roles.join(', ')} process.`
      : 'Configuration saved and applied.'
  });
}

function chainsForChangedKeys(keys = []) {
  const result = new Set();
  for (const key of keys) {
    for (const chain of Object.keys(CHAIN_REGISTRY)) {
      const prefix = chain === 'sol' ? 'SOLANA' : chain.toUpperCase();
      if (key === `${prefix}_RPC_URL`
          || key === `GMGN_MAX_FEE_RESERVE_${chain.toUpperCase()}`
          || key === `GMGN_MIN_GAS_RESERVE_${chain.toUpperCase()}`) result.add(chain);
    }
  }
  return [...result];
}

async function reactivateChains(chains) {
  if (chains.length === 0) return;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id FROM ca_whitelist WHERE status = 'active' AND chain_id = ANY($1::text[])`,
      [chains]
    );
    for (const row of result.rows) await enqueueWhitelistActivation(row.id, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

router.get('/env', (req, res) => {
  try {
    res.json({ ok: true, data: envSettings.publicConfig() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: err.code || 'ENV_READ_FAILED' });
  }
});

router.post('/env', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ ok: false, error: 'Invalid configuration object.' });
    }
    const result = envSettings.updateGeneralWithImpact(req.body);
    const { impact } = result;
    if (impact.impact_scopes.includes('cache_runtime')) gmgnCache.invalidate();
    if (impact.impact_scopes.includes('chain_scoped')) {
      await reactivateChains(chainsForChangedKeys(impact.changed_keys));
    }
    if (impact.impact_scopes.includes('monitoring_critical')) {
      await engineState.pauseTransient({
        operator: operatorId(req),
        reason: 'MONITORING_CONFIGURATION_CHANGED',
        details: { keys: impact.changed_keys }
      });
    }
    if (impact.manual_rearm_required) {
      await engineState.setFaulted({
        preserveIntent: false,
        operator: operatorId(req),
        reason: 'ENV_CONFIGURATION_CHANGED',
        details: { keys: impact.changed_keys }
      });
    }
    await auditControl(req, 'ENV_CONFIGURATION_UPDATED', {
      keys: impact.changed_keys,
      impact_scope: impact.impact_scope,
      restart_roles: impact.restart_roles,
      manual_rearm_required: impact.manual_rearm_required
    });
    configurationResponse(res, result.config, impact);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'ENV_UPDATE_FAILED' });
  }
});

router.post('/env/runtime-mode', async (req, res) => {
  try {
    if (req.body?.confirmation !== 'CHANGE TRADING MODE') {
      return res.status(400).json({ ok: false, error: 'Explicit mode confirmation is required', code: 'CONFIRMATION_REQUIRED' });
    }
    const previousMode = getTradingMode();
    envSettings.updateCritical('TRADING_MODE', req.body?.mode);
    await engineState.setFaulted({
      preserveIntent: false,
      operator: operatorId(req),
      reason: 'TRADING_MODE_CHANGED'
    });
    await auditControl(req, 'RUNTIME_MODE_CHANGED_AND_DISARMED', {
      from: previousMode,
      to: req.body.mode
    });
    configurationResponse(
      res,
      { mode: req.body.mode, armed: false },
      envSettings.impactForKeys(['TRADING_MODE'])
    );
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'MODE_UPDATE_FAILED' });
  }
});

router.post('/env/live-enabled', async (req, res) => {
  try {
    const next = Boolean(req.body?.enabled);
    if (next && req.body?.confirmation !== 'ENABLE LIVE TRADING') {
      return res.status(400).json({ ok: false, error: 'Explicit live-enable confirmation is required', code: 'CONFIRMATION_REQUIRED' });
    }
    envSettings.updateCritical('LIVE_TRADING_ENABLED', String(next));
    await engineState.setFaulted({
      preserveIntent: false,
      operator: operatorId(req),
      reason: 'LIVE_ENABLE_CHANGED'
    });
    await auditControl(req, 'LIVE_ENABLE_CHANGED_AND_DISARMED', { enabled: next });
    configurationResponse(
      res,
      { live_enabled: next, armed: false },
      envSettings.impactForKeys(['LIVE_TRADING_ENABLED'])
    );
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'LIVE_ENABLE_UPDATE_FAILED' });
  }
});

router.post('/env/gmgn-private-key', async (req, res) => {
  try {
    if (req.body?.confirmation !== 'REPLACE GMGN PRIVATE KEY') {
      return res.status(400).json({ ok: false, error: 'Explicit key replacement confirmation is required', code: 'CONFIRMATION_REQUIRED' });
    }
    envSettings.replaceGmgnPrivateKey(req.body?.private_key);
    await engineState.setFaulted({
      preserveIntent: false,
      operator: operatorId(req),
      reason: 'GMGN_PRIVATE_KEY_CHANGED'
    });
    await auditControl(req, 'GMGN_PRIVATE_KEY_REPLACED_AND_DISARMED');
    configurationResponse(
      res,
      { gmgn_private_key_configured: true, armed: false },
      envSettings.impactForKeys(['GMGN_PRIVATE_KEY'])
    );
  } catch (err) {
    res.status(400).json({ ok: false, error: 'GMGN private key is invalid', code: err.code || 'GMGN_PRIVATE_KEY_INVALID' });
  }
});

module.exports = router;
