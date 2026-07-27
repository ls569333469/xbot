const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRelationInputs,
  normalizeProjectAccounts,
  normalizeSourceInputs,
  retainRelevantProjectAccounts
} = require('../domains/whitelist/relations');
const {
  normalizeContractAddress,
  validateBudgetValues
} = require('../domains/whitelist/service');

test('normalizes Robinhood contract addresses as EVM addresses', () => {
  assert.equal(
    normalizeContractAddress('robinhood', '0xAbCdEf0000000000000000000000000000000000'),
    '0xabcdef0000000000000000000000000000000000'
  );
});

test('validates all whitelist-owned execution values together', () => {
  assert.deepEqual(validateBudgetValues({
    chain_id: 'base',
    budget_per_trade: 0.005,
    total_budget: 0.05,
    slippage: 15,
    allow_repeat_buy: true,
    max_repeat_buys: 3
  }), {
    chain_id: 'base',
    budget_per_trade: 0.005,
    total_budget: 0.05,
    slippage: 15,
    allow_repeat_buy: true,
    max_repeat_buys: 3
  });
  assert.throws(() => validateBudgetValues({
    chain_id: 'base', budget_per_trade: 0.005, total_budget: 0.05, slippage: 101
  }), /slippage/);
  assert.throws(() => validateBudgetValues({
    chain_id: 'base', budget_per_trade: 0.005, total_budget: 0.05,
    allow_repeat_buy: true, max_repeat_buys: 1.5
  }), /positive integer/);
});

test('normalizes and deduplicates explicit actor-target relations', () => {
  assert.deepEqual(normalizeRelationInputs([
    { actor_handle: '@ElonMusk', target_x_handle: '@CZ_Binance' },
    { actor_handle: 'elonmusk', target_x_handle: 'cz_binance' },
    { actor_handle: 'heyibinance', target_x_handle: 'liming' }
  ]), [
    {
      actor_handle: 'elonmusk',
      target_x_handle: 'cz_binance',
      event_types: ['retweet', 'quote', 'reply', 'follow']
    },
    {
      actor_handle: 'heyibinance',
      target_x_handle: 'liming',
      event_types: ['retweet', 'quote', 'reply', 'follow']
    }
  ]);
});

test('normalizes a 14 by 4 ecosystem relation matrix without multiplying watches', () => {
  const actors = Array.from({ length: 14 }, (_, index) => `robin_actor_${index + 1}`);
  const targets = ['wood_official', 'wood_founder', 'wood_engineer', 'wood_advisor'];
  const matrix = actors.flatMap((actor_handle) => targets.map((target_x_handle) => ({
    actor_handle,
    target_x_handle,
    event_types: ['retweet', 'quote', 'reply', 'follow']
  })));
  const normalized = normalizeRelationInputs([
    ...matrix,
    { actor_handle: '@ROBIN_ACTOR_1', target_x_handle: '@WOOD_OFFICIAL' }
  ]);

  assert.equal(normalized.length, 56);
  assert.equal(new Set(normalized.map((item) => item.actor_handle)).size, 14);
  assert.equal(new Set(normalized.map((item) => item.target_x_handle)).size, 4);
  assert.equal(new Set(normalized.map((item) => `${item.actor_handle}:${item.target_x_handle}`)).size, 56);
});

test('normalizes direct sources separately from interaction relations', () => {
  assert.deepEqual(normalizeSourceInputs([
    { actor_handle: '@Project', event_types: ['Tweet', 'quote'], match_mode: 'ca_only' },
    { handle: 'project', event_types: ['tweet'], match_mode: 'ca_only', source_kind: 'ecosystem' }
  ]), [{
    actor_handle: 'project',
    event_types: ['tweet'],
    match_mode: 'ca_only',
    source_kind: 'ecosystem',
    role: 'project'
  }]);
  assert.throws(() => normalizeSourceInputs([{
    handle: 'project', match_mode: 'any_post'
  }]), /Unsupported direct source match mode/);
  assert.throws(() => normalizeSourceInputs([{
    handle: 'project', event_types: ['follow']
  }]), /Unsupported relation event type/);
});

test('normalizes relation event types and rejects an empty event selection', () => {
  assert.deepEqual(normalizeRelationInputs([{
    actor_handle: 'elonmusk',
    target_x_handle: 'cz_binance',
    event_types: ['Reply', 'reply', 'follow']
  }])[0].event_types, ['reply', 'follow']);
  assert.throws(() => normalizeRelationInputs([{
    actor_handle: 'elonmusk', target_x_handle: 'cz_binance', event_types: []
  }]), /At least one relation event type/);
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

test('retains identities and only project accounts still used by current rules', () => {
  assert.deepEqual(retainRelevantProjectAccounts([
    { handle: 'project_old', usage: 'interaction_target' },
    { handle: 'project_new', usage: 'interaction_target' },
    { handle: 'official', usage: 'direct_source' },
    { handle: 'archived_source', usage: 'direct_source' },
    { handle: 'founder', usage: 'identity' }
  ], [
    { actor_handle: 'actor', target_x_handle: 'project_new' }
  ], [
    { actor_handle: 'official', source_kind: 'project' }
  ]), [
    { handle: 'project_new', usage: 'interaction_target' },
    { handle: 'official', usage: 'direct_source' },
    { handle: 'founder', usage: 'identity' }
  ]);
});

test('normalizes evidence accounts only while their trigger rule still exists', () => {
  const evidence = { source: 'gmgn+6551', evidence: [{ label: 'profile resolved' }] };
  assert.deepEqual(normalizeProjectAccounts([
    { handle: 'official', usage: 'direct_source', role: 'official_project', evidence_snapshot: evidence },
    { handle: 'old_project', usage: 'interaction_target', role: 'project' },
    { handle: 'founder', usage: 'identity', role: 'founder' }
  ], [
    { actor_handle: 'ecosystem', target_x_handle: 'project' }
  ], [
    { actor_handle: 'official', role: 'official_project', source_kind: 'project' },
    { actor_handle: 'ecosystem_source', role: 'ecosystem', source_kind: 'ecosystem' }
  ]), [
    { handle: 'official', role: 'official_project', usage: 'direct_source', evidence_snapshot: evidence },
    { handle: 'founder', role: 'founder', usage: 'identity', evidence_snapshot: {} },
    { handle: 'project', role: 'project', usage: 'interaction_target', evidence_snapshot: {} }
  ]);
});
