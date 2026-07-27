const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeTemplateSnapshot } = require('../domains/whitelist/templates');

test('whitelist templates normalize event defaults and repeat-buy settings', () => {
  const snapshot = normalizeTemplateSnapshot({
    schema_version: 2,
    budget_per_trade: 0.005,
    total_budget: 0.05,
    slippage: 12,
    allow_repeat_buy: true,
    max_repeat_buys: 3,
    relation_event_types: ['reply', 'quote', 'reply'],
    direct_source_event_types: ['tweet', 'quote'],
    direct_source_rule_enabled: true,
    direct_source_actor_handles: ['@VladTenev'],
    relation_rule_enabled: false,
    relation_actor_handles: [],
    relation_target_policy: 'all_selected_project_identities',
    exit_strategy: {
      legs: [
        { type: 'take_profit', trigger_pct: 100, sell_pct: 50 },
        { type: 'stop_loss', drop_pct: 20, sell_pct: 100 }
      ]
    }
  });
  assert.deepEqual(snapshot.relation_event_types, ['quote', 'reply']);
  assert.deepEqual(snapshot.direct_source_event_types, ['tweet', 'quote']);
  assert.equal(snapshot.max_repeat_buys, 3);
  assert.equal(snapshot.schema_version, 2);
  assert.equal(snapshot.direct_source_rule_enabled, true);
  assert.equal(snapshot.relation_rule_enabled, false);
});

test('whitelist template V2 stores normalized actor rules without project targets', () => {
  const snapshot = normalizeTemplateSnapshot({
    schema_version: 2,
    budget_per_trade: 0.1,
    total_budget: 0.2,
    slippage: 10,
    allow_repeat_buy: false,
    max_repeat_buys: 4,
    direct_source_rule_enabled: true,
    direct_source_actor_handles: ['@VladTenev', 'vladtenev', 'yolorobinhood_'],
    relation_rule_enabled: true,
    relation_actor_handles: ['@THEUNIPCS', 'vladtenev'],
    relation_target_policy: 'all_selected_project_identities',
    relation_event_types: ['reply', 'quote'],
    direct_source_event_types: ['tweet', 'retweet'],
    exit_strategy: {
      legs: [{ type: 'take_profit', trigger_pct: 100, sell_pct: 50 }]
    }
  });

  assert.equal(snapshot.schema_version, 2);
  assert.equal(snapshot.max_repeat_buys, 1);
  assert.deepEqual(snapshot.direct_source_actor_handles, ['vladtenev', 'yolorobinhood_']);
  assert.deepEqual(snapshot.relation_actor_handles, ['theunipcs', 'vladtenev']);
  assert.equal(snapshot.relation_target_policy, 'all_selected_project_identities');
  assert.equal('project_accounts' in snapshot, false);
  assert.equal('relations' in snapshot, false);
});

test('whitelist templates reject malformed booleans, counts, and event types', () => {
  const base = {
    schema_version: 2,
    budget_per_trade: 0.005,
    total_budget: 0.05,
    direct_source_rule_enabled: true,
    direct_source_actor_handles: ['vladtenev'],
    relation_rule_enabled: false,
    relation_actor_handles: [],
    relation_target_policy: 'all_selected_project_identities',
    exit_strategy: {
      legs: [{ type: 'take_profit', trigger_pct: 100, sell_pct: 100 }]
    }
  };
  assert.throws(() => normalizeTemplateSnapshot({
    ...base, allow_repeat_buy: 'false'
  }), /must be a boolean/);
  assert.throws(() => normalizeTemplateSnapshot({
    ...base, max_repeat_buys: Number.POSITIVE_INFINITY
  }), /positive integer/);
  assert.throws(() => normalizeTemplateSnapshot({
    ...base, direct_source_event_types: ['follow']
  }), /Unsupported relation event type/);
  assert.throws(() => normalizeTemplateSnapshot({
    ...base,
    direct_source_rule_enabled: true,
    direct_source_actor_handles: []
  }), /requires at least one actor handle/);
  assert.throws(() => normalizeTemplateSnapshot({
    ...base,
    relation_rule_enabled: true,
    relation_actor_handles: ['not-valid-handle-too-long']
  }), /Invalid template X handle/);
  assert.throws(() => normalizeTemplateSnapshot({
    ...base,
    relation_rule_enabled: true,
    relation_actor_handles: ['vladtenev'],
    relation_target_policy: 'copy_old_targets'
  }), /Unsupported template relation target policy/);
  assert.throws(() => normalizeTemplateSnapshot({
    ...base,
    direct_source_rule_enabled: false,
    direct_source_actor_handles: [],
    relation_rule_enabled: false,
    relation_actor_handles: []
  }), /must enable at least one X trigger rule/);
});

test('whitelist templates reject missing or legacy schema versions', () => {
  const snapshot = {
    budget_per_trade: 0.005,
    total_budget: 0.05,
    direct_source_rule_enabled: true,
    direct_source_actor_handles: ['vladtenev'],
    exit_strategy: {
      legs: [{ type: 'take_profit', trigger_pct: 100, sell_pct: 50 }]
    }
  };
  assert.throws(() => normalizeTemplateSnapshot(snapshot), /schema_version must be 2/);
  assert.throws(() => normalizeTemplateSnapshot({
    ...snapshot, schema_version: 1
  }), /schema_version must be 2/);
});
