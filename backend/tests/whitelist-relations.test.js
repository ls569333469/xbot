const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRelationInputs } = require('../domains/whitelist/relations');

test('normalizes and deduplicates explicit actor-target relations', () => {
  assert.deepEqual(normalizeRelationInputs([
    { actor_handle: '@ElonMusk', target_x_handle: '@CZ_Binance' },
    { actor_handle: 'elonmusk', target_x_handle: 'cz_binance' },
    { actor_handle: 'heyibinance', target_x_handle: 'liming' }
  ]), [
    { actor_handle: 'elonmusk', target_x_handle: 'cz_binance' },
    { actor_handle: 'heyibinance', target_x_handle: 'liming' }
  ]);
});

test('rejects incomplete and self-referential relations', () => {
  assert.throws(
    () => normalizeRelationInputs([{ actor_handle: 'elonmusk', target_x_handle: '' }]),
    /Invalid target X handle/
  );
  assert.throws(
    () => normalizeRelationInputs([{ actor_handle: 'elonmusk', target_x_handle: 'elonmusk' }]),
    /must be different/
  );
});
