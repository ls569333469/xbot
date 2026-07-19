// D:\AI_Projects\xbot\backend\jobs\order-sync.js
const db = require('../lib/db');
const logger = require('../lib/logger');
const gmgnHttp = require('../lib/gmgn-http');

async function run(deps) {
  logger.info('jobs', 'Running order-sync job');
  const { wsBroadcast } = deps || {};
  const apiKey = process.env.GMGN_API_KEY;

  try {
    // 1. 查询所有处于 open 状态并且配置了在途 TP/SL 单的持仓
    const res = await db.query(
      "SELECT * FROM positions WHERE status = 'open' AND (tp_order_id IS NOT NULL OR sl_order_id IS NOT NULL)"
    );
    const openPositions = res.rows;

    for (const pos of openPositions) {
      try {
        const chain = pos.chain_id;
        const fromAddress = chain === 'sol' ? process.env.WALLET_SOL : process.env.WALLET_EVM;
        const orderId = pos.tp_order_id || pos.sl_order_id;

        let status = 'pending';
        let exitPrice = 0;

        if (!apiKey) {
          // ◈ Mock 同步模式：如果持仓超过 60 秒，有 20% 概率触发随机止盈或止损完成交易
          const openedAt = new Date(pos.opened_at);
          const diffSec = (Date.now() - openedAt.getTime()) / 1000;
          
          if (diffSec > 60 && Math.random() < 0.2) {
            status = Math.random() < 0.5 ? 'tp_hit' : 'sl_hit';
            const drift = status === 'tp_hit' ? (Number(pos.tp_pct) / 100) : -(Number(pos.sl_pct) / 100);
            exitPrice = Number(pos.entry_price) * (1 + drift);
          }
        } else {
          // ◈ 真实链上状态同步
          if (!fromAddress) continue;
          
          const orderData = await gmgnHttp.queryStrategyOrder(chain, orderId, fromAddress);
          
          if (orderData && orderData.status === 'completed') {
            exitPrice = Number(orderData.executed_price || pos.entry_price);
            // 判定是止盈还是止损触发
            if (exitPrice >= Number(pos.entry_price)) {
              status = 'tp_hit';
            } else {
              status = 'sl_hit';
            }
          } else if (orderData && ['failed', 'cancelled'].includes(orderData.status)) {
            status = 'failed';
            exitPrice = Number(pos.entry_price); // 异常退出
          }
        }

        if (status !== 'pending') {
          // 2. 计算最终盈亏
          const entryPrice = Number(pos.entry_price);
          const amountIn = Number(pos.amount_in);
          let pnlPct = 0;
          if (entryPrice > 0) {
            pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
          }
          pnlPct = Math.round(pnlPct * 100) / 100;
          const pnlNative = amountIn * (pnlPct / 100);

          // 3. 更新 positions 库记录
          const updateRes = await db.query(
            `UPDATE positions 
             SET status = $1, 
                 exit_price = $2, 
                 pnl = $3, 
                 pnl_pct = $4, 
                 closed_at = NOW(), 
                 updated_at = NOW() 
             WHERE id = $5
             RETURNING *`,
            [status, exitPrice, pnlNative, pnlPct, pos.id]
          );
          const closedPosition = updateRes.rows[0];

          logger.trade('order-sync', `链上条件单状态同步完成 | 代币: ${pos.symbol} | 结果: ${status} | 最终 PnL: ${pnlPct}%`);

          // 4. 广播平仓事件给前端
          if (wsBroadcast) {
            wsBroadcast({
              type: `position:${status}`,
              payload: closedPosition
            });
          }
        }
      } catch (innerErr) {
        logger.error('order-sync', `同步仓位 ${pos.id} 条件单状态发生异常: ${innerErr.message}`);
      }
    }
  } catch (err) {
    logger.error('order-sync', `链上订单同步 Job 执行失败: ${err.message}`);
  }
}

module.exports = { run };
