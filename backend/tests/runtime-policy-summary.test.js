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

test('runtime policy pagination remains bounded', () => {
  assert.equal(positiveInteger('0', 20, 100), 20);
  assert.equal(positiveInteger('999', 20, 100), 100);
});
