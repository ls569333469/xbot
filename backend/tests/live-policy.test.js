const assert = require('node:assert/strict');
const test = require('node:test');
const {
  evaluate,
  getVerifiedEventTypes,
  relationAllowsSignal,
  sourceRuleAllowsSignal,
  resolveActivePolicy,
  resolveActiveWhitelistIds
} = require('../domains/signal/live-policy');

function policyExecutor() {
  return {
    async query(sql) {
      if (sql.includes('FROM ca_whitelist AS whitelist')) {
        return { rows: [{ id: 8, chain_id: 'base', event_types: ['tweet'] }] };
      }
      if (sql.includes('FROM x_signal_relations AS relation')) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (sql.includes('FROM chain_live_readiness')) {
        return { rows: [{ chain: 'base', implemented: true, contract_tested: true }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

test('live event verification is a read-only 6551 capability contract', () => {
  assert.deepEqual(getVerifiedEventTypes(), ['tweet', 'retweet', 'quote', 'reply', 'follow']);
});

test('live policy is derived from active whitelist relations', async () => {
  const executor = {
    async query(sql, params) {
      assert.match(sql, /FROM x_signal_relations/);
      assert.match(sql, /FROM x_signal_source_rules/);
      assert.deepEqual(params, [['sol', 'bsc', 'base', 'eth', 'robinhood']]);
      return { rows: [
        { id: '2', chain_id: 'sol', event_types: ['tweet', 'reply'] },
        { id: '2', chain_id: 'sol', event_types: ['follow'] },
        { id: '5', chain_id: 'base', event_types: ['quote'] }
      ] };
    }
  };
  assert.deepEqual(await resolveActivePolicy(executor), {
    whitelistIds: [2, 5],
    chains: ['sol', 'base'],
    eventTypes: ['tweet', 'reply', 'follow', 'quote']
  });
});

test('live direct-source authorization requires the signal event on a matched source rule', async () => {
  const executor = {
    async query(sql, params) {
      assert.match(sql, /FROM x_signal_source_rules/);
      assert.deepEqual(params, [[22], 8, 'tweet']);
      return { rows: [{ '?column?': 1 }] };
    }
  };
  assert.equal(await sourceRuleAllowsSignal({
    matched_source_rule_ids: [22], whitelist_id: 8, activity_type: 'tweet'
  }, executor), true);
  assert.equal(await sourceRuleAllowsSignal({ matched_source_rule_ids: [] }, executor), false);
});

test('live relation authorization requires the signal event on a matched relation', async () => {
  const executor = {
    async query(sql, params) {
      assert.match(sql, /\$3 = ANY\(relation\.event_types\)/);
      assert.match(sql, /actor\.enabled = true/);
      assert.deepEqual(params, [[12], 8, 'reply']);
      return { rows: [{ '?column?': 1 }] };
    }
  };
  assert.equal(await relationAllowsSignal({
    matched_relation_ids: [12], whitelist_id: 8, activity_type: 'reply'
  }, executor), true);
  assert.equal(await relationAllowsSignal({ matched_relation_ids: [] }, executor), false);
});

test('live whitelist authorization follows active unexpired entries on allowed chains', async () => {
  const executor = {
    async query(sql, params) {
      assert.match(sql, /status = 'active'/);
      assert.match(sql, /live_activation_state = 'live_ready'/);
      assert.match(sql, /expires_at IS NULL OR expires_at > NOW\(\)/);
      assert.deepEqual(params, [['sol', 'base']]);
      return { rows: [{ id: '3' }, { id: 8 }] };
    }
  };

  assert.deepEqual(
    await resolveActiveWhitelistIds(['SOL', 'base', 'sol'], executor),
    [3, 8]
  );
  assert.deepEqual(await resolveActiveWhitelistIds([], executor), []);
});

test('6551 live policy fails closed when the upstream event time is missing', async () => {
  const originalProvider = process.env.X_DATA_PROVIDER;
  process.env.X_DATA_PROVIDER = '6551';
  try {
    const result = await evaluate({
      provider: '6551', activity_type: 'tweet', chain_id: 'base', whitelist_id: 8,
      source_created_at: null, signal_created_at: new Date().toISOString(),
      matched_relation_ids: [12], matched_source_rule_ids: []
    }, { executor: policyExecutor() });
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.includes('SOURCE_EVENT_TIME_MISSING'));
  } finally {
    process.env.X_DATA_PROVIDER = originalProvider;
  }
});

test('6551 replayed old posts expire by source time even when the local signal is new', async () => {
  const originalProvider = process.env.X_DATA_PROVIDER;
  const originalAge = process.env.SIGNAL_MAX_AGE_SECONDS;
  process.env.X_DATA_PROVIDER = '6551';
  process.env.SIGNAL_MAX_AGE_SECONDS = '60';
  try {
    const result = await evaluate({
      provider: '6551', activity_type: 'tweet', chain_id: 'base', whitelist_id: 8,
      source_created_at: new Date(Date.now() - 120_000).toISOString(),
      signal_created_at: new Date().toISOString(),
      matched_relation_ids: [12], matched_source_rule_ids: []
    }, { executor: policyExecutor() });
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.includes('SIGNAL_EXPIRED'));
  } finally {
    process.env.X_DATA_PROVIDER = originalProvider;
    process.env.SIGNAL_MAX_AGE_SECONDS = originalAge;
  }
});
