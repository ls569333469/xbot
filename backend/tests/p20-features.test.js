const assert = require('node:assert/strict');
const test = require('node:test');
const { assertP20ReadOnly, p20FeatureState } = require('../lib/p20-features');

test('P20 feature flags default to fully disabled', () => {
  assert.deepEqual(p20FeatureState({}), {
    P20_CANDIDATE_INDEX_ENABLED: false,
    P20_DYNAMIC_RESOLUTION_ENABLED: false,
    P20_RECORD_ENABLED: false,
    P20_PAPER_ENABLED: false,
    P20_LIVE_ENABLED: false
  });
});

test('P20.1 rejects record, paper, and live runtime stages', () => {
  assert.doesNotThrow(() => assertP20ReadOnly({ P20_DYNAMIC_RESOLUTION_ENABLED: 'true' }));
  assert.throws(
    () => assertP20ReadOnly({ P20_LIVE_ENABLED: 'true' }),
    (error) => error.code === 'P20_STAGE_NOT_IMPLEMENTED'
  );
});
