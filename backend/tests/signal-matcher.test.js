const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyActivityMatch,
  canonicalSignalKey,
  findMatchingProjectHandle,
  groupActivityMatches,
  hasSymbolKeyword
} = require('../domains/signal/matcher');

const projectHandles = ['@BlackBullSol'];
const whitelist = {
  chain_id: 'sol',
  contract_address: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
  project_x_handles: projectHandles,
  symbol: 'ANSEM'
};

test('matches project handles case-insensitively', () => {
  assert.equal(
    findMatchingProjectHandle({ target_x_handles: ['somebody_else'] }, projectHandles),
    null
  );
  assert.equal(
    findMatchingProjectHandle({ target_x_handles: ['BLACKBULLSOL'] }, projectHandles),
    'blackbullsol'
  );
  assert.equal(
    findMatchingProjectHandle({ target_x_handle: '@BlackBullSol' }, projectHandles),
    'blackbullsol'
  );
});

test('groups multiple project relationships for the same CA into one match', () => {
  const activity = {
    id: 11,
    kol_id: 7,
    kol_handle: 'wanshenme',
    activity_type: 'tweet',
    tweet_id: '12345',
    semantic_key: 'tweet:wanshenme:12345',
    target_x_handles: ['project_one', 'project_two']
  };
  const whitelists = [
    { id: 1, chain_id: 'sol', contract_address: 'SameCA', project_x_handles: ['project_one'] },
    { id: 2, chain_id: 'sol', contract_address: 'SameCA', project_x_handles: ['project_two'] }
  ];
  const groups = groupActivityMatches(activity, whitelists);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].matchedWhitelistIds], [1, 2]);
  assert.deepEqual([...groups[0].matchedProjectHandles], ['project_one', 'project_two']);
});

test('canonical signal key is provider-independent for the same source behavior', () => {
  const whitelist = { chain_id: 'sol', contract_address: 'SameCA' };
  const left = {
    id: 1,
    kol_id: 7,
    kol_handle: 'wanshenme',
    activity_type: 'follow',
    target_x_handle: 'neet_sol',
    provider: 'twitterapi'
  };
  const right = { ...left, id: 2, provider: '6551' };
  assert.equal(canonicalSignalKey(left, whitelist), canonicalSignalKey(right, whitelist));
});

test('matches plain symbol keywords on token boundaries', () => {
  assert.equal(hasSymbolKeyword({ tweet_text: 'ANSEMX is not the token' }, 'ANSEM'), false);
  assert.equal(hasSymbolKeyword({ tweet_text: 'Watching ANSEM today' }, 'ANSEM'), true);
  assert.equal(hasSymbolKeyword({ tweet_text: 'watching ansem today' }, 'ANSEM'), true);
});

test('classifies handle, CA, and symbol matches in priority order', () => {
  assert.deepEqual(
    classifyActivityMatch({ target_x_handles: ['blackbullsol'] }, whitelist),
    { signal_type: 'handle_match', match_detail: 'blackbullsol' }
  );
  assert.deepEqual(
    classifyActivityMatch({ extracted_cas: [whitelist.contract_address] }, whitelist),
    { signal_type: 'ca_mention', match_detail: whitelist.contract_address }
  );
  assert.deepEqual(
    classifyActivityMatch({ tweet_text: 'ANSEM looks interesting' }, whitelist),
    { signal_type: 'ticker_mention', match_detail: 'ANSEM' }
  );
  assert.equal(
    classifyActivityMatch({ tweet_text: 'No matching project here' }, whitelist),
    null
  );
  assert.deepEqual(
    classifyActivityMatch({
      target_x_handles: ['blackbullsol'],
      extracted_cas: [whitelist.contract_address],
      tweet_text: 'ANSEM'
    }, whitelist),
    { signal_type: 'handle_match', match_detail: 'blackbullsol' }
  );
});
