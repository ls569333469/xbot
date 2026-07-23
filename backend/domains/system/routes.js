const express = require('express');
const router = express.Router();
const db = require('../../lib/db');
const signalQueries = require('../signal/queries');
const engineState = require('../../lib/engine-state');
const { getTradingMode } = require('../../lib/runtime-mode');
const readinessService = require('../trade/readiness-service');
const livePolicy = require('../signal/live-policy');

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
    const totalPnlRes = await db.query("SELECT COALESCE(SUM(pnl), 0) as pnl FROM positions WHERE status != 'open'");
    
    res.json({ 
      ok: true, 
      data: { 
        kols: parseInt(kols.rows[0].count, 10), 
        whitelists: parseInt(wl.rows[0].count, 10),
        signalsToday: parseInt(signalsToday.rows[0].count, 10),
        tradesToday: parseInt(tradesToday.rows[0].count, 10),
        activePositions: parseInt(activePositions.rows[0].count, 10),
        totalPnl: parseFloat(totalPnlRes.rows[0].pnl)
      } 
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/arm', async (req, res) => {
  try {
    if (String(process.env.LIVE_TRADING_ENABLED || 'false').toLowerCase() !== 'true') {
      return res.status(409).json({ ok: false, error: 'Live trading is disabled by configuration', code: 'LIVE_DISABLED' });
    }
    if (req.body?.confirmation !== 'ARM LIVE TRADING') {
      return res.status(400).json({ ok: false, error: 'Explicit live confirmation is required', code: 'CONFIRMATION_REQUIRED' });
    }
    const readiness = await readinessService.assertReadyToArm();
    const runtime = await engineState.arm({ operator: operatorId(req), readiness });
    await auditControl(req, 'LIVE_ENGINE_ARMED', {
      readiness_snapshot: readiness.snapshotHash,
      configuration_fingerprint: readiness.configurationFingerprint
    });
    res.json({ ok: true, data: { ...runtime, mode: getTradingMode() } });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message, code: err.code || 'ARM_FAILED', details: err.details || undefined });
  }
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
    res.json({ ok: true, data: await readinessService.getSnapshot({ probe }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: err.code || 'READINESS_FAILED' });
  }
});

router.get('/budgets', async (req, res) => {
  try {
    const budgets = await db.query('SELECT * FROM budget_tracking ORDER BY created_at DESC');
    res.json({ ok: true, data: budgets.rows });
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
    const { chain_id, signal_type, status, page = 1, pageSize = 20 } = req.query;
    let fromWhere = `FROM trade_signals ts
      LEFT JOIN ca_whitelist ca ON ts.whitelist_id = ca.id
      LEFT JOIN x_activities xa ON ts.activity_id = xa.id
      WHERE 1=1`;
    let query = `SELECT ts.*, ca.symbol, ca.chain_id, ca.project_name, ca.contract_address,
        xa.activity_type, xa.provider, xa.source_created_at,
        xa.observation_started_at, xa.observation_ended_at
      ${fromWhere}`;
    const params = [];
    let idx = 1;
    if (chain_id) { fromWhere += ` AND ca.chain_id = $${idx++}`; params.push(chain_id); }
    if (signal_type) { fromWhere += ` AND ts.signal_type = $${idx++}`; params.push(signal_type); }
    if (status) { fromWhere += ` AND ts.status = $${idx++}`; params.push(status); }
    query = `SELECT ts.*, ca.symbol, ca.chain_id, ca.project_name, ca.contract_address,
      xa.activity_type, xa.provider, xa.source_created_at,
      xa.observation_started_at, xa.observation_ended_at ${fromWhere}`;
    const countRes = await db.query(`SELECT COUNT(*) ${fromWhere}`, params);
    const total = parseInt(countRes.rows[0].count, 10);
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    query += ` ORDER BY ts.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(pageSize, 10), offset);
    const result = await db.query(query, params);
    const [policy, chainRows] = await Promise.all([
      livePolicy.getPolicy(),
      db.query('SELECT chain, implemented, contract_tested FROM chain_live_readiness')
        .catch(() => ({ rows: [] }))
    ]);
    const chainMap = new Map(chainRows.rows.map(item => [item.chain, item]));
    const data = result.rows.map(signal => {
      const policyMatched = policy.providers.includes(String(signal.provider || '').toLowerCase())
        && policy.eventTypes.includes(String(signal.activity_type || '').toLowerCase())
        && policy.chains.includes(String(signal.chain_id || '').toLowerCase())
        && policy.whitelistIds.includes(Number(signal.whitelist_id))
        && Array.isArray(signal.matched_relation_ids) && signal.matched_relation_ids.length > 0;
      const chain = chainMap.get(signal.chain_id);
      const automatic = policyMatched
        && policy.verifiedEventTypes.includes(String(signal.activity_type || '').toLowerCase())
        && chain?.implemented
        && chain?.contract_tested;
      return {
        ...signal,
        live_authorization: automatic ? 'auto_allowed' : policyMatched ? 'manual_allowed' : 'record_only'
      };
    });
    res.json({ ok: true, data, total, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
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
const logger = require('../../lib/logger');
const envSettings = require('./env-settings');

function requestRestart(res, data = {}) {
  res.json({ ok: true, data, message: 'Configuration saved. Restarting server...' });
  setTimeout(() => {
    logger.info('server', 'Environment configuration changed. Restarting process.');
    process.exit(0);
  }, 100);
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
    const data = envSettings.updateGeneral(req.body);
    await engineState.setFaulted({
      preserveIntent: false,
      operator: operatorId(req),
      reason: 'ENV_CONFIGURATION_CHANGED'
    });
    await auditControl(req, 'ENV_CONFIGURATION_UPDATED_AND_DISARMED', {
      keys: Object.keys(req.body).filter((key) => envSettings.ALLOWED_KEYS.includes(key)).sort()
    });
    requestRestart(res, data);
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
    requestRestart(res, { mode: req.body.mode, armed: false });
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
    requestRestart(res, { live_enabled: next, armed: false });
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
    requestRestart(res, { gmgn_private_key_configured: true, armed: false });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'GMGN private key is invalid', code: err.code || 'GMGN_PRIVATE_KEY_INVALID' });
  }
});

module.exports = router;
