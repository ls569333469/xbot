const { ProxyAgent } = require('undici');

let cachedProxyUrl = null;
let cachedDispatcher = null;

function resolveXaiProxyUrl(value = process.env.XAI_PROXY_URL) {
  const source = String(value || '').trim();
  if (!source) return null;
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    const error = new Error('XAI_PROXY_URL must be a valid HTTP(S) proxy URL');
    error.code = 'XAI_PROXY_URL_INVALID';
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname && parsed.pathname !== '/')) {
    const error = new Error('XAI_PROXY_URL must use HTTP or HTTPS without credentials, path, query, or fragment');
    error.code = 'XAI_PROXY_URL_INVALID';
    throw error;
  }
  return parsed.origin;
}

function getXaiDispatcher(proxyUrl = process.env.XAI_PROXY_URL) {
  const normalized = resolveXaiProxyUrl(proxyUrl);
  if (!normalized) return null;
  if (cachedDispatcher && cachedProxyUrl === normalized) return cachedDispatcher;
  const previous = cachedDispatcher;
  cachedProxyUrl = normalized;
  cachedDispatcher = new ProxyAgent(normalized);
  if (previous) void previous.close().catch(() => {});
  return cachedDispatcher;
}

function withXaiTransport(requestOptions, proxyUrl = process.env.XAI_PROXY_URL) {
  const dispatcher = getXaiDispatcher(proxyUrl);
  return dispatcher ? { ...requestOptions, dispatcher } : requestOptions;
}

module.exports = {
  getXaiDispatcher,
  resolveXaiProxyUrl,
  withXaiTransport
};
