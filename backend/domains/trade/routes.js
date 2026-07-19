// D:\AI_Projects\xbot\backend\domains\trade\routes.js
const express = require('express');
const router = express.Router();
const queries = require('./queries');
const tradeEngine = require('./trade-engine');
const gmgnHttp = require('../../lib/gmgn-http');
const logger = require('../../lib/logger');
const db = require('../../lib/db');

// 获取当前活跃持仓
router.get('/positions', async (req, res) => {
  try {
    const filters = {
      status: 'open',
      chain_id: req.query.chain_id
    };
    const positions = await queries.getPositions(filters);
    res.json({ ok: true, data: positions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 获取已平仓交易历史
router.get('/history', async (req, res) => {
  try {
    const filters = {
      chain_id: req.query.chain_id
    };
    const history = await queries.getHistory(filters);
    res.json({ ok: true, data: history });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 手动平仓接口
router.post('/positions/:id/close', async (req, res) => {
  try {
    const positionId = req.params.id;
    const wsBroadcast = req.app.get('wsBroadcast');

    // 1. 查询持仓确认存在
    const posRes = await db.query('SELECT * FROM positions WHERE id = $1', [positionId]);
    const pos = posRes.rows[0];
    if (!pos) {
      return res.status(404).json({ ok: false, error: 'Position not found' });
    }
    if (pos.status !== 'open') {
      return res.status(400).json({ ok: false, error: 'Position is already closed' });
    }

    // 2. 获取当前实时价格进行平仓
    const tokenInfo = await gmgnHttp.getTokenInfo(pos.chain_id, pos.contract_address);
    const exitPriceUsd = Number(tokenInfo.price_usd || tokenInfo.price || 0);

    if (exitPriceUsd <= 0) {
      return res.status(400).json({ ok: false, error: 'Failed to fetch current token price for closing' });
    }

    // 3. 执行真实平仓 (包含条件单撤销)
    const closedPos = await tradeEngine.closeRealPosition(
      positionId, 
      exitPriceUsd, 
      'manual_close', 
      wsBroadcast
    );

    res.json({ ok: true, data: closedPos });
  } catch (err) {
    logger.error('trade-routes', `手动平仓失败: ${err.message}`, { id: req.params.id });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 导出已平仓交易历史为 CSV
router.get('/history/export-csv', async (req, res) => {
  try {
    const history = await queries.getHistory({});
    
    let csvContent = '\uFEFF'; // UTF-8 BOM
    csvContent += 'ID,链,代币符号,合约地址,投入额,入场价格,出场价格,实际盈亏,盈亏比例(%),状态,开仓时间,平仓时间\n';
    
    history.forEach(pos => {
      const pnl = Number(pos.pnl || 0).toFixed(5);
      const pnlPct = Number(pos.pnl_pct || 0).toFixed(2);
      const entryPrice = Number(pos.entry_price || 0).toFixed(6);
      const exitPrice = pos.exit_price ? Number(pos.exit_price).toFixed(6) : '-';
      const openTime = pos.opened_at ? new Date(pos.opened_at).toLocaleString() : '-';
      const closeTime = pos.closed_at ? new Date(pos.closed_at).toLocaleString() : '-';
      
      // Escape commas in project token symbols if any
      const symbol = (pos.symbol || 'Unknown').replace(/,/g, '');
      
      csvContent += `${pos.id},${pos.chain_id.toUpperCase()},${symbol},${pos.contract_address},${pos.amount_in},${entryPrice},${exitPrice},${pnl},${pnlPct},${pos.status},"${openTime}","${closeTime}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=xbot-trade-history.csv');
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
