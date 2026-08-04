const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_CANDIDATE_INDEX_BYTES,
  CandidateIndex,
  normalizeCandidate
} = require('../domains/dynamic-signal/candidate-index');
const { familyKey } = require('../domains/dynamic-signal/candidate-repository');

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

test('candidate index uses the same punctuation-tolerant key for approved names', () => {
  const index = new CandidateIndex([{
    chain: 'bsc', address: RELAUNCH,
    name: '何必东奔西走 币安全部都有', symbol: '币有'
  }]);
  const result = index.lookupTerms([{
    type: 'approved_name', normalized: '何必东奔西走,币安全部都有。'
  }], { allowedChains: ['bsc'] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].contractAddress, RELAUNCH);
  assert.equal(result.coverage.complete, true);
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

test('candidate normalization drops oversized provider index fields but keeps a valid CA', () => {
  const oversized = 'X'.repeat(MAX_CANDIDATE_INDEX_BYTES + 1);
  const candidate = normalizeCandidate({
    chain: 'bsc', address: RELAUNCH,
    name: oversized, symbol: oversized, launchpad: oversized,
    assetFamilyKey: oversized, sourcePostIds: [oversized]
  });
  assert.equal(candidate.contractAddress, RELAUNCH);
  assert.equal(candidate.name, '');
  assert.equal(candidate.symbol, '');
  assert.equal(candidate.launchpad, '');
  assert.equal(candidate.assetFamilyKey, null);
  assert.deepEqual(candidate.sourcePostIds, []);

  const result = new CandidateIndex([candidate]).lookupTerms([
    { type: 'ca', normalized: RELAUNCH }
  ], { allowedChains: ['bsc'] });
  assert.equal(result.candidates.length, 1);
});

test('asset families merge variants only when provider evidence supplies an explicit family key', () => {
  const original = normalizeCandidate({
    chain: 'bsc', address: ORIGINAL, symbol: '币有', assetFamilyKey: 'biyou'
  });
  const relaunch = normalizeCandidate({
    chain: 'bsc', address: RELAUNCH, symbol: '币有', assetFamilyKey: 'biyou'
  });
  assert.equal(familyKey(original), 'biyou');
  assert.equal(familyKey(relaunch), 'biyou');

  const unrelatedOriginal = normalizeCandidate({ chain: 'bsc', address: ORIGINAL, symbol: 'SAME' });
  const unrelatedRelaunch = normalizeCandidate({ chain: 'bsc', address: RELAUNCH, symbol: 'SAME' });
  assert.notEqual(familyKey(unrelatedOriginal), familyKey(unrelatedRelaunch));
  assert.equal(familyKey(unrelatedOriginal), `variant:bsc:${ORIGINAL}`);
  assert.equal(familyKey(unrelatedRelaunch), `variant:bsc:${RELAUNCH}`);
});
