const assert = require('node:assert/strict');
const test = require('node:test');
const { CandidateIndex } = require('../domains/dynamic-signal/candidate-index');
const {
  buildAssetFamilies,
  normalizeVariantRelations
} = require('../domains/dynamic-signal/asset-family-service');

const ORIGINAL = '0xd0bc8ab397851ecfa58009d03bbc1a41fc764444';
const RELAUNCH = '0xe9337dde3dd9e97f1f45a56412767ce5098e7777';

test('candidate index deduplicates chain and CA while merging source evidence', () => {
  const index = new CandidateIndex([
    { chain: 'bsc', address: ORIGINAL, symbol: 'COIN', source: 'gmgn_rank' },
    { chain: 'bsc', address: ORIGINAL.toUpperCase(), symbol: 'COIN', source: 'gmgn_hot' }
  ]);
  const result = index.lookupTerms([{ type: 'cashtag', normalized: 'coin' }], { allowedChains: ['bsc'] });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].sources.sort(), ['gmgn_hot', 'gmgn_rank']);
});

test('candidate index uses exact symbol keys so ANSEM never matches ANSEMX', () => {
  const index = new CandidateIndex([
    { chain: 'eth', address: ORIGINAL, symbol: 'ANSEM' },
    { chain: 'eth', address: RELAUNCH, symbol: 'ANSEMX' }
  ]);
  const result = index.lookupTerms([{ type: 'cashtag', normalized: 'ANSEM' }], { allowedChains: ['eth'] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].symbol, 'ANSEM');
});

test('candidate index excludes expired provider snapshots', () => {
  const index = new CandidateIndex([{
    chain: 'bsc', address: ORIGINAL, symbol: 'OLD', expiresAt: '2026-01-01T00:00:00Z'
  }]);
  const result = index.lookupTerms([{ type: 'cashtag', normalized: 'OLD' }], {
    allowedChains: ['bsc'],
    now: Date.parse('2026-07-31T00:00:00Z')
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.coverage.complete, false);
});

test('asset families preserve original and relaunch variants only with an explicit family key', () => {
  const variants = [
    { chain: 'bsc', address: ORIGINAL, symbol: '币有', assetFamilyKey: 'biyou' },
    { chain: 'bsc', address: RELAUNCH, symbol: '币有', assetFamilyKey: 'biyou' }
  ];
  const families = buildAssetFamilies(variants);
  assert.equal(families.length, 1);
  assert.equal(families[0].variants.length, 2);
  const relations = normalizeVariantRelations([{
    from: variants[0], to: variants[1], type: 'relaunch', evidence: { platform: 'flap' }
  }], variants);
  assert.equal(relations.length, 1);
  assert.equal(relations[0].type, 'relaunch');
});
