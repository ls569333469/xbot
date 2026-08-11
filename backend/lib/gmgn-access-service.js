const gmgnHttp = require('./gmgn-http');
const { scopeKey } = require('./gmgn-shared-rate-limit');

function context(options = {}, defaults = {}) {
  const input = options.requestContext || {};
  return {
    source: input.source || defaults.source || 'xbot',
    processRole: input.processRole || process.env.XBOT_PROCESS_ROLE || 'all',
    policyId: input.policyId ?? null,
    whitelistId: input.whitelistId ?? null,
    signalId: input.signalId ?? null,
    traceId: input.traceId || null,
    executionSessionId: input.executionSessionId ?? null,
    rateScope: input.rateScope || scopeKey(),
    stage: input.stage || defaults.stage || null,
    ...input
  };
}

function requestOptions(options = {}, defaults = {}) {
  return { ...options, requestContext: context(options, defaults) };
}

function accessFor(scenario, options = {}) {
  return {
    scenario,
    scheduler: gmgnHttp.scheduler,
    getTokenInfo: (chain, address, request = {}) => gmgnHttp.getTokenInfo(
      chain, address, requestOptions(request, { source: scenario, stage: 'token_info' })
    ),
    getTokenSecurity: (chain, address, request = {}) => gmgnHttp.getTokenSecurity(
      chain, address, requestOptions(request, { source: scenario, stage: 'security' })
    ),
    getTokenPoolInfo: (chain, address, request = {}) => gmgnHttp.getTokenPoolInfo(
      chain, address, requestOptions(request, { source: scenario, stage: 'pool' })
    ),
    getUserInfo: (request = {}) => gmgnHttp.getUserInfo(
      requestOptions(request, { source: scenario, stage: 'wallet' })
    ),
    getMarketRank: (chain, interval, extra = {}, request = {}) => gmgnHttp.getMarketRank(
      chain, interval, extra, requestOptions(request, { source: scenario, stage: 'market_rank' })
    ),
    getMarketHotSearches: (params, request = {}) => gmgnHttp.getMarketHotSearches(
      params, requestOptions(request, { source: scenario, stage: 'market_hot' })
    ),
    getMarketTrenches: (chain, body, request = {}) => gmgnHttp.getMarketTrenches(
      chain, body, requestOptions(request, { source: scenario, stage: 'market_trenches' })
    ),
    getTokenTopHolders: (chain, address, extra = {}, request = {}) => gmgnHttp.getTokenTopHolders(
      chain, address, extra, requestOptions(request, { source: scenario, stage: 'top_holders' })
    ),
    getTokenKline: (chain, address, resolution, from, to, request = {}) => gmgnHttp.getTokenKline(
      chain, address, resolution, from, to,
      requestOptions(request, { source: scenario, stage: 'token_kline' })
    ),
    getWalletTokenBalance: (chain, wallet, token, request = {}) => gmgnHttp.getWalletTokenBalance(
      chain, wallet, token, requestOptions(request, { source: scenario, stage: 'wallet_balance' })
    ),
    getWalletActivity: (chain, wallet, extra = {}, request = {}) => gmgnHttp.getWalletActivity(
      chain, wallet, extra, requestOptions(request, { source: scenario, stage: 'wallet_activity' })
    ),
    quoteOrder: (...args) => {
      const request = args.at(-1);
      const actual = request && typeof request === 'object' && !Array.isArray(request)
        ? args.slice(0, -1) : args;
      return gmgnHttp.quoteOrder(...actual, requestOptions(request || {}, { source: scenario, stage: 'quote' }));
    },
    swap: (params, request = {}) => gmgnHttp.swap(
      params, requestOptions(request, { source: scenario, stage: 'swap' })
    ),
    queryOrder: (orderId, chain, request = {}) => gmgnHttp.queryOrder(
      orderId, chain, requestOptions(request, { source: scenario, stage: 'order_query' })
    ),
    getGasPrice: (chain, request = {}) => gmgnHttp.getGasPrice(
      chain, requestOptions(request, { source: scenario, stage: 'gas' })
    ),
    submitStrategyOrder: (chain, params, request = {}) => gmgnHttp.submitStrategyOrder(
      chain, params, requestOptions(request, { source: scenario, stage: 'strategy_create' })
    ),
    cancelStrategyOrder: (chain, params, request = {}) => gmgnHttp.cancelStrategyOrder(
      chain, params, requestOptions(request, { source: scenario, stage: 'strategy_cancel' })
    ),
    getStrategyOrders: (chain, extra = {}, request = {}) => gmgnHttp.getStrategyOrders(
      chain, extra, requestOptions(request, { source: scenario, stage: 'strategy_orders' })
    ),
    queryStrategyOrder: (chain, orderId, wallet, extra = {}, request = {}) => gmgnHttp.queryStrategyOrder(
      chain, orderId, wallet, extra,
      requestOptions(request, { source: scenario, stage: 'strategy_query' })
    ),
    reserveTrade: (request = {}) => gmgnHttp.scheduler.reserveTrade({
      ...request,
      context: context(request, { source: scenario, stage: 'provider_lease' })
    }),
    reserveTradeEvidence: (request = {}) => gmgnHttp.scheduler.reserveTradeEvidence({
      ...request,
      context: context(request, { source: scenario, stage: 'evidence_lease' })
    }),
    ...options
  };
}

const access = accessFor('xbot');

module.exports = {
  access,
  accessFor,
  context,
  requestOptions,
  getTokenInfo: access.getTokenInfo,
  getTokenSecurity: access.getTokenSecurity,
  getTokenPoolInfo: access.getTokenPoolInfo,
  getUserInfo: access.getUserInfo,
  quoteOrder: access.quoteOrder,
  swap: access.swap,
  queryOrder: access.queryOrder
};
