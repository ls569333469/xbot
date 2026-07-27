const assert = require('node:assert/strict');
const test = require('node:test');
const {
  legacyPaperEnabled,
  legacyShadowEnabled,
  legacyXProvidersEnabled
} = require('../lib/legacy-features');

test('legacy features are disabled unless explicitly enabled', () => {
  const env = {};
  assert.equal(legacyPaperEnabled(env), false);
  assert.equal(legacyShadowEnabled(env), false);
  assert.equal(legacyXProvidersEnabled(env), false);
  assert.equal(legacyPaperEnabled({ XBOT_LEGACY_PAPER_ENABLED: 'true' }), true);
  assert.equal(legacyShadowEnabled({ XBOT_LEGACY_SHADOW_ENABLED: 'TRUE' }), true);
  assert.equal(legacyXProvidersEnabled({ XBOT_LEGACY_X_PROVIDERS_ENABLED: 'true' }), true);
});
