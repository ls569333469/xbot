// D:\AI_Projects\xbot\backend\jobs\signal-matcher.js
const db = require('../lib/db');
const logger = require('../lib/logger');
const { matchActivity } = require('../domains/signal/matcher');
const riskManager = require('../domains/signal/risk-manager');
const paperEngine = require('../domains/trade/paper-engine');
const engineState = require('../lib/engine-state');
const { getTradingMode } = require('../lib/runtime-mode');

async function claimSignals(executionMode) {
  const maxAgeSeconds = Math.max(30, Number(process.env.SIGNAL_MAX_AGE_SECONDS || 300));
  await db.query(
    `UPDATE trade_signals
     SET status = 'expired', reject_reason = 'SIGNAL_EXPIRED', updated_at = NOW()
     WHERE status = 'recorded'
       AND execution_mode = $1
       AND created_at < NOW() - ($2 * INTERVAL '1 second')`,
    [executionMode, maxAgeSeconds]
  );

  const result = await db.query(
    `UPDATE trade_signals
     SET status = 'pending', updated_at = NOW()
     WHERE id IN (
       SELECT id FROM trade_signals
       WHERE status = 'recorded'
         AND execution_mode = $1
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 20
     )
     RETURNING *`,
    [executionMode]
  );
  return result.rows;
}

async function run(deps) {
  logger.info('jobs', 'Running signal-matcher job');
  const { wsBroadcast } = deps || {};
  const executionMode = getTradingMode();
  
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

  if (executionMode === 'signal') {
    return { status: 'signal_only', matched: matchedTotal, executed: 0 };
  }
  if (executionMode === 'live') {
    return {
      status: engineState.getArmed() ? 'live_queue_owned' : 'live_stopped',
      matched: matchedTotal,
      executed: 0
    };
  }

  // Step 2: claim only signals created for the current execution mode.
  try {
    const signals = await claimSignals(executionMode);
    let executed = 0;

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
        const { riskCheck, passed, rejectReason } = await riskManager.checkRisks(
          sig,
          whitelist,
          { executionMode }
        );

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

        await paperEngine.openSimulatedPosition(updatedSignal, wsBroadcast);

        await db.query(
          "UPDATE trade_signals SET status = 'executed', updated_at = NOW() WHERE id = $1",
          [sig.id]
        );
        executed++;

      } catch (innerErr) {
        logger.error('jobs', `信号 ${sig.id} 风控或执行失败: ${innerErr.message}`);
        await db.query(
          `UPDATE trade_signals
           SET status = 'rejected', reject_reason = $1, updated_at = NOW()
           WHERE id = $2 AND status IN ('pending', 'approved')`,
          [innerErr.code || innerErr.message, sig.id]
        );
      }
    }
    return { status: 'completed', matched: matchedTotal, executed };
  } catch (err) {
    logger.error('jobs', `执行信号交易匹配流失败: ${err.message}`);
    throw err;
  }
}

module.exports = { run };
