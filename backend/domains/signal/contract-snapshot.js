const crypto = require('crypto');
const {
  legacyPercentages,
  normalizeExitStrategy
} = require('../trade/exit-strategy-compiler');

const STRATEGY_TYPES = new Set(['fixed_ca', 'dynamic_policy', 'follow_discovery']);

function nullableText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function strategyType(value = {}) {
  if (STRATEGY_TYPES.has(value.strategy_type)) return value.strategy_type;
  if (value.follow_discovery_policy_id) return 'follow_discovery';
  if (value.actor_policy_id) return 'dynamic_policy';
  return 'fixed_ca';
}

function hashSnapshot(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashTradeConfigSnapshot(snapshot) {
  return crypto.createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

function assetSnapshot(value = {}, source = 'signal_creation') {
  const body = {
    snapshot_version: 'p27.asset.v1',
    source,
    chain_id: nullableText(value.chain_id || value.chainId),
    contract_address: nullableText(value.contract_address || value.contractAddress),
    symbol: nullableText(value.symbol),
    name: nullableText(value.project_name || value.name),
    logo_url: nullableText(value.logo_url || value.logoUrl),
    project_handles: [...new Set([
      ...(Array.isArray(value.project_x_handles) ? value.project_x_handles : []),
      ...(Array.isArray(value.project_handles) ? value.project_handles : []),
      value.project_handle
    ].map(nullableText).filter(Boolean))]
  };
  return { ...body, snapshot_hash: hashSnapshot(body) };
}

function authorizationSnapshot(value = {}, type = strategyType(value)) {
  const policyId = type === 'follow_discovery'
    ? value.follow_discovery_policy_id
    : type === 'dynamic_policy' ? value.actor_policy_id : value.whitelist_id;
  const revision = type === 'follow_discovery'
    ? value.follow_discovery_policy_revision
    : type === 'dynamic_policy' ? value.actor_policy_revision : null;
  const contextHash = type === 'follow_discovery'
    ? value.follow_discovery_context_hash
    : type === 'dynamic_policy' ? value.dynamic_policy_context_hash : null;
  const body = {
    snapshot_version: 'p27.authorization.v1',
    source: 'signal_creation',
    strategy_type: type,
    signal_policy_snapshot: {
      mode: ['live', 'paper'].includes(value.execution_mode) ? value.execution_mode : 'record',
      policy_id: policyId ?? null,
      revision: revision ?? null,
      context_hash: nullableText(contextHash)
    },
    ...(value.asset_route_snapshot ? { asset_route_snapshot: value.asset_route_snapshot } : {}),
    execution_decision: { status: 'not_attempted', blockers: [] }
  };
  return { ...body, snapshot_hash: hashSnapshot(body) };
}

function tradeConfigSnapshot(value = {}, source = 'signal_creation') {
  const budgetPerTrade = Number(value.budget_per_trade);
  const totalBudget = Number(value.total_budget);
  const slippage = Number(value.slippage);
  const allowRepeatBuy = value.allow_repeat_buy === true || value.allow_repeat_buy === 'true';
  const requestedMaxRepeatBuys = Number(value.max_repeat_buys || 1);
  let exitStrategy;
  try {
    exitStrategy = normalizeExitStrategy(value.exit_strategy, value);
  } catch {
    return {};
  }
  if (!Number.isFinite(budgetPerTrade) || budgetPerTrade <= 0
      || !Number.isFinite(totalBudget) || totalBudget < budgetPerTrade
      || !Number.isFinite(slippage) || slippage <= 0 || slippage > 100
      || !Number.isSafeInteger(requestedMaxRepeatBuys) || requestedMaxRepeatBuys < 1) {
    return {};
  }
  const legacy = legacyPercentages(exitStrategy);
  const maxRepeatBuys = allowRepeatBuy ? requestedMaxRepeatBuys : 1;
  const exitStrategyVersion = Number(value.exit_strategy_version || 1);
  const autoTpPct = Number(value.auto_tp_pct ?? legacy.auto_tp_pct);
  const autoSlPct = value.auto_sl_pct ?? legacy.auto_sl_pct;
  const normalizedAutoSlPct = autoSlPct === null ? null : Number(autoSlPct);
  if (!Number.isSafeInteger(exitStrategyVersion) || exitStrategyVersion < 1
      || !Number.isFinite(autoTpPct) || autoTpPct <= 0
      || (normalizedAutoSlPct !== null
        && (!Number.isFinite(normalizedAutoSlPct) || normalizedAutoSlPct <= 0))) {
    return {};
  }
  const body = {
    snapshot_version: 'p42.trade_config.v1',
    source,
    budget_per_trade: budgetPerTrade,
    total_budget: totalBudget,
    slippage,
    allow_repeat_buy: allowRepeatBuy,
    max_repeat_buys: maxRepeatBuys,
    exit_strategy: exitStrategy,
    exit_strategy_version: exitStrategyVersion,
    auto_tp_pct: autoTpPct,
    auto_sl_pct: normalizedAutoSlPct
  };
  return { ...body, snapshot_hash: hashTradeConfigSnapshot(body) };
}

function isTradeConfigSnapshot(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.snapshot_version !== 'p42.trade_config.v1'
      || typeof value.allow_repeat_buy !== 'boolean'
      || typeof value.budget_per_trade !== 'number'
      || !Number.isFinite(value.budget_per_trade)
      || value.budget_per_trade <= 0
      || typeof value.total_budget !== 'number'
      || !Number.isFinite(value.total_budget)
      || value.total_budget < value.budget_per_trade
      || typeof value.slippage !== 'number'
      || !Number.isFinite(value.slippage)
      || value.slippage <= 0 || value.slippage > 100
      || !Number.isSafeInteger(value.max_repeat_buys)
      || value.max_repeat_buys < 1
      || (!value.allow_repeat_buy && value.max_repeat_buys !== 1)
      || !Number.isSafeInteger(value.exit_strategy_version)
      || value.exit_strategy_version < 1
      || typeof value.auto_tp_pct !== 'number'
      || !Number.isFinite(value.auto_tp_pct)
      || value.auto_tp_pct <= 0
      || (value.auto_sl_pct !== null
        && (typeof value.auto_sl_pct !== 'number'
          || !Number.isFinite(value.auto_sl_pct) || value.auto_sl_pct <= 0))
      || !value.exit_strategy || typeof value.exit_strategy !== 'object'
      || Array.isArray(value.exit_strategy)
      || typeof value.snapshot_hash !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.snapshot_hash)) return false;
  try {
    const exitStrategy = normalizeExitStrategy(value.exit_strategy);
    const { snapshot_hash: storedHash } = value;
    const body = {
      snapshot_version: 'p42.trade_config.v1',
      source: value.source,
      budget_per_trade: value.budget_per_trade,
      total_budget: value.total_budget,
      slippage: value.slippage,
      allow_repeat_buy: value.allow_repeat_buy,
      max_repeat_buys: value.max_repeat_buys,
      exit_strategy: exitStrategy,
      exit_strategy_version: value.exit_strategy_version,
      auto_tp_pct: value.auto_tp_pct,
      auto_sl_pct: value.auto_sl_pct
    };
    // Accept both the stable hash and P42's original insertion-order hash so
    // existing production signals remain executable after the fix.
    return hashTradeConfigSnapshot(body) === storedHash || hashSnapshot(body) === storedHash;
  } catch {
    return false;
  }
}

module.exports = {
  assetSnapshot,
  authorizationSnapshot,
  hashSnapshot,
  hashTradeConfigSnapshot,
  isTradeConfigSnapshot,
  strategyType,
  tradeConfigSnapshot
};
