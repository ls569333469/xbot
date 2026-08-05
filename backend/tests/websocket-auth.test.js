const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const {
  AUTH_PROTOCOL,
  authorizeWebSocketRequest,
  getPresentedToken,
  selectWebSocketProtocol
} = require('../lib/websocket-auth');

function requestFor(token, protocols = [AUTH_PROTOCOL]) {
  const encoded = Buffer.from(token, 'utf8').toString('base64url');
  return {
    headers: {
      'sec-websocket-protocol': [...protocols, encoded].join(', ')
    }
  };
}

test('authorizes a WebSocket subprotocol token', () => {
  assert.equal(authorizeWebSocketRequest(requestFor('admin-secret'), 'admin-secret'), true);
});

test('supports Unicode administrator tokens', () => {
  const req = requestFor('管理员口令');
  assert.equal(getPresentedToken(req), '管理员口令');
  assert.equal(authorizeWebSocketRequest(req, '管理员口令'), true);
});

test('rejects missing, malformed, and incorrect WebSocket credentials', () => {
  assert.equal(authorizeWebSocketRequest({ headers: {} }, 'admin-secret'), false);
  assert.equal(authorizeWebSocketRequest({ headers: { 'sec-websocket-protocol': AUTH_PROTOCOL } }, 'admin-secret'), false);
  assert.equal(authorizeWebSocketRequest(requestFor('wrong-secret'), 'admin-secret'), false);
  assert.equal(authorizeWebSocketRequest(requestFor('admin-secret', ['other']), 'admin-secret'), false);
});

test('selects only the public authentication protocol name', () => {
  const encoded = Buffer.from('admin-secret').toString('base64url');
  assert.equal(selectWebSocketProtocol(new Set([AUTH_PROTOCOL, encoded])), AUTH_PROTOCOL);
  assert.equal(selectWebSocketProtocol(new Set([encoded])), false);
});

test('completes a real WebSocket handshake without exposing the token as the selected protocol', async (t) => {
  const expectedToken = '管理员口令';
  const server = http.createServer();
  const wss = new WebSocket.Server({
    server,
    path: '/ws',
    handleProtocols: selectWebSocketProtocol,
    verifyClient: ({ req }, done) => {
      const authorized = authorizeWebSocketRequest(req, expectedToken);
      done(authorized, authorized ? undefined : 401, authorized ? undefined : 'Unauthorized');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  const encoded = Buffer.from(expectedToken, 'utf8').toString('base64url');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, [AUTH_PROTOCOL, encoded]);
  t.after(() => new Promise((resolve) => {
    client.terminate();
    wss.close(() => server.close(resolve));
  }));

  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  assert.equal(client.protocol, AUTH_PROTOCOL);
});
