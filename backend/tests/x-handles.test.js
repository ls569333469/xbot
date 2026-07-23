const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeXHandles } = require('../lib/x-handles');

test('normalizes handles separated by English and Chinese punctuation', () => {
  assert.deepEqual(
    normalizeXHandles('@CupseyToken， CupseyOfficial;@CUPSEYTOKEN'),
    ['cupseytoken', 'cupseyofficial']
  );
});

test('normalizes arrays and splits pasted handle groups', () => {
  assert.deepEqual(
    normalizeXHandles(['@alpha', 'beta, gamma', '', null]),
    ['alpha', 'beta', 'gamma']
  );
});
