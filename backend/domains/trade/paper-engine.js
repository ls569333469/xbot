// D:\AI_Projects\xbot\backend\domains\trade\paper-engine.js
const db = require('../../lib/db');
const logger = require('../../lib/logger');
const gmgnHttp = require('../../lib/gmgn-http');

// 原生代币的 Mock 美元价格，用于虚拟算力换算 amount_out
const NATIVE_PRICES = {
  sol: 150.0,
  bsc: 600.0,
  base: 3000.0,
  eth: 3000.0,
  robinhood: 1.0
};

/**
 * 虚拟模拟买入（开仓）
 */
async function openSimulatedPosition(signal, wsBroadcast) {
  const signalId = signal.id;
  const whitelistId = signal.whitelist_id;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. 获取白名单详情并加行锁，防止竞态扣减预算
    const wlRes = await client.query(
      'SELECT * FROM ca_whitelist WHERE id = $1 FOR UPDATE',
      [whitelistId]
    );
    const wl = wlRes.rows[0];
    if (!wl) {
      throw new Error('Whitelist entry not found');
    }

    // 2. 调用 GMGN API 获取代币实时价格 (USD)
    const tokenInfo = await gmgnHttp.getTokenInfo(wl.chain_id, wl.contract_address);
    const entryPriceUsd = tokenInfo.price_usd || tokenInfo.price || 0.001;

    // 3. 计算买入数量 amount_out (花费 budget_per_trade 换成代币数量)
    const amountInNative = Number(wl.budget_per_trade);
    const nativePrice = NATIVE_PRICES[wl.chain_id] || 1.0;
    const amountInUsd = amountInNative * nativePrice;
    const amountOut = entryPriceUsd > 0 ? (amountInUsd / entryPriceUsd) : 0;

    // 4. 插入持仓表 (开仓)
    const posRes = await client.query(
      `INSERT INTO positions (
        signal_id, whitelist_id, contract_address, chain_id, symbol,
        amount_in, amount_out, entry_price, tp_pct, sl_pct,
        tpsl_status, status, opened_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', NOW())
      RETURNING *`,
      [
        signalId, whitelistId, wl.contract_address, wl.chain_id, wl.symbol,
        amountInNative, amountOut, entryPriceUsd, wl.auto_tp_pct, wl.auto_sl_pct,
        'ok'
      ]
    );
    const position = posRes.rows[0];

    // 5. 扣减白名单预算，更新购买次数
    await client.query(
      `UPDATE ca_whitelist 
       SET spent_budget = spent_budget + $1,
           current_buy_count = current_buy_count + 1
       WHERE id = $2`,
      [amountInNative, whitelistId]
    );

    await client.query('COMMIT');
    logger.trade('paper-engine', `模拟开仓成功: ${wl.symbol} (${wl.contract_address}) on ${wl.chain_id} | 入场价: $${entryPriceUsd} | 数量: ${amountOut}`, { position });

    // 6. 广播推送
    if (wsBroadcast) {
      wsBroadcast({ type: 'trade:executed', payload: position });
    }

    return position;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('paper-engine', `模拟开仓失败: ${err.message}`, { signalId, whitelistId });
    
    // 如果开仓失败，将 trade_signal 状态标为 rejected 记录失败原因
    await db.query(
      "UPDATE trade_signals SET status = 'rejected', reject_reason = $1, updated_at = NOW() WHERE id = $2",
      [err.message, signalId]
    );
    
    if (wsBroadcast) {
      wsBroadcast({ type: 'trade:failed', payload: { signalId, error: err.message } });
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 虚拟模拟平仓 (TP/SL 触发或手动平仓)
 */
async function closeSimulatedPosition(positionId, exitPriceUsd, statusReason, wsBroadcast) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. 获取持仓并锁定
    const posRes = await client.query(
      'SELECT * FROM positions WHERE id = $1 FOR UPDATE',
      [positionId]
    );
    const pos = posRes.rows[0];
    if (!pos) {
      throw new Error(`Position ${positionId} not found`);
    }

    if (pos.status !== 'open') {
      throw new Error(`Position is already closed with status: ${pos.status}`);
    }

    const entryPrice = Number(pos.entry_price);
    const amountIn = Number(pos.amount_in);

    // 2. 计算盈亏比与绝对盈亏金额（链原生代币计）
    let pnlPct = 0;
    if (entryPrice > 0) {
      pnlPct = ((exitPriceUsd - entryPrice) / entryPrice) * 100;
    }
    // 强制限制平仓精度
    pnlPct = Math.round(pnlPct * 100) / 100;
    const pnlNative = amountIn * (pnlPct / 100);

    // 3. 更新持仓数据为平仓状态
    const updatedRes = await client.query(
      `UPDATE positions 
       SET status = $1,
           exit_price = $2,
           pnl = $3,
           pnl_pct = $4,
           closed_at = NOW(),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [statusReason, exitPriceUsd, pnlNative, pnlPct, positionId]
    );
    const closedPos = updatedRes.rows[0];

    await client.query('COMMIT');
    logger.trade('paper-engine', `模拟平仓成功 [${statusReason}]: ${closedPos.symbol} | 出场价: $${exitPriceUsd} | 盈亏: ${pnlNative} (${pnlPct}%)`, { closedPos });

    // 4. 广播平仓事件
    if (wsBroadcast) {
      wsBroadcast({ type: `position:${statusReason}`, payload: closedPos });
    }

    return closedPos;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('paper-engine', `模拟平仓失败: ${err.message}`, { positionId, exitPriceUsd });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  openSimulatedPosition,
  closeSimulatedPosition
};
