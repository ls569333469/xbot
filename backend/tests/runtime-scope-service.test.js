const assert = require('node:assert/strict');
const test = require('node:test');
const livePolicy = require('../domains/signal/live-policy');
const { normalizeInput, makeManifest, resolveScope } = require('../domains/trade/runtime-scope-service');
const { scopeFilter } = require('../domains/trade/live-execution-queue');
const engineState = require('../lib/engine-state');

test('runtime scope input is normalized and rejects unknown types', () => {
  assert.deepEqual(normalizeInput({
    scope_type: 'follow_discovery', scope_id: '2', chain_ids: ['SOL', 'unknown', 'sol']
  }), {
    scopeType: 'follow_discovery', scopeId: 2, chainIds: ['sol']
  });
  assert.throws(() => normalizeInput({ scope_type: 'not-a-scope' }), { code: 'RUNTIME_SCOPE_INVALID' });
});

test('scope manifest fingerprints revision, chains, and policy identity', () => {
  const first = makeManifest({ scopeType: 'follow_discovery', scopeId: 2 }, {
    chains: ['sol'], policyRevision: 1, contextHash: 'a'
  });
  const second = makeManifest({ scopeType: 'follow_discovery', scopeId: 2 }, {
    chains: ['sol'], policyRevision: 2, contextHash: 'a'
  });
  assert.notEqual(first.manifest_hash, second.manifest_hash);
});

test('scope filter limits new buys without affecting combined mode', () => {
  assert.deepEqual(scopeFilter({ scope_type: 'follow_discovery', scope_id: 9 }, 'signal', 3), {
    sql: 'signal.follow_discovery_policy_id = $3', params: [9]
  });
  assert.deepEqual(scopeFilter({ scope_type: 'combined' }, 'signal', 3), { sql: 'TRUE', params: [] });
});

test('follow scope is resolved from one policy revision and its watch state', async () => {
  const executor = {
    async query(sql) {
      assert.match(sql, /follow_discovery_policies/);
      assert.match(sql, /ORDER BY updated_at DESC, desired_version DESC/i);
      assert.doesNotMatch(sql, /ORDER BY id/i);
      return { rows: [{
        id: 2, kol_id: 8, revision: 4, context_hash: 'follow-context', mode: 'live', enabled: true,
        allowed_chain_ids: ['sol'], x_handle: '@xueqiu88', display_name: '雪球', kol_enabled: true,
        profile_status: 'verified', trade_template_id: 3, trade_template_version: 2,
        trade_template_name: 'P21 Test', watch_sync_status: 'succeeded', watch_synced_at: '2026-08-08T00:00:00Z'
      }] };
    }
  };
  const manifest = await resolveScope({ scope_type: 'follow_discovery', scope_id: 2 }, executor);
  assert.equal(manifest.scope_type, 'follow_discovery');
  assert.equal(manifest.follow_policy_id, 2);
  assert.deepEqual(manifest.chains, ['sol']);
  assert.equal(manifest.watch_sync.status, 'succeeded');
});

test('combined scope includes fixed, dynamic, and follow-discovery chains', async () => {
  const executor = {
    async query(sql) {
      if (sql.includes('WITH acceptance_scope')) {
        return { rows: [{ id: 7, chain_id: 'base', event_types: ['tweet'] }] };
      }
      if (sql.includes('FROM x_actor_dynamic_policies policy')) {
        return { rows: [{ id: 20, allowed_chain_ids: ['bsc'], revision: 3, context_hash: 'dynamic-3' }] };
      }
      if (sql.includes('FROM follow_discovery_policies policy')) {
        return { rows: [{ id: 21, allowed_chain_ids: ['sol'], revision: 4, context_hash: 'follow-4' }] };
      }
      if (sql.includes('WITH triggers AS')) {
        return { rows: [{ relations: 1, watches: 1 }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const manifest = await resolveScope({ scope_type: 'combined' }, executor);
  assert.deepEqual(manifest.chains, ['base', 'bsc', 'sol']);
  assert.deepEqual(manifest.whitelist_ids, [7]);
  assert.deepEqual(manifest.dynamic_policy_ids, [20]);
  assert.deepEqual(manifest.follow_policy_ids, [21]);
});

test('fixed scope chain selection filters whitelist ids to the selected chain', async () => {
  const originalPolicy = livePolicy.getPolicy;
  livePolicy.getPolicy = async () => ({ chains: ['base', 'sol'], whitelistIds: [7, 8] });
  const executor = {
    async query(sql, params) {
      if (sql.includes('FROM ca_whitelist')) {
        assert.deepEqual(params, [[7, 8], ['sol']]);
        return { rows: [{ id: 8 }] };
      }
      if (sql.includes('WITH triggers AS')) return { rows: [{ relations: 0, watches: 0 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  try {
    const manifest = await resolveScope({ scope_type: 'fixed_ca', chain_ids: ['sol'] }, executor);
    assert.deepEqual(manifest.chains, ['sol']);
    assert.deepEqual(manifest.whitelist_ids, [8]);
  } finally {
    livePolicy.getPolicy = originalPolicy;
  }
});

test('engine scope rejects signals from another strategy family', () => {
  const scope = { scope_type: 'follow_discovery', scope_id: 2, chain_ids: ['sol'] };
  assert.equal(engineState.scopeAllowsSignal({ follow_discovery_policy_id: 2 }, scope), true);
  assert.equal(engineState.scopeAllowsSignal({ actor_policy_id: 2 }, scope), false);
});
