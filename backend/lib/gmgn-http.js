const crypto = require('crypto');
const { EventEmitter } = require('events');
const {
  PRIORITIES,
  endpointWeight,
  parseResetAt,
  scheduler
} = require('./gmgn-rate-scheduler');

const BASE_URL = String(process.env.GMGN_API_HOST || 'https://openapi.gmgn.ai').replace(/\/$/, '');
const USER_AGENT = 'xbot/1.0.0';
const DEFAULT_TIMEOUT_MS = 10000;
const requestEvents = new EventEmitter();

class GmgnOpenApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GmgnOpenApiError';
    this.code = details.apiError || details.apiCode || 'GMGN_API_ERROR';
    this.status = details.status;
    this.apiCode = details.apiCode;
    this.apiError = details.apiError;
    this.apiMessage = details.apiMessage;
    this.path = details.path;
    this.method = details.method;
    this.resetAt = details.resetAt;
    this.responseMeta = details.responseMeta;
  }
}

function requireApiKey() {
  const apiKey = String(process.env.GMGN_API_KEY || '').trim();
  if (!apiKey) {
    const error = new Error('GMGN_API_KEY is required');
    error.code = 'GMGN_KEY_MISSING';
    throw error;
  }
  return apiKey;
}

function requirePrivateKey() {
  const privateKeyPem = String(process.env.GMGN_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!privateKeyPem) {
    const error = new Error('GMGN_PRIVATE_KEY is required for signed GMGN requests');
    error.code = 'GMGN_PRIVATE_KEY_MISSING';
    throw error;
  }
  return privateKeyPem;
}

function buildAuthQuery() {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    client_id: crypto.randomUUID()
  };
}

function queryEntries(query) {
  return Object.keys(query)
    .sort()
    .flatMap((key) => {
      const value = query[key];
      const values = Array.isArray(value) ? [...value].sort() : [value];
      return values.map((item) => [key, String(item)]);
    });
}

function buildQueryString(query) {
  return queryEntries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function buildSignatureMessage(path, query, body, timestamp) {
  return `${path}:${buildQueryString(query)}:${body}:${timestamp}`;
}

function signMessage(message, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const payload = Buffer.from(message, 'utf8');

  if (key.asymmetricKeyType === 'ed25519') {
    return crypto.sign(null, payload, key).toString('base64');
  }
  if (key.asymmetricKeyType === 'rsa') {
    return crypto.sign('sha256', payload, {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    }).toString('base64');
  }

  const error = new Error(`Unsupported GMGN signing key type: ${key.asymmetricKeyType}`);
  error.code = 'GMGN_PRIVATE_KEY_INVALID';
  throw error;
}

function buildUrl(path, query) {
  const queryString = buildQueryString(query);
  return `${BASE_URL}${path}${queryString ? `?${queryString}` : ''}`;
}

function formatApiError(method, path, status, envelope) {
  const parts = [`${method} ${path} failed: HTTP ${status}`];
  if (envelope.code !== undefined) parts.push(`code=${envelope.code}`);
  if (envelope.error) parts.push(`error=${envelope.error}`);
  if (envelope.message) parts.push(`message=${envelope.message}`);
  return parts.join(' ');
}

function getResponseMeta(response, method, path, weight, startedAt, authQuery) {
  const resetHeader = response.headers.get('X-RateLimit-Reset');
  const remainingHeader = response.headers.get('X-RateLimit-Remaining');
  return {
    method,
    path,
    weight,
    status: response.status,
    latencyMs: Date.now() - startedAt,
    remaining: remainingHeader === null ? null : Number(remainingHeader),
    resetAt: resetHeader ? parseResetAt(resetHeader) : null,
    authClientId: authQuery.client_id
  };
}

function emitRequestEvent(meta, errorCode = null) {
  requestEvents.emit('request', { ...meta, errorCode });
}

async function request(method, path, query = {}, body = null, options = {}) {
  const weight = Number(options.weight || endpointWeight(method, path));
  const apiKey = requireApiKey();
  const authQuery = buildAuthQuery();
  const fullQuery = { ...query, ...authQuery };
  const bodyString = body === null ? '' : JSON.stringify(body);
  const headers = {
    'X-APIKEY': apiKey,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT
  };

  if (options.signed) {
    const privateKeyPem = requirePrivateKey();
    const message = buildSignatureMessage(path, fullQuery, bodyString, authQuery.timestamp);
    headers['X-Signature'] = signMessage(message, privateKeyPem);
  }

  const rateLease = options.rateLease || await scheduler.acquire(weight, {
    priority: options.priority ?? PRIORITIES.CACHE_WARMUP,
    deadlineAt: options.deadlineAt,
    context: { method, path }
  });
  rateLease.consume(weight);

  let response;
  const startedAt = Date.now();
  try {
    response = await fetch(buildUrl(path, fullQuery), {
      method,
      headers,
      body: body === null ? undefined : bodyString,
      signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS)
    });
  } catch (cause) {
    const error = new Error(`${method} ${path} request failed: ${cause.message}`);
    error.code = cause.name === 'TimeoutError' ? 'GMGN_REQUEST_TIMEOUT' : 'GMGN_NETWORK_ERROR';
    error.cause = cause;
    error.path = path;
    error.method = method;
    emitRequestEvent({
      method,
      path,
      weight,
      status: null,
      latencyMs: Date.now() - startedAt,
      remaining: null,
      resetAt: null,
      authClientId: authQuery.client_id
    }, error.code);
    throw error;
  }

  const responseMeta = getResponseMeta(response, method, path, weight, startedAt, authQuery);

  let envelope;
  try {
    envelope = await response.json();
  } catch (cause) {
    emitRequestEvent(responseMeta, 'GMGN_NON_JSON_RESPONSE');
    throw new GmgnOpenApiError(`${method} ${path} failed: HTTP ${response.status} non-JSON response`, {
      status: response.status,
      path,
      method,
      responseMeta
    });
  }

  if (response.status === 429 || Number(envelope.code) === 429) {
    const resetAt = envelope.reset_at
      ? parseResetAt(envelope.reset_at)
      : responseMeta.resetAt;
    scheduler.observe429(resetAt);
    responseMeta.resetAt = resetAt || scheduler.getStatus().resetAt;
  }

  if (Number(envelope.code) !== 0) {
    emitRequestEvent(responseMeta, envelope.error || envelope.code);
    throw new GmgnOpenApiError(formatApiError(method, path, response.status, envelope), {
      status: response.status,
      apiCode: envelope.code,
      apiError: envelope.error,
      apiMessage: envelope.message,
      path,
      method,
      resetAt: responseMeta.resetAt,
      responseMeta
    });
  }

  emitRequestEvent(responseMeta);
  return options.returnMeta
    ? { data: envelope.data, meta: responseMeta }
    : envelope.data;
}

