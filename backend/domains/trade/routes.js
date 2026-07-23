// D:\AI_Projects\xbot\backend\domains\trade\routes.js
const express = require('express');
const router = express.Router();
const queries = require('./queries');
const gmgnHttp = require('../../lib/gmgn-http');
const logger = require('../../lib/logger');
const db = require('../../lib/db');
const paperEngine = require('./paper-engine');
const executionService = require('./execution-service');
const closeService = require('./close-service');
const repository = require('./trade-repository');
const readinessService = require('./readiness-service');
const { reconciler } = require('./reconciliation-service');
const { shadowLiveEvaluator } = require('../../jobs/shadow-live-evaluator');
const { liveExecutionQueue } = require('./live-execution-queue');

const ACTIVE_POSITION_STATUSES = [
  'open', 'open_unprotected', 'open_protected', 'partially_closed', 'closing',
  'close_uncertain', 'protection_failed'
];

function operatorId(req) {
  return String(req.get('x-operator-id') || 'admin').slice(0, 128);
}

function sendError(res, error) {
  const conflictCodes = new Set([
    'TRADE_ATTEMPT_EXISTS', 'SELL_ATTEMPT_EXISTS', 'TRADE_ATTEMPT_CAS_FAILED',
    'PREPARE_SNAPSHOT_CHANGED', 'PREPARE_TOKEN_INVALID', 'POSITION_NOT_CLOSABLE',
    'STRATEGY_STATE_UNSAFE', 'LIVE_READINESS_FAILED'
  ]);
  const status = error.code === 'SIGNAL_NOT_FOUND' || error.code === 'POSITION_NOT_FOUND'
    ? 404
    : conflictCodes.has(error.code) ? 409 : 400;
  res.status(status).json({ ok: false, error: error.message, code: error.code || 'TRADE_REQUEST_FAILED' });
}

// 获取当前活跃持仓
router.get('/positions', async (req, res) => {
  try {
    const filters = {
      statuses: ACTIVE_POSITION_STATUSES,
      chain_id: req.query.chain_id
    };
    const positions = await queries.getPositions(filters);
    res.json({ ok: true, data: positions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/runtime-policy', async (req, res) => {
  try {
    const readiness = await readinessService.getSnapshot();
    res.json({
      ok: true,
      data: {
        scheduler: readiness.scheduler,
        polling_policy: readiness.pollingPolicy,
        readiness,
        live_queue: liveExecutionQueue.getStatus(),
        shadow: shadowLiveEvaluator.getStatus(),
        endpoint_weights: readiness.scheduler.endpointWeights,
        new_trade_reservation_weight: 7
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/reconciliation', async (req, res) => {
  try {
    res.json({ ok: true, data: await reconciler.getStatus() });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/attempts', async (req, res) => {
  try {
    res.json({ ok: true, data: await repository.listAttempts(req.query.limit) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/attempts/:id', async (req, res) => {
  try {
    const attempt = await repository.getAttemptDetails(req.params.id);
    if (!attempt) return res.status(404).json({ ok: false, error: 'Trade attempt not found', code: 'ATTEMPT_NOT_FOUND' });
    res.json({ ok: true, data: attempt });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/signals/:id/prepare', async (req, res) => {
  try {
    const data = await executionService.prepare(req.params.id, operatorId(req));
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/signals/:id/execute', async (req, res) => {
  try {
    if (req.body?.confirmation !== 'EXECUTE LIVE BUY') {
      return res.status(400).json({ ok: false, error: 'Explicit buy confirmation is required', code: 'CONFIRMATION_REQUIRED' });
    }
    const data = await executionService.execute(req.params.id, req.body?.prepare_token, operatorId(req));
    res.status(202).json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/positions/:id/close/prepare', async (req, res) => {
  try {
    const data = await closeService.prepare(req.params.id, operatorId(req), {
      percent: req.body?.percent,
      slippage: req.body?.slippage
    });
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/positions/:id/close/execute', async (req, res) => {
  try {
    if (req.body?.confirmation !== 'EXECUTE LIVE CLOSE') {
      return res.status(400).json({ ok: false, error: 'Explicit close confirmation is required', code: 'CONFIRMATION_REQUIRED' });
    }
    const data = await closeService.execute(
      req.params.id,
      req.body?.prepare_token,
      operatorId(req)
    );
    res.status(202).json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
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
    if (!ACTIVE_POSITION_STATUSES.includes(pos.status)) {
      return res.status(400).json({ ok: false, error: 'Position is already closed' });
    }
    if (pos.execution_mode === 'live') {
      return res.status(409).json({
        ok: false,
        error: 'Live close requires prepare and explicit execute confirmation',
        code: 'LIVE_CLOSE_PREPARE_REQUIRED'
      });
    }

    // 2. 获取当前实时价格进行平仓
    const tokenInfo = await gmgnHttp.getTokenInfo(pos.chain_id, pos.contract_address);
    const exitPriceUsd = Number(tokenInfo.price_usd || tokenInfo.price || 0);

    if (exitPriceUsd <= 0) {
      return res.status(400).json({ ok: false, error: 'Failed to fetch current token price for closing' });
    }

    let closedPos;
    if (pos.execution_mode === 'paper') {
      closedPos = await paperEngine.closeSimulatedPosition(
        positionId,
        exitPriceUsd,
        'manual_close',
        wsBroadcast
      );
    } else {
      return res.status(409).json({ ok: false, error: 'Legacy position execution mode is unknown' });
    }

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
