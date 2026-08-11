const assert = require('node:assert/strict');
const test = require('node:test');
const engineState = require('../lib/engine-state');
const livePolicy = require('../domains/signal/live-policy');
const {
  getRuntimePolicyDetail,
  getRuntimeSummary,
  positiveInteger
} = require('../domains/trade/runtime-policy-summary');

const policy = {
  providers: ['6551'], eventTypes: ['tweet'], verifiedEventTypes: ['tweet'],
  chains: ['base'], whitelistIds: [3, 4], maxSignalAgeSeconds: 300
};

test('compact runtime summary returns counts without loading whitelist relation rows', async () => {
  const originalPolicy = livePolicy.getPolicy;
  const originalStatus = engineState.getStatus;
  const originalMode = process.env.TRADING_MODE;
  const calls = [];
  livePolicy.getPolicy = async () => policy;
  engineState.getStatus = () => ({ armed: true, status: 'running', desiredRunning: true });
  process.env.TRADING_MODE = 'live';
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('WITH triggers AS')) return { rows: [{ relation_count: 18, watch_count: 6 }] };
      if (sql.includes('GROUP BY live_activation_state')) {
        return { rows: [{ live_activation_state: 'syncing', count: 2 }] };
      }
      if (sql.includes('FROM chain_live_readiness')) {
        assert.match(sql, /live_enabled AS production_approved/);
        return { rows: [{ chain: 'base', implemented: true, contract_tested: true, production_approved: true }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  try {
    const result = await getRuntimeSummary(executor);
    assert.deepEqual(result.counts, {
      chains: 1, whitelists: 2, watches: 6, relations: 18, syncing: 2, sync_failed: 0
    });
    assert.equal(result.engine.mode, 'live');
    assert.deepEqual(result.chains, [{ chain: 'base', name: 'Base', ready: true }]);
    assert.equal(calls.some((item) => item.sql.includes('jsonb_agg')), false);
  } finally {
    livePolicy.getPolicy = originalPolicy;
    engineState.getStatus = originalStatus;
    process.env.TRADING_MODE = originalMode;
  }
});

test('runtime policy detail is chain-filtered, searchable, paginated, and account-bounded', async () => {
  const originalPolicy = livePolicy.getPolicy;
  const calls = [];
  livePolicy.getPolicy = async () => policy;
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: 1 }] };
      return { rows: [{
        id: 3, chain_id: 'base', contract_address: '0x1', symbol: 'WOOD',
        relation_count: 12, source_count: 3, unique_actor_count: 8,
        actor_handles: ['a', 'b', 'c', 'd', 'e']
      }] };
    }
  };
  try {
    const result = await getRuntimePolicyDetail({
      page: '2', page_size: '20', chain: 'base', search: 'WOOD'
    }, executor);
    assert.equal(result.total, 1);
    assert.equal(result.page, 2);
    assert.equal(result.items[0].actor_handles.length, 5);
    assert.deepEqual(calls[0].params, [[3, 4], 'base', '%WOOD%']);
    assert.deepEqual(calls[1].params, [[3, 4], 'base', '%WOOD%', 20, 20]);
    assert.match(calls[1].sql, /actor\.enabled = true/);
    assert.match(calls[1].sql, /\)\[1:5\] AS actor_handles/);
  } finally {
    livePolicy.getPolicy = originalPolicy;
  }
});

test('runtime policy detail is bounded by the selected follow-discovery scope', async () => {
  let scopeWhitelistQuery = true;
  const executor = {
    async query(sql, params) {
      if (sql.includes('FROM follow_discovery_policies policy')) {
        return { rows: [{
          id: 2, kol_id: 8, revision: 4, context_hash: 'follow-context', mode: 'live', enabled: true,
          allowed_chain_ids: ['sol'], x_handle: '@xueqiu88', display_name: '雪球', kol_enabled: true,
          profile_status: 'verified', trade_template_id: 3, trade_template_version: 2,
          trade_template_name: 'P21 Test', watch_sync_status: 'succeeded'
        }] };
      }
      if (sql.startsWith('SELECT COUNT')) {
        assert.deepEqual(params, [[91]]);
        return { rows: [{ count: 1 }] };
      }
      if (scopeWhitelistQuery && sql.includes('FROM ca_whitelist AS whitelist') && sql.includes('whitelist.id')) {
        scopeWhitelistQuery = false;
        assert.deepEqual(params, [[-1], [-1], [2]]);
        return { rows: [{ id: 91 }] };
      }
      return { rows: [{
        id: 91, chain_id: 'sol', contract_address: 'So111', symbol: 'TEST',
        relation_count: 1, source_count: 0, unique_actor_count: 1, actor_handles: ['xueqiu88']
      }] };
    }
  };
  const result = await getRuntimePolicyDetail({ scope_type: 'follow_discovery', scope_id: '2' }, executor);
  assert.equal(result.scope?.scope_type, 'follow_discovery');
  assert.equal(result.scope?.scope_id, 2);
  assert.equal(result.items[0].id, 91);
});

test('runtime policy pagination remains bounded', () => {
  assert.equal(positiveInteger('0', 20, 100), 20);
  assert.equal(positiveInteger('999', 20, 100), 100);
});
