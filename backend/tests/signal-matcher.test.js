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
    activity_type: 'quote',
    tweet_id: '12345',
    semantic_key: 'tweet:wanshenme:12345',
    target_x_handles: ['project_one', 'project_two']
  };
  const whitelists = [
    { id: 1, chain_id: 'sol', contract_address: 'SameCA', project_x_handles: ['project_one'], relations: [{ id: 10, target_x_handle: 'project_one', event_types: ['quote'] }] },
    { id: 2, chain_id: 'sol', contract_address: 'SameCA', project_x_handles: ['project_two'], relations: [{ id: 11, target_x_handle: 'project_two', event_types: ['quote'] }] }
  ];
  const groups = groupActivityMatches(activity, whitelists);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].matchedWhitelistIds], [1, 2]);
  assert.deepEqual([...groups[0].matchedProjectHandles], ['project_one', 'project_two']);
});

test('matches ecosystem-source posts only when the complete CA is present', () => {
  const sourceWhitelist = {
    id: 3,
    chain_id: 'sol',
    contract_address: 'SameCA',
    symbol: 'ANSEM',
    project_x_handles: ['project_one'],
    relations: [],
    direct_sources: [{
      id: 31,
      actor_handle: 'project_one',
      event_types: ['tweet'],
      match_mode: 'ca_only',
      source_kind: 'ecosystem'
    }]
  };
  assert.equal(groupActivityMatches({
    id: 12,
    kol_id: 9,
    kol_handle: 'project_one',
    activity_type: 'tweet',
    tweet_id: 'direct-symbol-only',
    tweet_text: 'Token ANSEM is live'
  }, [sourceWhitelist]).length, 0);
  const groups = groupActivityMatches({
    id: 12,
    kol_id: 9,
    kol_handle: 'project_one',
    activity_type: 'tweet',
    tweet_id: 'direct-1',
    tweet_text: 'The contract is SameCA',
    extracted_cas: ['SameCA']
  }, [sourceWhitelist]);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].matchedRelationIds], []);
  assert.deepEqual([...groups[0].matchedSourceRuleIds], [31]);
  assert.equal(groups[0].matches[0].signal_type, 'ca_mention');
});

test('never matches project or launch audit sources on a fixed-CA whitelist', () => {
  const activity = {
    id: 13,
    kol_id: 9,
    kol_handle: 'project_one',
    activity_type: 'tweet',
    tweet_id: 'project-fixed-ca',
    extracted_cas: ['SameCA']
  };
  for (const sourceKind of ['project', 'launch']) {
    const groups = groupActivityMatches(activity, [{
      id: 4,
      chain_id: 'sol',
      contract_address: 'SameCA',
      project_x_handles: ['project_one'],
      relations: [],
      direct_sources: [{
        id: 32,
        actor_handle: 'project_one',
        event_types: ['tweet'],
        match_mode: 'ca_only',
        source_kind: sourceKind
      }]
    }]);
    assert.equal(groups.length, 0, `${sourceKind} must not be a fixed-CA trigger`);
  }
});

test('relation event permissions are applied independently', () => {
  const whitelist = {
    id: 1,
    chain_id: 'sol',
    contract_address: 'SameCA',
    project_x_handles: ['project_one'],
    relations: [{ id: 10, target_x_handle: 'project_one', event_types: ['reply'] }]
  };
  const baseActivity = {
    id: 11,
    kol_id: 7,
    kol_handle: 'wanshenme',
    tweet_id: '12345',
    target_x_handles: ['project_one']
  };
  assert.equal(groupActivityMatches({ ...baseActivity, activity_type: 'follow' }, [whitelist]).length, 0);
  const replyGroups = groupActivityMatches({ ...baseActivity, activity_type: 'reply' }, [whitelist]);
  assert.equal(replyGroups.length, 1);
  assert.deepEqual([...replyGroups[0].matchedRelationIds], [10]);
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
