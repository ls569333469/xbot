const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getXaiDispatcher,
  resolveXaiProxyUrl,
  withXaiTransport
} = require('../domains/research/xai-transport');

test('xAI transport keeps direct requests unchanged when no proxy is configured', () => {
  const options = { method: 'POST' };
  assert.equal(resolveXaiProxyUrl(''), null);
  assert.equal(withXaiTransport(options, ''), options);
});

test('xAI transport accepts a credential-free HTTP(S) proxy', () => {
  assert.equal(resolveXaiProxyUrl('http://127.0.0.1:7897/'), 'http://127.0.0.1:7897');
  const dispatcher = getXaiDispatcher('http://127.0.0.1:7897');
  assert.ok(dispatcher);
  assert.equal(withXaiTransport({ method: 'POST' }, 'http://127.0.0.1:7897').dispatcher, dispatcher);
});

test('xAI transport rejects unsafe or unsupported proxy URLs', () => {
  assert.throws(() => resolveXaiProxyUrl('socks5://127.0.0.1:7897'), {
    code: 'XAI_PROXY_URL_INVALID'
  });
  assert.throws(() => resolveXaiProxyUrl('http://user:secret@127.0.0.1:7897'), {
    code: 'XAI_PROXY_URL_INVALID'
  });
  assert.throws(() => resolveXaiProxyUrl('http://127.0.0.1:7897/proxy'), {
    code: 'XAI_PROXY_URL_INVALID'
  });
});
