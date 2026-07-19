const express = require('express');
const router = express.Router();
const db = require('../../lib/db');
const signalQueries = require('../signal/queries');
const engineState = require('../../lib/engine-state');

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

router.post('/arm', (req, res) => {
  engineState.setArmed(true);
  res.json({ ok: true, data: { armed: true } });
});

router.post('/disarm', (req, res) => {
  engineState.setArmed(false);
  res.json({ ok: true, data: { armed: false } });
});

router.get('/engine-status', (req, res) => {
  res.json({ ok: true, data: { armed: engineState.getArmed() } });
});

router.get('/budgets', async (req, res) => {
  try {
    const budgets = await db.query('SELECT * FROM budget_tracking ORDER BY created_at DESC');
    res.json({ ok: true, data: budgets.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Signals ──
router.get('/signals', async (req, res) => {
  try {
    const { chain_id, signal_type, status, page = 1, pageSize = 20 } = req.query;
    let query = `SELECT ts.*, ca.symbol, ca.chain_id, ca.project_name
      FROM trade_signals ts
      LEFT JOIN ca_whitelist ca ON ts.whitelist_id = ca.id
      WHERE 1=1`;
    const params = [];
    let idx = 1;
    if (chain_id) { query += ` AND ca.chain_id = $${idx++}`; params.push(chain_id); }
    if (signal_type) { query += ` AND ts.signal_type = $${idx++}`; params.push(signal_type); }
    if (status) { query += ` AND ts.status = $${idx++}`; params.push(status); }
    const countQ = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM');
    const countRes = await db.query(countQ, params);
    const total = parseInt(countRes.rows[0].count, 10);
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    query += ` ORDER BY ts.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(pageSize, 10), offset);
    const result = await db.query(query, params);
    res.json({ ok: true, data: result.rows, total, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
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
const fs = require('fs');
const path = require('path');
const logger = require('../../lib/logger');
const ENV_PATH = path.resolve(__dirname, '../../.env');

router.get('/env', (req, res) => {
  try {
    if (!fs.existsSync(ENV_PATH)) {
      return res.json({ ok: true, data: {} });
    }
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    const lines = content.split('\n');
    const envObj = {};

    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const firstEq = trimmed.indexOf('=');
      if (firstEq === -1) return;
      const key = trimmed.slice(0, firstEq).trim();
      const val = trimmed.slice(firstEq + 1).trim();
      
      const secretKeys = ['DB_PASSWORD', 'GMGN_PRIVATE_KEY', 'SOCIALDATA_API_KEY', 'ADMIN_TOKEN', 'TG_BOT_TOKEN'];
      if (secretKeys.includes(key)) {
        envObj[key] = val ? '********' : '';
      } else {
        envObj[key] = val;
      }
    });

    res.json({ ok: true, data: envObj });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/env', (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ ok: false, error: 'Invalid configuration object.' });
    }

    let originalEnv = {};
    if (fs.existsSync(ENV_PATH)) {
      const content = fs.readFileSync(ENV_PATH, 'utf8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const firstEq = trimmed.indexOf('=');
        if (firstEq === -1) return;
        const key = trimmed.slice(0, firstEq).trim();
        const val = trimmed.slice(firstEq + 1).trim();
        originalEnv[key] = val;
      });
    }

    const secretKeys = ['DB_PASSWORD', 'GMGN_PRIVATE_KEY', 'SOCIALDATA_API_KEY', 'ADMIN_TOKEN', 'TG_BOT_TOKEN'];
    const outputLines = [
      '# ═══ xbot — 环境变量 (Configured via API Panel) ═══',
      ''
    ];

    const allKeys = [
      'BACKEND_PORT', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
      'GMGN_API_KEY', 'GMGN_PRIVATE_KEY', 'X_DATA_PROVIDER', 'SOCIALDATA_API_KEY',
      'WALLET_SOL', 'WALLET_EVM', 'ADMIN_TOKEN', 'TG_BOT_TOKEN', 'TG_CHAT_ID'
    ];

    allKeys.forEach(key => {
      let finalVal = newConfig[key] !== undefined ? String(newConfig[key]).trim() : '';
      if (secretKeys.includes(key) && finalVal === '********') {
        finalVal = originalEnv[key] || '';
      }
      outputLines.push(`${key}=${finalVal}`);
    });

    fs.writeFileSync(ENV_PATH, outputLines.join('\n') + '\n', 'utf8');

    // Touch server.js to force nodemon reload in development mode
    try {
      const serverPath = path.resolve(__dirname, '../../server.js');
      const now = new Date();
      fs.utimesSync(serverPath, now, now);
    } catch (err) {
      // Ignore in non-dev environments
    }

    res.json({ ok: true, message: 'Configuration saved. Restarting server...' });

    setTimeout(() => {
      logger.info('server', 'Environment variables updated. Restarting process via process.exit(0)...');
      process.exit(0);
    }, 100);

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
