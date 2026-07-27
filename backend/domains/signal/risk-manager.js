const db = require('../../lib/db');
const logger = require('../../lib/logger');
const configService = require('../config/service');
const engineState = require('../../lib/engine-state');
const gmgnHttp = require('../../lib/gmgn-http');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const { decimalToRaw } = require('../../lib/decimal-units');
const { CHAIN_REGISTRY } = require('../../lib/chain-config');

/**
 * 校验各项风控规则 (Dry-Run 模式)
 * 返回 { riskCheck, passed, rejectReason }
 */
async function checkRisks(signal, whitelist, options = {}) {
  const executionMode = options.executionMode || signal.execution_mode || 'signal';
  if (executionMode === 'signal') {
    return {
      riskCheck: { execution_mode: 'signal', external_checks_skipped: true },
      passed: false,
      rejectReason: 'SIGNAL_ONLY'
    };
  }
  if (executionMode === 'live') {
    return {
      riskCheck: {
        execution_mode: 'live',
        engine_armed: engineState.getArmed(),
        external_checks_skipped: true,
        owner: 'execution-service'
      },
      passed: false,
      rejectReason: 'LIVE_RISK_OWNED_BY_EXECUTION_SERVICE'
    };
  }
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
    const spentBudget = executionMode === 'paper'
      ? Number(whitelist.paper_spent_budget || 0)
      : Number(whitelist.spent_budget || 0);
    const buyCount = executionMode === 'paper'
      ? Number(whitelist.paper_buy_count || 0)
      : Number(whitelist.current_buy_count || 0);
    riskCheck.wl_budget_ok = (spentBudget + amount) <= Number(whitelist.total_budget);
    if (!riskCheck.wl_budget_ok) setFailed('WL_BUDGET_EXCEEDED');

    // 3. 重复买入次数
    riskCheck.wl_repeat_ok = whitelist.allow_repeat_buy
      ? buyCount < Number(whitelist.max_repeat_buys || 1)
      : buyCount === 0;
    if (!riskCheck.wl_repeat_ok) setFailed('WL_REPEAT_LIMIT');

    // 4. 未过期
    riskCheck.wl_not_expired = !whitelist.expires_at || (new Date(whitelist.expires_at) > new Date());
    if (!riskCheck.wl_not_expired) setFailed('WL_EXPIRED');

    // 5. 单 CA 买入冷却时间 (默认 30 分钟)
    const cooldownMin = riskConfig.ca_cooldown_min || 30;
    const cooldownRes = await db.query(
      `SELECT COUNT(*) FROM positions 
       WHERE contract_address = $1 AND chain_id = $2 
         AND execution_mode = $3
         AND opened_at >= NOW() - CAST($4 || ' minutes' AS INTERVAL)`,
      [ca, chainId, executionMode, cooldownMin]
    );
    riskCheck.ca_cooldown_ok = parseInt(cooldownRes.rows[0].count, 10) === 0;
    if (!riskCheck.ca_cooldown_ok) setFailed('CA_BUY_COOLDOWN');

    // ═══════════════════════════════════
    // Layer 2 — 链级
    // ═══════════════════════════════════

    // 6. 链是否启用 (如果用户未配置 chain_configs，默认允许所有链)
    riskCheck.chain_enabled = chainConf.enabled !== false;
    if (!riskCheck.chain_enabled) setFailed('CHAIN_DISABLED');

    // 7. 日预算
    const dailyLimit = chainConf.dailyBudget || 0;
    const dailySpentRes = await db.query(
      `SELECT COALESCE(SUM(amount_in), 0) as spent FROM positions 
       WHERE chain_id = $1 AND execution_mode = $2
         AND opened_at >= NOW() - INTERVAL '1 day' AND status != 'failed'`,
      [chainId, executionMode]
    );
    const dailySpent = Number(dailySpentRes.rows[0].spent);
    riskCheck.chain_daily_budget_ok = dailyLimit === 0 || (dailySpent + amount <= dailyLimit);
    if (!riskCheck.chain_daily_budget_ok) setFailed('DAILY_BUDGET_EXCEEDED');

    // 8. 周预算
    const weeklyLimit = chainConf.weeklyBudget || 0;
    const weeklySpentRes = await db.query(
      `SELECT COALESCE(SUM(amount_in), 0) as spent FROM positions 
       WHERE chain_id = $1 AND execution_mode = $2
         AND opened_at >= NOW() - INTERVAL '7 days' AND status != 'failed'`,
      [chainId, executionMode]
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
      "SELECT COUNT(*) FROM positions WHERE chain_id = $1 AND execution_mode = $2 AND status = 'open'",
      [chainId, executionMode]
    );
    riskCheck.max_positions_ok = parseInt(activePositionsRes.rows[0].count, 10) < maxPositions;
    if (!riskCheck.max_positions_ok) setFailed('MAX_POSITIONS_REACHED');

    // 11. 日亏损熔断
    const dailyLossLimit = chainConf.dailyLossLimit || 0;
    const dailyRealizedRes = await db.query(
      `SELECT COALESCE(SUM(pnl), 0) as pnl FROM positions 
       WHERE chain_id = $1 AND execution_mode = $2 AND closed_at >= NOW() - INTERVAL '1 day'
         AND status IN ('tp_hit', 'sl_hit', 'manual_close')`,
      [chainId, executionMode]
    );
    const dailyLoss = Number(dailyRealizedRes.rows[0].pnl);
    // dailyLoss 为负代表亏损
    riskCheck.daily_loss_ok = dailyLossLimit === 0 || dailyLoss >= -dailyLossLimit;
    if (!riskCheck.daily_loss_ok) setFailed('DAILY_LOSS_BREAKER');

    // 12. 连续亏损熔断
    const consecutiveLossLimit = riskConfig.consecutive_loss_limit || 5;
    const lastPositionsRes = await db.query(
      `SELECT status, pnl FROM positions 
       WHERE chain_id = $1 AND execution_mode = $2
         AND status IN ('tp_hit', 'sl_hit', 'manual_close', 'failed')
       ORDER BY closed_at DESC LIMIT $3`,
      [chainId, executionMode, consecutiveLossLimit]
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
    riskCheck.engine_armed = executionMode === 'paper' || engineState.getArmed();
    if (!riskCheck.engine_armed) setFailed('ENGINE_LOCKED');

    // 使用正式 GMGN /v1 合约和严格 Adapter 构造同一份只读风险输入。
    const [userRaw, securityRaw, tokenRaw, poolRaw] = await Promise.all([
      gmgnHttp.getUserInfo(),
      gmgnHttp.getTokenSecurity(chainId, ca),
      gmgnHttp.getTokenInfo(chainId, ca),
      gmgnHttp.getTokenPoolInfo(chainId, ca)
    ]);
    const wallet = gmgnAdapter.selectWallet(userRaw, chainId);
    const security = gmgnAdapter.normalizeSecurity(securityRaw, chainId);
    const tokenInfo = gmgnAdapter.normalizeTokenInfo(tokenRaw);
    const pool = gmgnAdapter.normalizePool(poolRaw);

    // 14. 蜜罐校验
    riskCheck.not_honeypot = security.isHoneypot === false
      || (chainId === 'sol' && security.isHoneypot === null);
    if (!riskCheck.not_honeypot) setFailed('HONEYPOT_DETECTED');

    // 15. 买入税率 (默认上限 5%)
    const maxBuyTax = riskConfig.max_buy_tax ?? 5;
    riskCheck.buy_tax_ok = true;
    riskCheck.buy_tax = security.buyTax;
    riskCheck.buy_tax_warning = chainId !== 'sol'
      && (security.buyTax === null || security.buyTax > maxBuyTax);

    // 16. 卖出税率 (默认上限 10%)
    const maxSellTax = riskConfig.max_sell_tax ?? 10;
    riskCheck.sell_tax_ok = true;
    riskCheck.sell_tax = security.sellTax;
    riskCheck.sell_tax_warning = chainId !== 'sol'
      && (security.sellTax === null || security.sellTax > maxSellTax);

    // 17. Rug 风险必须有明确数值，未知不能自动视为安全。
    const maxRugRatio = Number(riskConfig.max_rug_ratio ?? 0.3);
    const rugRatio = security.rugRatio ?? tokenInfo.rugRatio;
    riskCheck.rug_ratio = rugRatio;
    riskCheck.rug_ratio_ok = rugRatio !== null && rugRatio <= maxRugRatio;
    if (!riskCheck.rug_ratio_ok) {
      setFailed(rugRatio === null ? 'RUG_RATIO_UNKNOWN' : 'HIGH_RUG_RATIO');
    }

    riskCheck.mint_authority_ok = chainId !== 'sol' || security.renouncedMint === true;
    if (!riskCheck.mint_authority_ok) {
      setFailed(security.renouncedMint === null ? 'MINT_AUTHORITY_UNKNOWN_SOL' : 'MINT_AUTHORITY_ACTIVE');
    }
    riskCheck.freeze_authority_ok = chainId !== 'sol' || security.renouncedFreeze === true;
    if (!riskCheck.freeze_authority_ok) {
      setFailed(security.renouncedFreeze === null ? 'FREEZE_AUTHORITY_UNKNOWN_SOL' : 'FREEZE_AUTHORITY_ACTIVE');
    }

    // 18. 最小流动性深度 (默认 $10,000)
    const minLiquidity = riskConfig.min_liquidity_usd ?? 10000;
    const liquidityUsd = pool.liquidityUsd ?? tokenInfo.liquidityUsd;
    riskCheck.liquidity_ok = liquidityUsd !== null && liquidityUsd >= minLiquidity;
    if (!riskCheck.liquidity_ok) setFailed('LOW_LIQUIDITY');

    // ═══════════════════════════════════
    // Layer 4 — 执行级
    // ═══════════════════════════════════

    // 19. CA 连续执行失败锁定 (最近 2 小时失败不超过 3 次)
    const failureRes = await db.query(
      `SELECT COUNT(*) FROM positions 
       WHERE contract_address = $1 AND execution_mode = $2 AND status = 'failed'
         AND opened_at >= NOW() - INTERVAL '2 hours'`,
      [ca, executionMode]
    );
    riskCheck.ca_failure_ok = parseInt(failureRes.rows[0].count, 10) < 3;
    if (!riskCheck.ca_failure_ok) setFailed('CA_FAILURE_LOCKED');

    // 20. 滑点检查
    // 通过询价接口模拟报价
    const chainRegistry = CHAIN_REGISTRY[chainId] || {};
    const nativeToken = chainRegistry.nativeToken || '';
    const maxSlippage = riskConfig.max_slippage_pct ?? 15;
    
    const inputAmountRaw = decimalToRaw(amount, chainRegistry.decimals);
    const quote = gmgnAdapter.normalizeQuote(await gmgnHttp.quoteOrder(
      chainId,
      wallet.address,
      nativeToken,
      ca,
      inputAmountRaw,
      maxSlippage
    ));
    const taxAdjustedImpact = quote.priceImpactPct === null
      ? null
      : Math.max(0, quote.priceImpactPct - Number(security.buyTax || 0));
    riskCheck.price_impact_gross_pct = quote.priceImpactPct;
    riskCheck.price_impact_excluding_buy_tax_pct = taxAdjustedImpact;
    riskCheck.slippage_ok = taxAdjustedImpact !== null && taxAdjustedImpact <= maxSlippage;
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
