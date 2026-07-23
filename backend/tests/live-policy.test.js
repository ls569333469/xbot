const assert = require('node:assert/strict');
const test = require('node:test');
const { parseVerifiedEventTypes } = require('../domains/signal/live-policy');

test('live event verification is an independent fail-closed allowlist', () => {
  assert.deepEqual(parseVerifiedEventTypes('Reply,tweet,reply,unknown'), ['reply', 'tweet']);
  assert.deepEqual(parseVerifiedEventTypes(''), []);
});
