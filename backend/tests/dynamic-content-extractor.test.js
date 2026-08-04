const assert = require('node:assert/strict');
const test = require('node:test');
const { extractContent } = require('../domains/dynamic-signal/content-extractor');

const EVM_CA = '0xd0bc8ab397851ecfa58009d03bbc1a41fc764444';

test('content extractor keeps exact cashtag boundaries and normalizes casing', () => {
  const result = extractContent({ text: 'Buy $ANSEM, not $ANSEMX. #ansem is the same tag.' });
  const terms = result.authorOwnedTerms
    .filter((term) => ['cashtag', 'hashtag'].includes(term.type))
    .map((term) => [term.type, term.normalized]);
  assert.deepEqual(terms, [
    ['cashtag', 'ANSEM'],
    ['cashtag', 'ANSEMX'],
    ['hashtag', 'ANSEM']
  ]);
});

test('content extractor does not treat bare English words as asset terms', () => {
  const result = extractContent({ text: 'This index is lit and cash is useful.' });
  assert.equal(result.assetTerms.length, 0);
});

test('content extractor accepts only approved Chinese aliases without fuzzy segmentation', () => {
  const result = extractContent({
    text: '何必东奔西走今天上线，东奔西走不是另一个匹配。',
    approvedAliases: [{ value: '何必东奔西走', assetFamilyId: 12 }]
  });
  const names = result.authorOwnedTerms.filter((term) => term.type === 'approved_name');
  assert.equal(names.length, 1);
  assert.equal(names[0].assetFamilyId, 12);
});

test('approved Chinese aliases tolerate punctuation, spacing, and width differences', () => {
  const result = extractContent({
    text: '何必东奔西走.币安全部都有!',
    approvedAliases: [
      '何必东奔西走，币安全部都有。',
      '何必东奔西走 币安全部都有'
    ]
  });
  const names = result.authorOwnedTerms.filter((term) => term.type === 'approved_name');
  assert.equal(names.length, 1);
  assert.equal(names[0].value, '何必东奔西走.币安全部都有');
  assert.equal(names[0].start, 0);
  assert.equal(names[0].end, result.actorText.length - 1);
});

test('approved alias tolerance does not hide actual word changes or ASCII suffixes', () => {
  const changed = extractContent({
    text: '何必东奔西走，币安并非都有。',
    approvedAliases: ['何必东奔西走，币安全部都有。']
  });
  assert.equal(changed.authorOwnedTerms.some((term) => term.type === 'approved_name'), false);

  const suffix = extractContent({ text: '$ANSEMX', approvedAliases: ['ANSEM'] });
  assert.equal(suffix.authorOwnedTerms.some((term) => term.type === 'approved_name'), false);
});

test('content extractor preserves author and quoted ownership boundaries', () => {
  const result = extractContent({
    eventType: 'quote',
    actorText: 'Interesting context',
    quotedText: `Buy $PONS ${EVM_CA}`
  });
  assert.equal(result.authorOwnedTerms.length, 0);
  assert.ok(result.quotedTerms.some((term) => term.type === 'ca' && term.normalized === EVM_CA));
  assert.ok(result.quotedTerms.some((term) => term.type === 'cashtag' && term.normalized === 'PONS'));
});

test('content extractor marks a CA embedded in a URL as URL evidence', () => {
  const result = extractContent({ text: `https://gmgn.ai/bsc/token/${EVM_CA}` });
  const ca = result.authorOwnedTerms.find((term) => term.type === 'ca');
  assert.equal(ca.normalized, EVM_CA);
  assert.equal(ca.via, 'url');
});
