const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../lib/db');
const engineState = require('../lib/engine-state');
const readinessService = require('../domains/trade/readiness-service');
const livePolicy = require('../domains/signal/live-policy');
const service = require('../domains/system/arm-preparation-service');

function readiness() {
  return {
    readyToArm: true,
    blockers: [],
    advisories: [],
    chains: [{ chain: 'base', ready: true, blockers: [], native_balance: 1 }],
    relations: [{ actorHandle: 'vladtenev' }],
    configurationFingerprint: 'configuration-a',
    snapshotHash: 'snapshot-a',
    scope: {
      scope_type: 'combined', scope_id: null, policy_revision: null,
      chains: ['base'], whitelist_ids: [7], manifest_hash: 'manifest-a'
    },
    provider: { cooldown_until: null, affected: [], advisories: [] },
    checks: { probed: true }
  };
}

function policy() {
  return {
    providers: ['6551'],
    eventTypes: ['tweet'],
    verifiedEventTypes: ['tweet'],
    chains: ['base'],
    whitelistIds: [7],
    maxSignalAgeSeconds: 300
  };
}

test('arm prepare stores only a token hash and a compact policy-bound summary', async () => {
  const originalQuery = db.query;
  const originalPolicy = livePolicy.getPolicy;
  const calls = [];
  livePolicy.getPolicy = async () => policy();
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT whitelist.id')) {
      return { rows: [{ id: 7, activation_version: 3, relations: [], sources: [] }] };
    }
    if (sql.includes('FROM x_actor_dynamic_policies')) return { rows: [] };
    if (sql.includes('FROM follow_discovery_policies policy')) return { rows: [] };
    if (sql.includes('WITH triggers AS')) return { rows: [{ relations: 1, watches: 1 }] };
    if (sql.includes('INSERT INTO arm_preparations')) {
      return { rows: [{ id: 11, expires_at: new Date(Date.now() + 60_000), created_at: new Date() }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  try {
    const result = await service.prepare('operator-a', { readinessProvider: async () => readiness() });
    assert.equal(result.preparation_id, 11);
    assert.ok(result.arm_token.length >= 40);
    const insert = calls.find((call) => call.sql.includes('INSERT INTO arm_preparations'));
    assert.notEqual(insert.params[0], result.arm_token);
    assert.deepEqual(result.summary.counts, { chains: 1, whitelists: 1, watches: 1, relations: 1 });
    assert.deepEqual(insert.params[5], { 7: 3 });
    assert.equal(insert.params[13], false);
  } finally {
    db.query = originalQuery;
    livePolicy.getPolicy = originalPolicy;
  }
});

test('follow-discovery arm context fingerprints only its owned whitelists', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM follow_discovery_policies policy')) {
        return { rows: [{
          id: 2, kol_id: 8, revision: 4, context_hash: 'follow-context',
          mode: 'live', enabled: true, allowed_chain_ids: ['sol'],
          x_handle: '@xueqiu88', display_name: 'Xueqiu', kol_enabled: true,
          profile_status: 'verified', trade_template_id: 3, trade_template_version: 2,
          trade_template_name: 'P21 Test', watch_sync_status: 'succeeded'
        }] };
      }
      if (sql.includes('FROM ca_whitelist AS whitelist')) {
        assert.deepEqual(params, [[], [], [2]]);
        return { rows: [{
          id: 91, activation_version: 5, source: 'follow_discovery',
          live_activation_state: 'live_ready', actor_policy_id: null,
          follow_discovery_policy_id: 2, relations: [], sources: []
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const context = await service.currentPolicyContext(executor, {
    scope_type: 'follow_discovery', scope_id: 2
  });
  assert.deepEqual(context.activationVersions, { 91: 5 });
  assert.deepEqual(context.policy.whitelistIds, [91]);
  assert.equal(calls.some((call) => call.sql.includes('WITH acceptance_scope')), false);
});

test('arm confirm binds the one-time token to its operator', async () => {
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const originalPolicy = livePolicy.getPolicy;
  const originalArm = engineState.arm;
  const calls = [];
  const token = 'arm-token';
  let armCalls = 0;
  livePolicy.getPolicy = async () => policy();
  engineState.arm = async () => {
    armCalls += 1;
    return { armed: true, status: 'running' };
  };
  db.query = async (sql) => {
    if (sql.includes('SELECT whitelist.id')) {
      return { rows: [{ id: 7, activation_version: 3, relations: [], sources: [] }] };
    }
    if (sql.includes('FROM x_actor_dynamic_policies')) return { rows: [] };
    if (sql.includes('FROM follow_discovery_policies policy')) return { rows: [] };
    if (sql.includes('WITH triggers AS')) return { rows: [{ relations: 1, watches: 1 }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  db.pool.connect = async () => ({
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM x_actor_dynamic_policies')) return { rows: [] };
      if (sql.includes('FROM follow_discovery_policies policy')) return { rows: [] };
      if (sql.includes('WITH triggers AS')) return { rows: [{ relations: 1, watches: 1 }] };
      if (sql.includes('SELECT whitelist.id')) {
        return { rows: [{ id: 7, activation_version: 3, relations: [], sources: [] }] };
      }
      if (sql.includes('SELECT * FROM arm_preparations')) {
        return { rows: params[1] === 'operator-a' ? [{
          id: 11, token_hash: service.tokenHash(token), operator: 'operator-a',
          status: 'prepared', expires_at: new Date(Date.now() + 60_000)
        }] : [] };
      }
      throw new Error(`Unexpected transaction SQL: ${sql}`);
    },
    release() {}
  });
  try {
    await assert.rejects(
      service.confirm({ preparation_id: 11, arm_token: token }, 'operator-b'),
      error => error.code === 'ARM_PREPARATION_INVALID'
    );
    const selection = calls.find((item) => item.sql.includes('SELECT * FROM arm_preparations'));
    assert.match(selection.sql, /operator = \$2/);
    assert.deepEqual(selection.params, [11, 'operator-b']);
    assert.equal(armCalls, 0);
  } finally {
    db.query = originalQuery;
    db.pool.connect = originalConnect;
    livePolicy.getPolicy = originalPolicy;
    engineState.arm = originalArm;
  }
});

test('arm confirm consumes a current preparation once and starts without a second full probe', async () => {
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const originalPolicy = livePolicy.getPolicy;
  const originalArm = engineState.arm;
  const token = 'current-arm-token';
  const calls = [];
  let snapshotCalls = 0;
  livePolicy.getPolicy = async () => policy();
  const saved = readiness();
  engineState.arm = async ({ readiness: snapshot }) => ({ armed: snapshot.readyToArm, status: 'running' });
  db.query = async (sql) => {
    calls.push({ sql, params: [] });
    if (sql.includes('SELECT whitelist.id')) {
      return { rows: [{ id: 7, activation_version: 3, relations: [], sources: [] }] };
    }
    if (sql.includes('FROM x_actor_dynamic_policies')) return { rows: [] };
    if (sql.includes('FROM follow_discovery_policies policy')) return { rows: [] };
    if (sql.includes('WITH triggers AS')) return { rows: [{ relations: 1, watches: 1 }] };
    if (sql.includes("SET status = 'consumed'")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const context = await service.currentPolicyContext();
  saved.scope.manifest_hash = context.manifest.manifest_hash;
  db.pool.connect = async () => ({
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM x_actor_dynamic_policies')) return { rows: [] };
      if (sql.includes('FROM follow_discovery_policies policy')) return { rows: [] };
      if (sql.includes('WITH triggers AS')) return { rows: [{ relations: 1, watches: 1 }] };
      if (sql.includes('SELECT whitelist.id')) {
        return { rows: [{ id: 7, activation_version: 3, relations: [], sources: [] }] };
      }
      if (sql.includes('SELECT * FROM arm_preparations')) {
        return { rows: [{
          id: 12,
          token_hash: service.tokenHash(token),
          operator: 'operator-a',
          status: 'prepared',
          expires_at: new Date(Date.now() + 60_000),
          configuration_fingerprint: 'configuration-a',
          policy_fingerprint: context.fingerprint,
           activation_versions: { 7: 3 },
           snapshot_hash: saved.snapshotHash,
           scope_type: 'combined', scope_id: null, scope_chain_ids: ['base'], scope_revision: null,
          scope_manifest_hash: context.manifest.manifest_hash,
          readiness_snapshot: saved
        }] };
      }
      if (sql.includes("SET status = 'arming'")) return { rows: [] };
      throw new Error(`Unexpected transaction SQL: ${sql}`);
    },
    release() {}
  });
  try {
    const result = await service.confirm({ preparation_id: 12, arm_token: token }, 'operator-a');
    assert.equal(result.armed, true);
    assert.equal(snapshotCalls, 0);
    assert.equal(calls.filter((item) => item.sql.includes("SET status = 'arming'")).length, 1);
    assert.equal(calls.filter((item) => item.sql.includes("SET status = 'consumed'")).length, 1);
  } finally {
    db.query = originalQuery;
    db.pool.connect = originalConnect;
    livePolicy.getPolicy = originalPolicy;
    engineState.arm = originalArm;
  }
});

test('arm confirm records a terminal failure when the engine cannot start', async () => {
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const originalPolicy = livePolicy.getPolicy;
  const originalArm = engineState.arm;
  const token = 'failed-arm-token';
  const calls = [];
  livePolicy.getPolicy = async () => policy();
  engineState.arm = async () => {
    const error = new Error('runtime persistence failed');
    error.code = 'ENGINE_PERSIST_FAILED';
    throw error;
  };
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT whitelist.id')) {
      return { rows: [{ id: 7, activation_version: 3, relations: [], sources: [] }] };
    }
    if (sql.includes('FROM x_actor_dynamic_policies')) return { rows: [] };
    if (sql.includes('FROM follow_discovery_policies policy')) return { rows: [] };
    if (sql.includes('WITH triggers AS')) return { rows: [{ relations: 1, watches: 1 }] };
    if (sql.includes("SET status = 'failed'")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const context = await service.currentPolicyContext();
  const saved = readiness();
  saved.scope.manifest_hash = context.manifest.manifest_hash;
  db.pool.connect = async () => ({
    async query(sql) {
      calls.push({ sql, params: [] });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM x_actor_dynamic_policies')) return { rows: [] };
      if (sql.includes('FROM follow_discovery_policies policy')) return { rows: [] };
      if (sql.includes('WITH triggers AS')) return { rows: [{ relations: 1, watches: 1 }] };
      if (sql.includes('SELECT whitelist.id')) {
        return { rows: [{ id: 7, activation_version: 3, relations: [], sources: [] }] };
      }
      if (sql.includes('SELECT * FROM arm_preparations')) {
        return { rows: [{
          id: 13,
          token_hash: service.tokenHash(token),
          operator: 'operator-a',
          status: 'prepared',
          expires_at: new Date(Date.now() + 60_000),
          configuration_fingerprint: 'configuration-a',
           policy_fingerprint: context.fingerprint,
           activation_versions: { 7: 3 },
           snapshot_hash: saved.snapshotHash,
           scope_type: 'combined', scope_id: null, scope_chain_ids: ['base'], scope_revision: null,
          scope_manifest_hash: context.manifest.manifest_hash,
          readiness_snapshot: saved
        }] };
      }
      if (sql.includes("SET status = 'arming'")) return { rows: [] };
      throw new Error(`Unexpected transaction SQL: ${sql}`);
    },
    release() {}
  });
  try {
    await assert.rejects(
      service.confirm({ preparation_id: 13, arm_token: token }, 'operator-a'),
      error => error.code === 'ENGINE_PERSIST_FAILED'
    );
    const failed = calls.find((item) => item.sql.includes("SET status = 'failed'"));
    assert.ok(failed);
    assert.equal(failed.params[1], 'ENGINE_PERSIST_FAILED');
    assert.match(failed.params[2], /runtime persistence failed/);
  } finally {
    db.query = originalQuery;
    db.pool.connect = originalConnect;
    livePolicy.getPolicy = originalPolicy;
    engineState.arm = originalArm;
  }
});
