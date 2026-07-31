const assert = require('node:assert/strict');
const test = require('node:test');
const { CandidateIndex } = require('../domains/dynamic-signal/candidate-index');
const { resolveDynamicSignal } = require('../domains/dynamic-signal/ca-resolver');
const { RESOLUTION_CODES } = require('../domains/dynamic-signal/resolution-policy');

const CA = '0x39dbed3a2bd333467115de45665cc57f813c4571';

function verified(candidate) {
  return Promise.resolve({
    ...candidate,
    providerAddress: candidate.contractAddress,
    providerStatus: 'verified',
    tradableStatus: 'tradable',
    liquidityUsd: 100000
  });
}

test('resolver stops before provider calls when Intent Gate rejects the post', async () => {
  let calls = 0;
  const result = await resolveDynamicSignal({ text: 'Avoid $PONS', allowedChains: ['robinhood'] }, {
    candidateIndex: new CandidateIndex([{ chain: 'robinhood', address: CA, symbol: 'PONS' }]),
    verifyCandidate: async () => { calls += 1; }
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.failureCode, RESOLUTION_CODES.POLICY_BLOCKED);
  assert.equal(calls, 0);
  assert.equal(result.canTrade, false);
});

test('resolver verifies and resolves one exact symbol candidate without creating a trade', async () => {
  const result = await resolveDynamicSignal({ text: 'Buy $pons', allowedChains: ['robinhood'] }, {
    candidateIndex: new CandidateIndex([{ chain: 'robinhood', address: CA, symbol: 'PONS' }]),
    verifyCandidate: verified
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.selectedCandidate.contractAddress, CA);
  assert.equal(result.candidateCoverage.provider_verified_count, 1);
  assert.equal(result.canTrade, false);
});

test('resolver uses a direct EVM CA only when exactly one EVM chain is allowed', async () => {
  const exact = await resolveDynamicSignal({ text: CA, allowedChains: ['robinhood'] }, {
    candidateIndex: new CandidateIndex(),
    verifyCandidate: verified
  });
  assert.equal(exact.status, 'resolved');
  assert.equal(exact.selectedCandidate.chainId, 'robinhood');

  const ambiguousChain = await resolveDynamicSignal({ text: CA, allowedChains: ['bsc', 'robinhood'] }, {
    candidateIndex: new CandidateIndex(),
    verifyCandidate: verified
  });
  assert.equal(ambiguousChain.status, 'not_found');
  assert.equal(ambiguousChain.failureCode, RESOLUTION_CODES.NOT_FOUND);
});

test('resolver maps provider timeouts to a fail-closed timeout code', async () => {
  const result = await resolveDynamicSignal({ text: 'Buy $PONS', allowedChains: ['robinhood'] }, {
    candidateIndex: new CandidateIndex([{ chain: 'robinhood', address: CA, symbol: 'PONS' }]),
    verifyCandidate: async () => {
      const error = new Error('timeout');
      error.code = 'GMGN_REQUEST_TIMEOUT';
      throw error;
    }
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.failureCode, RESOLUTION_CODES.PROVIDER_TIMEOUT);
  assert.equal(result.selectedCandidate, null);
});
