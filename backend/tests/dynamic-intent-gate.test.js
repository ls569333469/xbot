const assert = require('node:assert/strict');
const test = require('node:test');
const { extractContent } = require('../domains/dynamic-signal/content-extractor');
const { classifyIntent } = require('../domains/dynamic-signal/intent-gate');

const CA = '0xd0bc8ab397851ecfa58009d03bbc1a41fc764444';

function classify(input) {
  return classifyIntent(extractContent(input));
}

test('intent gate permits explicit current buy language only as read-only resolution', () => {
  const result = classify({ text: 'Buying $PONS now' });
  assert.equal(result.intentClass, 'buy_direct');
  assert.equal(result.canProceedToResolution, true);
  assert.equal(result.canAuthorizeLive, false);
});

test('intent gate treats a tag without action as a neutral reference', () => {
  assert.equal(classify({ text: '$PONS' }).intentClass, 'neutral_reference');
});

test('intent gate hard-rejects security, warning, sell, and historical contexts', () => {
  assert.equal(classify({ text: `Account hacked, CA ${CA}` }).intentClass, 'security_incident');
  assert.equal(classify({ text: 'Avoid $PONS, possible scam' }).intentClass, 'negative_or_warning');
  assert.equal(classify({ text: 'I sold $PONS' }).intentClass, 'sell_or_exit');
  assert.equal(classify({ text: 'Yesterday I bought $PONS' }).intentClass, 'historical_review');
});

test('intent gate rejects comparisons and multi-asset calls', () => {
  assert.equal(classify({ text: '$A vs $B' }).intentClass, 'comparison_or_list');
  assert.equal(classify({ text: 'Buy $A and $B' }).intentClass, 'multi_asset_ambiguous');
});

test('intent gate does not inherit intent from quoted content', () => {
  const result = classify({
    eventType: 'quote',
    actorText: 'Interesting',
    quotedText: 'Buy $PONS'
  });
  assert.equal(result.intentClass, 'quoted_only');
});

test('intent gate treats one author-owned full CA as the strongest positive signal', () => {
  assert.equal(classify({ text: CA }).intentClass, 'full_ca_solo');
  assert.equal(classify({ text: `test\n\n${CA}` }).intentClass, 'full_ca_solo');
  assert.equal(classify({ text: `I am researching this CA ${CA}` }).intentClass, 'full_ca_solo');
  assert.equal(classify({ text: `Avoid ${CA}` }).intentClass, 'negative_or_warning');
});

test('intent gate applies the full CA priority consistently to replies and tweets', () => {
  assert.equal(classify({
    eventType: 'reply',
    actorText: `@TxxSw103 ${CA}`
  }).intentClass, 'full_ca_solo');
  assert.equal(classify({
    eventType: 'reply',
    actorText: `@TxxSw103 @another_user ${CA}`
  }).intentClass, 'full_ca_solo');
  assert.equal(classify({
    eventType: 'tweet',
    actorText: `@TxxSw103 ${CA}`
  }).intentClass, 'full_ca_solo');
  assert.equal(classify({
    eventType: 'reply',
    actorText: `@TxxSw103 avoid ${CA}`
  }).intentClass, 'negative_or_warning');
});
