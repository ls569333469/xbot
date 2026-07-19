// D:\AI_Projects\xbot\backend\jobs\signal-matcher.js
const db = require('../lib/db');
const logger = require('../lib/logger');
const { matchActivity } = require('../domains/signal/matcher');
const riskManager = require('../domains/signal/risk-manager');
const tradeEngine = require('../domains/trade/trade-engine');

async function run(deps) {
  logger.info('jobs', 'Running signal-matcher job');
  const { wsBroadcast } = deps || {};
  
  // Step 1: 处理未处理的 X 活动，匹配白名单生成 signal (status = 'recorded')
  const activitiesRes = await db.query(
    'SELECT * FROM x_activities WHERE processed = false ORDER BY created_at ASC LIMIT 50'
  );
  
  const activities = activitiesRes.rows;
  let matchedTotal = 0;
  
  for (const activity of activities) {
    try {
      const matches = await matchActivity(activity);
      matchedTotal += matches;
      
      await db.query('UPDATE x_activities SET processed = true WHERE id = $1', [activity.id]);
      
      if (matches > 0 && wsBroadcast) {
        wsBroadcast({ type: 'signal:matched', payload: { activityId: activity.id, matches } });
      }
    } catch (err) {
      logger.error('jobs', `处理活动匹配异常 ${activity.id}: ${err.message}`);
    }
  }
  
  if (matchedTotal > 0) {
    logger.info('jobs', `发现并记录了 ${matchedTotal} 条新的白名单匹配信号`);
  }

  // Step 2: 处理所有状态为 'recorded' 的信号，运行风控并执行买入开仓
  try {
    const signalsRes = await db.query(
      "SELECT * FROM trade_signals WHERE status = 'recorded' ORDER BY created_at ASC"
    );
    const signals = signalsRes.rows;

    for (const sig of signals) {
      try {
        // 获取该信号对应的白名单配置
        const wlRes = await db.query('SELECT * FROM ca_whitelist WHERE id = $1', [sig.whitelist_id]);
        const whitelist = wlRes.rows[0];

        if (!whitelist) {
          logger.warn('jobs', `未找到信号 ${sig.id} 关联的白名单条目，标记为失效`);
          await db.query("UPDATE trade_signals SET status = 'rejected', reject_reason = 'WHITELIST_NOT_FOUND', updated_at = NOW() WHERE id = $1", [sig.id]);
          continue;
        }

        // 运行 L1-L4 风控规则 (实盘拦截模式)
        const { riskCheck, passed, rejectReason } = await riskManager.checkRisks(sig, whitelist);

        if (!passed) {
          // 风控拦截，拒绝下单
          logger.warn('jobs', `信号 ${sig.id} (${whitelist.symbol}) 未通过风控校验，拦截交易 | 原因: ${rejectReason}`);
          await db.query(
            `UPDATE trade_signals 
             SET status = 'rejected', 
                 risk_check = $1, 
                 reject_reason = $2, 
                 updated_at = NOW() 
             WHERE id = $3`,
            [JSON.stringify(riskCheck), rejectReason, sig.id]
          );
          continue;
        }

        // 风控通过，批准开仓
        const signalStatus = 'approved';
        await db.query(
          `UPDATE trade_signals 
           SET status = $1, 
               risk_check = $2, 
               reject_reason = NULL, 
               updated_at = NOW() 
           WHERE id = $3`,
          [signalStatus, JSON.stringify(riskCheck), sig.id]
        );

        // 绑定更新后的信号值以传递给交易引擎
        const updatedSignal = { ...sig, status: signalStatus };

        // 触发自动交易引擎开仓 (买入并绑定 TP/SL)
        await tradeEngine.openRealPosition(updatedSignal, wsBroadcast);

      } catch (innerErr) {
        logger.error('jobs', `信号 ${sig.id} 风控或执行真实交易失败: ${innerErr.message}`);
      }
    }
  } catch (err) {
    logger.error('jobs', `执行信号交易匹配流失败: ${err.message}`);
  }
}

module.exports = { run };
