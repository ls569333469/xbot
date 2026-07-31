const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const gmgnHttp = require('../lib/gmgn-http');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('exist auth uses official headers and Unix-second auth query', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return jsonResponse({ code: 0, data: { symbol: 'TEST' } });
  };

  try {
    const result = await withEnv({ GMGN_API_KEY: 'gmgn-test-key' }, () => (
      gmgnHttp.getTokenInfo('sol', 'TokenAddress')
    ));

    assert.equal(result.symbol, 'TEST');
    const url = new URL(captured.url);
    assert.equal(url.pathname, '/v1/token/info');
    assert.equal(url.searchParams.get('chain'), 'sol');
    assert.equal(url.searchParams.get('address'), 'TokenAddress');
    assert.match(url.searchParams.get('client_id'), /^[0-9a-f-]{36}$/i);
    assert.ok(Math.abs(Number(url.searchParams.get('timestamp')) - Math.floor(Date.now() / 1000)) <= 1);
    assert.equal(captured.options.headers['X-APIKEY'], 'gmgn-test-key');
    assert.equal(captured.options.headers.Authorization, undefined);
    assert.equal(captured.options.headers['x-route-key'], undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('signed auth signs the exact official path, sorted query, body, and timestamp', async () => {
  const originalFetch = global.fetch;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return jsonResponse({ code: 0, data: { order_id: 'order-1' } });
  };

  const params = {
    chain: 'sol',
    from_address: 'WalletAddress',
    input_token: 'So11111111111111111111111111111111111111112',
    output_token: 'TokenAddress',
    input_amount: '100000000',
    slippage: 10
  };

  try {
    const result = await withEnv({
      GMGN_API_KEY: 'gmgn-test-key',
      GMGN_PRIVATE_KEY: privateKeyPem
    }, () => gmgnHttp.swap(params));

    assert.equal(result.order_id, 'order-1');
    const url = new URL(captured.url);
    const query = Object.fromEntries(url.searchParams.entries());
    const message = gmgnHttp.buildSignatureMessage(
      '/v1/trade/swap',
      query,
      captured.options.body,
      Number(query.timestamp)
    );
    assert.equal(
      crypto.verify(
        null,
        Buffer.from(message, 'utf8'),
        publicKey,
        Buffer.from(captured.options.headers['X-Signature'], 'base64')
      ),
      true
    );
    assert.deepEqual(JSON.parse(captured.options.body), params);
  } finally {
    global.fetch = originalFetch;
  }
});

test('API business errors expose sanitized machine-readable fields', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({
    code: 40001,
    error: 'INVALID_ARGUMENT',
    message: 'bad token'
  }, 400);

  try {
    await assert.rejects(
      withEnv({ GMGN_API_KEY: 'gmgn-test-key' }, () => gmgnHttp.getTokenSecurity('sol', 'bad')),
      (error) => {
        assert.equal(error.name, 'GmgnOpenApiError');
        assert.equal(error.code, 'INVALID_ARGUMENT');
        assert.equal(error.status, 400);
        assert.equal(error.path, '/v1/token/security');
        assert.doesNotMatch(error.message, /gmgn-test-key/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('legacy local-wallet swap calls fail closed', () => {
  assert.throws(
    () => gmgnHttp.getSwapRoute(),
    (error) => error.code === 'GMGN_LEGACY_FLOW_REMOVED'
  );
  assert.throws(
    () => gmgnHttp.submitSwap(),
    (error) => error.code === 'GMGN_LEGACY_FLOW_REMOVED'
  );
});

test('P20 market methods use the official read-only routes and payload shapes', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  gmgnHttp.scheduler.resetForTests();
  global.fetch = async (url, options) => {
    calls.push({ url: new URL(String(url)), options });
    return jsonResponse({ code: 0, data: {} });
  };
  try {
    await withEnv({ GMGN_API_KEY: 'gmgn-test-key' }, async () => {
      await gmgnHttp.getMarketRank('bsc', '24h', { limit: 100 });
      await gmgnHttp.getMarketHotSearches([{ chain: 'bsc', interval: '24h', limit: 100 }]);
      await gmgnHttp.getMarketTrenches('bsc', { version: 'v2', new_creation: { limit: 80 } });
      await gmgnHttp.getTokenTopHolders('bsc', '0xabc', { tag: 'renowned' });
    });
    assert.deepEqual(calls.map((call) => [call.options.method, call.url.pathname]), [
      ['GET', '/v1/market/rank'],
      ['POST', '/v1/market/hot_searches'],
      ['POST', '/v1/trenches'],
      ['GET', '/v1/market/token_top_holders']
    ]);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      params: [{ chain: 'bsc', interval: '24h', limit: 100 }]
    });
    assert.equal(calls.every((call) => call.options.headers['X-Signature'] === undefined), true);
  } finally {
    global.fetch = originalFetch;
    gmgnHttp.scheduler.resetForTests();
  }
});
