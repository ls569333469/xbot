const assert = require('node:assert/strict');
const test = require('node:test');
const { mergeEnvContent } = require('../domains/system/env-settings');

test('environment updates preserve comments, unknown keys, order, and line endings', () => {
  const original = [
    '# operator note',
    'UNKNOWN_FUTURE_KEY=keep-me',
    'X_DATA_PROVIDER=twitterapi',
    '',
    '# credentials',
    'OPENNEWS_TOKEN=old'
  ].join('\r\n') + '\r\n';
  const updated = mergeEnvContent(original, {
    X_DATA_PROVIDER: '6551',
    OPENNEWS_TOKEN: 'new',
    SIGNAL_MAX_AGE_SECONDS: '30'
  });

  assert.match(updated, /# operator note\r\nUNKNOWN_FUTURE_KEY=keep-me/);
  assert.match(updated, /X_DATA_PROVIDER=6551/);
  assert.match(updated, /# credentials\r\nOPENNEWS_TOKEN=new/);
  assert.match(updated, /SIGNAL_MAX_AGE_SECONDS=30\r\n$/);
  assert.equal(updated.includes('\n') && !updated.includes('\r\n'), false);
});

test('environment updates replace duplicate managed keys consistently', () => {
  const updated = mergeEnvContent('X_DATA_PROVIDER=mock\nX_DATA_PROVIDER=twitterapi\n', {
    X_DATA_PROVIDER: '6551'
  });
  assert.equal(updated.match(/X_DATA_PROVIDER=6551/g)?.length, 2);
  assert.equal(updated.includes('twitterapi'), false);
});
