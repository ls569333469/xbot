const test = require('node:test');
const assert = require('node:assert/strict');
const {
  create,
  normalizeRelations,
  normalizeSources,
  prepareInput,
  triggerHandles
} = require('../domains/launch-monitor/service');
const { validCandidates } = require('../domains/signal/launch-matcher');

test('normalizes and deduplicates pre-launch project sources', () => {
  assert.deepEqual(normalizeSources([
    { actor_handle: '@ProjectOne', role: 'official', event_types: ['tweet', 'quote'] },
    { handle: 'projectone', role: 'founder', event_types: ['reply'] }
  ]), [{
    actor_handle: 'projectone',
    role: 'founder',
    event_types: ['reply']
  }]);
});

test('requires ecosystem relations to target a configured project source', () => {
  assert.deepEqual(normalizeRelations([{
    actor_handle: '@Ecosystem',
    target_x_handle: '@ProjectOne',
    event_types: ['Reply', 'quote']
  }], new Set(['projectone'])), [{
    actor_handle: 'ecosystem',
    target_x_handle: 'projectone',
    event_types: ['quote', 'reply']
  }]);
  assert.throws(() => normalizeRelations([{
    actor_handle: 'ecosystem',
    target_x_handle: 'not_configured',
    event_types: ['reply']
  }], new Set(['projectone'])), /must be a project source/);
});

test('requires at least one project source before opening a launch monitor', async () => {
  await assert.rejects(create({
    chain_id: 'base',
    sources: [],
    relations: [],
    budget_per_trade: 0.001,
    total_budget: 0.01
  }), /At least one project source account/);
});

test('keeps the selected launch chain immutable after creation', async () => {
  assert.throws(() => prepareInput({ chain_id: 'eth' }, {
    chain_id: 'base',
    sources: [{ actor_handle: 'project', role: 'official', event_types: ['tweet'] }],
    relations: [],
    budget_per_trade: 0.001,
    total_budget: 0.01,
    slippage: 10,
    allow_repeat_buy: false,
    max_repeat_buys: 1,
    exit_strategy: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [{ type: 'take_profit', trigger_pct: 100, sell_pct: 100 }]
    },
    exit_strategy_version: 1
  }), { code: 'LAUNCH_RULE_CHAIN_IMMUTABLE' });
});

test('deduplicates Watch handles shared by project and ecosystem rules', () => {
  assert.deepEqual(triggerHandles([
    { actor_handle: 'project' },
    { actor_handle: 'shared' }
  ], [
    { actor_handle: 'shared', target_x_handle: 'project' },
    { actor_handle: 'ecosystem', target_x_handle: 'project' }
  ]), ['ecosystem', 'project', 'shared']);
});

test('accepts only addresses valid for the configured launch chain', () => {
  const evm = '0x1111111111111111111111111111111111111111';
  assert.deepEqual(validCandidates({ extracted_cas: [evm, evm.toUpperCase()] }, 'base'), [evm]);
  assert.deepEqual(validCandidates({ extracted_cas: ['not-an-address'] }, 'base'), []);
});
