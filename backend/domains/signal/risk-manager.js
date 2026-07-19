// D:\AI_Projects\xbot\backend\domains\signal\risk-manager.js
const db = require('../../lib/db');
const logger = require('../../lib/logger');
const configService = require('../config/service');
const engineState = require('../../lib/engine-state');
const gmgnHttp = require('../../lib/gmgn-http');
const { CHAIN_REGISTRY } = require('../../lib/chain-config');

/**
 * 校验各项风控规则 (Dry-Run 模式)
 * 返回 { riskCheck, passed, rejectReason }
 */
async function checkRisks(signal, whitelist) {
  const chainId = whitelist.chain_id;
  const ca = whitelist.contract_address;

  // 获取全局配置
  const riskConfig = await configService.get('risk_config') || {};
  const chainConfigs = await configService.get('chain_configs') || {};
  const chainConf = chainConfigs[chainId] || {};

  const riskCheck = {
    // L1: Whitelist Level
    wl_active: false,
    wl_budget_ok: false,
    wl_repeat_ok: false,
    wl_not_expired: false,
    ca_cooldown_ok: false,

    // L2: Chain Level
    chain_enabled: false,
    chain_daily_budget_ok: false,
    chain_weekly_budget_ok: false,
    trade_size_ok: false,
    max_positions_ok: false,
    daily_loss_ok: false,
    consecutive_loss_ok: false,

    // L3: Global/Security Level
    engine_armed: false,
    not_honeypot: false,
    buy_tax_ok: false,
    sell_tax_ok: false,
    liquidity_ok: false,

    // L4: Execution Level
    ca_failure_ok: false,
    slippage_ok: false
  };

  let passed = true;
  let rejectReason = null;

  const setFailed = (reason) => {
    if (passed) {
      passed = false;
      rejectReason = reason;
    }
  };

  try {
    // ═══════════════════════════════════
    // Layer 1 — 白名单级
    // ═══════════════════════════════════

    // 1. 白名单是否活跃
    riskCheck.wl_active = whitelist.status === 'active';
    if (!riskCheck.wl_active) setFailed('WL_NOT_ACTIVE');

    // 2. 白名单总预算未超限
    const amount = Number(whitelist.budget_per_trade);
    riskCheck.wl_budget_ok = (Number(whitelist.spent_budget) + amount) <= Number(whitelist.total_budget);
    if (!riskCheck.wl_budget_ok) setFailed('WL_BUDGET_EXCEEDED');

    // 3. 重复买入次数
    riskCheck.wl_repeat_ok = !whitelist.allow_repeat_buy || (whitelist.current_buy_count < whitelist.max_repeat_buys);
    if (!riskCheck.wl_repeat_ok) setFailed('WL_REPEAT_LIMIT');

    // 4. 未过期
    riskCheck.wl_not_expired = !whitelist.expires_at || (new Date(whitelist.expires_at) > new Date());
    if (!riskCheck.wl_not_expired) setFailed('WL_EXPIRED');

    // 5. 单 CA 买入冷却时间 (默认 30 分钟)
    const cooldownMin = riskConfig.ca_cooldown_min || 30;
    const cooldownRes = await db.query(
      `SELECT COUNT(*) FROM positions 
       WHERE contract_address = $1 AND chain_id = $2 
         AND opened_at >= NOW() - CAST($3 || ' minutes' AS INTERVAL)`,
      [ca, chainId, cooldownMin]
    );
    riskCheck.ca_cooldown_ok = parseInt(cooldownRes.rows[0].count, 10) === 0;
    if (!riskCheck.ca_cooldown_ok) setFailed('CA_BUY_COOLDOWN');

    // ═══════════════════════════════════
    // Layer 2 — 链级
    // ═══════════════════════════════════

    // 6. 链是否启用
    riskCheck.chain_enabled = chainConf.enabled === true;
    if (!riskCheck.chain_enabled) setFailed('CHAIN_DISABLED');

    // 7. 日预算
    const dailyLimit = chainConf.dailyBudget || 0;
    const dailySpentRes = await db.query(
      `SELECT COALESCE(SUM(amount_in), 0) as spent FROM positions 
       WHERE chain_id = $1 AND opened_at >= NOW() - INTERVAL '1 day' AND status != 'failed'`,
      [chainId]
    );
    const dailySpent = Number(dailySpentRes.rows[0].spent);
    riskCheck.chain_daily_budget_ok = dailyLimit === 0 || (dailySpent + amount <= dailyLimit);
    if (!riskCheck.chain_daily_budget_ok) setFailed('DAILY_BUDGET_EXCEEDED');

    // 8. 周预算
    const weeklyLimit = chainConf.weeklyBudget || 0;
    const weeklySpentRes = await db.query(
      `SELECT COALESCE(SUM(amount_in), 0) as spent FROM positions 
       WHERE chain_id = $1 AND opened_at >= NOW() - INTERVAL '7 days' AND status != 'failed'`,
      [chainId]
    );
    const weeklySpent = Number(weeklySpentRes.rows[0].spent);
    riskCheck.chain_weekly_budget_ok = weeklyLimit === 0 || (weeklySpent + amount <= weeklyLimit);
    if (!riskCheck.chain_weekly_budget_ok) setFailed('WEEKLY_BUDGET_EXCEEDED');

    // 9. 单笔交易上限
    const maxPerTrade = chainConf.maxPerTrade || 0;
    riskCheck.trade_size_ok = maxPerTrade === 0 || (amount <= maxPerTrade);
    if (!riskCheck.trade_size_ok) setFailed('TRADE_TOO_LARGE');

    // 10. 最大同时活跃持仓
    const maxPositions = chainConf.maxOpenPositions || 5;
    const activePositionsRes = await db.query(
      "SELECT COUNT(*) FROM positions WHERE chain_id = $1 AND status = 'open'",
      [chainId]
    );
    riskCheck.max_positions_ok = parseInt(activePositionsRes.rows[0].count, 10) < maxPositions;
    if (!riskCheck.max_positions_ok) setFailed('MAX_POSITIONS_REACHED');

    // 11. 日亏损熔断
    const dailyLossLimit = chainConf.dailyLossLimit || 0;
    const dailyRealizedRes = await db.query(
      `SELECT COALESCE(SUM(pnl), 0) as pnl FROM positions 
       WHERE chain_id = $1 AND closed_at >= NOW() - INTERVAL '1 day' 
         AND status IN ('tp_hit', 'sl_hit', 'manual_close')`,
      [chainId]
    );
    const dailyLoss = Number(dailyRealizedRes.rows[0].pnl);
    // dailyLoss 为负代表亏损
    riskCheck.daily_loss_ok = dailyLossLimit === 0 || dailyLoss >= -dailyLossLimit;
    if (!riskCheck.daily_loss_ok) setFailed('DAILY_LOSS_BREAKER');

    // 12. 连续亏损熔断
    const consecutiveLossLimit = riskConfig.consecutive_loss_limit || 5;
    const lastPositionsRes = await db.query(
      `SELECT status, pnl FROM positions 
       WHERE chain_id = $1 AND status IN ('tp_hit', 'sl_hit', 'manual_close', 'failed')
       ORDER BY closed_at DESC LIMIT $2`,
      [chainId, consecutiveLossLimit]
    );
    const lastPositions = lastPositionsRes.rows;
    if (lastPositions.length >= consecutiveLossLimit) {
      // 检查最近 N 笔是否全是亏损或交易失败
      const allLosses = lastPositions.every(p => Number(p.pnl) < 0 || p.status === 'failed');
      riskCheck.consecutive_loss_ok = !allLosses;
    } else {
      riskCheck.consecutive_loss_ok = true;
    }
    if (!riskCheck.consecutive_loss_ok) setFailed('CONSECUTIVE_LOSS_BREAKER');

    // ═══════════════════════════════════
    // Layer 3 — 全局级（代币安全）
    // ═══════════════════════════════════

    // 13. 引擎已解锁
    riskCheck.engine_armed = engineState.getArmed();
    if (!riskCheck.engine_armed) setFailed('ENGINE_LOCKED');

    // 调用 GMGN API 获取安全属性和基本信息
    const security = await gmgnHttp.getTokenSecurity(chainId, ca);
    const tokenInfo = await gmgnHttp.getTokenInfo(chainId, ca);

    // 14. 蜜罐校验
    riskCheck.not_honeypot = security.is_honeypot === false;
    if (!riskCheck.not_honeypot) setFailed('HONEYPOT_DETECTED');

    // 15. 买入税率 (默认上限 5%)
    const maxBuyTax = riskConfig.max_buy_tax || 5;
    riskCheck.buy_tax_ok = security.buy_tax === undefined || security.buy_tax <= maxBuyTax;
    if (!riskCheck.buy_tax_ok) setFailed('HIGH_BUY_TAX');

    // 16. 卖出税率 (默认上限 10%)
    const maxSellTax = riskConfig.max_sell_tax || 10;
    riskCheck.sell_tax_ok = security.sell_tax === undefined || security.sell_tax <= maxSellTax;
    if (!riskCheck.sell_tax_ok) setFailed('HIGH_SELL_TAX');

    // 17. 最小流动性深度 (默认 $10,000)
    const minLiquidity = riskConfig.min_liquidity_usd || 10000;
    riskCheck.liquidity_ok = tokenInfo.liquidity === undefined || tokenInfo.liquidity >= minLiquidity;
    if (!riskCheck.liquidity_ok) setFailed('LOW_LIQUIDITY');

    // ═══════════════════════════════════
    // Layer 4 — 执行级
    // ═══════════════════════════════════

    // 18. CA 连续执行失败锁定 (最近 2 小时失败不超过 3 次)
    const failureRes = await db.query(
      `SELECT COUNT(*) FROM positions 
       WHERE contract_address = $1 AND status = 'failed' 
         AND opened_at >= NOW() - INTERVAL '2 hours'`,
      [ca]
    );
    riskCheck.ca_failure_ok = parseInt(failureRes.rows[0].count, 10) < 3;
    if (!riskCheck.ca_failure_ok) setFailed('CA_FAILURE_LOCKED');

    // 19. 滑点检查
    // 通过询价接口模拟报价
    const chainRegistry = CHAIN_REGISTRY[chainId] || {};
    const nativeToken = chainRegistry.nativeToken || '';
    const maxSlippage = riskConfig.max_slippage_pct || 15;
    
    const quote = await gmgnHttp.quote(chainId, nativeToken, ca, amount, maxSlippage);
    riskCheck.slippage_ok = quote.price_impact <= maxSlippage;
    if (!riskCheck.slippage_ok) setFailed('SLIPPAGE_TOO_HIGH');

  } catch (err) {
    logger.error('risk-manager', `风控评估程序异常: ${err.message}`, { ca, chainId });
    setFailed('RISK_ENGINE_EXCEPTION');
  }

  return {
    riskCheck,
    passed,
    rejectReason
  };
}

module.exports = {
  checkRisks
};