function getUserInfo(options = {}) {
  return request('GET', '/v1/user/info', {}, null, options);
}

function getTokenInfo(chain, address, options = {}) {
  return request('GET', '/v1/token/info', { chain, address }, null, options);
}

function getTokenSecurity(chain, address, options = {}) {
  return request('GET', '/v1/token/security', { chain, address }, null, options);
}

function getTokenPoolInfo(chain, address, options = {}) {
  return request('GET', '/v1/token/pool_info', { chain, address }, null, options);
}

function getWalletTokenBalance(chain, walletAddress, tokenAddress, options = {}) {
  return request('GET', '/v1/user/wallet_token_balance', {
    chain,
    wallet_address: walletAddress,
    token_address: tokenAddress
  }, null, options);
}

function getWalletActivity(chain, walletAddress, extra = {}, options = {}) {
  return request('GET', '/v1/user/wallet_activity', {
    chain,
    wallet_address: walletAddress,
    ...extra
  }, null, options);
}

function quoteOrder(chain, fromAddress, inputToken, outputToken, inputAmount, slippage, options = {}) {
  return request('GET', '/v1/trade/quote', {
    chain,
    from_address: fromAddress,
    input_token: inputToken,
    output_token: outputToken,
    input_amount: String(inputAmount),
    slippage: Number(slippage)
  }, null, options);
}

function swap(params, options = {}) {
  return request('POST', '/v1/trade/swap', {}, params, {
    ...options,
    signed: true,
    timeoutMs: 15000,
    priority: options.priority ?? PRIORITIES.NEW_TRADE
  });
}

function queryOrder(orderId, chain, options = {}) {
  return request('GET', '/v1/trade/query_order', {
    order_id: orderId,
    chain
  }, null, {
    ...options,
    signed: true,
    priority: options.priority ?? PRIORITIES.CRITICAL_RECONCILIATION
  });
}

function getGasPrice(chain) {
  return request('GET', '/v1/trade/gas_price', { chain });
}

function submitStrategyOrder(_chain, params, options = {}) {
  return request('POST', '/v1/trade/strategy/create', {}, params, {
    ...options,
    signed: true,
    timeoutMs: 15000,
    priority: options.priority ?? PRIORITIES.STRATEGY_ACTION
  });
}

function cancelStrategyOrder(_chain, params, options = {}) {
  return request('POST', '/v1/trade/strategy/cancel', {}, params, {
    ...options,
    signed: true,
    priority: options.priority ?? PRIORITIES.STRATEGY_ACTION
  });
}

function getStrategyOrders(chain, extra = {}, options = {}) {
  return request('GET', '/v1/trade/strategy/orders', {
    chain,
    ...extra
  }, null, { ...options, signed: true });
}

function listedStrategies(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.list)) return value.list;
  if (Array.isArray(value?.orders)) return value.orders;
  return value && typeof value === 'object' ? [value] : [];
}

async function queryStrategyOrder(chain, orderId, fromAddress, extra = {}, options = {}) {
  const filters = {
    ...(fromAddress ? { from_address: fromAddress } : {}),
    group_tag: 'STMix',
    ...(extra.baseToken ? { base_token: extra.baseToken } : {}),
    limit: 100
  };
  for (const type of ['open', 'history']) {
    const response = await getStrategyOrders(chain, { ...filters, type }, options);
    const found = listedStrategies(response)
      .find((item) => String(item?.order_id || '') === String(orderId));
    if (found) return { list: [found], source: type };
  }
  return { list: [], source: 'not_found' };
}

function removedLegacyFlow() {
  const error = new Error('Legacy local-wallet swap flow was removed; use GMGN swap() and queryOrder()');
  error.code = 'GMGN_LEGACY_FLOW_REMOVED';
  throw error;
}

module.exports = {
  GmgnOpenApiError,
  buildAuthQuery,
  buildQueryString,
  buildSignatureMessage,
  signMessage,
  request,
  requestEvents,
  scheduler,
  getUserInfo,
  getTokenInfo,
  getTokenSecurity,
  getTokenPoolInfo,
  getWalletTokenBalance,
  getWalletActivity,
  quoteOrder,
  swap,
  queryOrder,
  getGasPrice,
  submitStrategyOrder,
  cancelStrategyOrder,
  queryStrategyOrder,
  getStrategyOrders,
  getSwapRoute: removedLegacyFlow,
  submitSwap: removedLegacyFlow
};
