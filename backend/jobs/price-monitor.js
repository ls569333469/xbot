// D:\AI_Projects\xbot\backend\jobs\price-monitor.js
const db = require('../lib/db');
const logger = require('../lib/logger');
const gmgnHttp = require('../lib/gmgn-http');
const paperEngine = require('../domains/trade/paper-engine');

async function run(deps) {
  logger.info('jobs', 'Running price-monitor job');
  const { wsBroadcast } = deps || {};

  try {
    // 1. 查询所有处于 open 状态的模拟仓位
    const res = await db.query("SELECT * FROM positions WHERE status = 'open'");
    const openPositions = res.rows;

    for (const pos of openPositions) {
      try {
        // 2. 调用 GMGN API 获取代币实时价格 (USD)
        const tokenInfo = await gmgnHttp.getTokenInfo(pos.chain_id, pos.contract_address);
        const currentPriceUsd = Number(tokenInfo.price_usd || tokenInfo.price || 0);

        if (currentPriceUsd <= 0) {
          logger.warn('price-monitor', `未能获取到 ${pos.symbol} 实时价格，跳过本次更新`);
          continue;
        }

        const entryPrice = Number(pos.entry_price);
        const amountIn = Number(pos.amount_in);
        
        // 计算当前浮动盈亏比
        let pnlPct = 0;
        if (entryPrice > 0) {
          pnlPct = ((currentPriceUsd - entryPrice) / entryPrice) * 100;
        }
        pnlPct = Math.round(pnlPct * 100) / 100;
        const pnlNative = amountIn * (pnlPct / 100);

        // 3. 计算 5m/15m/1h/4h 的最高/最低波动峰值
        const now = new Date();
        const openedAt = new Date(pos.opened_at);
        const diffMs = now - openedAt;
        const diffMin = diffMs / 1000 / 60; // 持仓时长（分钟）

        // 获取或初始化 sim_peaks 字段
        const peaks = (pos.sim_peaks && pos.sim_peaks.peaks_5m) ? pos.sim_peaks : {
          max_gain_pct: 0,
          max_loss_pct: 0,
          peaks_5m: { high: 0, low: 0 },
          peaks_15m: { high: 0, low: 0 },
          peaks_1h: { high: 0, low: 0 },
          peaks_4h: { high: 0, low: 0 }
        };

        // 更新历史总极值
        if (pnlPct > (peaks.max_gain_pct || 0)) peaks.max_gain_pct = pnlPct;
        if (pnlPct < (peaks.max_loss_pct || 0)) peaks.max_loss_pct = pnlPct;

        // 分时间段记录极值
        if (diffMin <= 5) {
          if (pnlPct > (peaks.peaks_5m.high || 0)) peaks.peaks_5m.high = pnlPct;
          if (pnlPct < (peaks.peaks_5m.low || 0)) peaks.peaks_5m.low = pnlPct;
        }
        if (diffMin <= 15) {
          if (pnlPct > (peaks.peaks_15m.high || 0)) peaks.peaks_15m.high = pnlPct;
          if (pnlPct < (peaks.peaks_15m.low || 0)) peaks.peaks_15m.low = pnlPct;
        }
        if (diffMin <= 60) {
          if (pnlPct > (peaks.peaks_1h.high || 0)) peaks.peaks_1h.high = pnlPct;
          if (pnlPct < (peaks.peaks_1h.low || 0)) peaks.peaks_1h.low = pnlPct;
        }
        if (diffMin <= 240) {
          if (pnlPct > (peaks.peaks_4h.high || 0)) peaks.peaks_4h.high = pnlPct;
          if (pnlPct < (peaks.peaks_4h.low || 0)) peaks.peaks_4h.low = pnlPct;
        }

        // 4. 检查是否命中 TP（止盈） 或 SL（止损）
        const tpThreshold = Number(pos.tp_pct || 100);
        const slThreshold = Number(pos.sl_pct || 20);

        if (pnlPct >= tpThreshold) {
          logger.trade('price-monitor', `代币 ${pos.symbol} 达到止盈线 (+${pnlPct}% >= +${tpThreshold}%)，触发自动平仓`);
          await paperEngine.closeSimulatedPosition(pos.id, currentPriceUsd, 'tp_hit', wsBroadcast);
        } else if (pnlPct <= -slThreshold) {
          logger.trade('price-monitor', `代币 ${pos.symbol} 跌破止损线 (${pnlPct}% <= -${slThreshold}%)，触发自动平仓`);
          await paperEngine.closeSimulatedPosition(pos.id, currentPriceUsd, 'sl_hit', wsBroadcast);
        } else {
          // 5. 未触发 TP/SL，仅更新当前实时价格、PnL 盈亏比及极值记录
          await db.query(
            `UPDATE positions 
             SET pnl = $1, 
                 pnl_pct = $2, 
                 exit_price = $3, 
                 sim_peaks = $4,
                 updated_at = NOW() 
             WHERE id = $5`,
            [pnlNative, pnlPct, currentPriceUsd, JSON.stringify(peaks), pos.id]
          );

          // 广播更新事件给前端
          if (wsBroadcast) {
            wsBroadcast({
              type: 'position:update',
              payload: {
                id: pos.id,
                pnl: pnlNative,
                pnl_pct: pnlPct,
                exit_price: currentPriceUsd,
                sim_peaks: peaks
              }
            });
          }
        }
      } catch (innerErr) {
        logger.error('price-monitor', `处理仓位 ${pos.id} (${pos.symbol}) 价格监视异常: ${innerErr.message}`);
      }
    }
  } catch (err) {
    logger.error('price-monitor', `价格监视 Job 执行失败: ${err.message}`);
  }
}

module.exports = { run };
