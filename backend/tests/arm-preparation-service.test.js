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
    snapshotHash: 'snapshot-a'
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
    if (sql.includes('INSERT INTO arm_preparations')) {
      return { rows: [{ id: 11, expires_at: new Date(Date.now() + 60_000), created_at: new Date() }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  try {
    const result = await service.prepare('operator-a', { readinessProvider: async () => readiness() });
    assert.equal(result.preparation_id, 11);
    assert.ok(result.arm_token.length >= 40);
    assert.notEqual(calls[1].params[0], result.arm_token);
    assert.deepEqual(result.summary.counts, { chains: 1, whitelists: 1, watches: 1, relations: 1 });
    assert.deepEqual(calls[1].params[5], { 7: 3 });
  } finally {
    db.query = originalQuery;
    livePolicy.getPolicy = originalPolicy;
  }
});

test('arm confirm binds the one-time token to its operator', async () => {
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const originalPolicy = livePolicy.getPolicy;
  const originalSnapshot = readinessService.getSnapshot;
  const originalArm = engineState.arm;
  const calls = [];
  const token = 'arm-token';
  let armCalls = 0;
  livePolicy.getPolicy = async () => policy();
  readinessService.getSnapshot = async () => readiness();
  engineState.arm = async () => {
    armCalls += 1;
    return { armed: true, status: 'running' };
  };
  db.query = async (sql) => {
    if (sql.includes('SELECT whitelist.id')) {
      return { rows: [{ id: 7, activation_version: 3, relations: [], sources: [] }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  db.pool.connect = async () => ({
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
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
    readinessService.getSnapshot = originalSnapshot;
    engineState.arm = originalArm;
  }
});

test('arm confirm consumes a current preparation once and starts without a second full probe', async () => {
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const originalPolicy = livePolicy.getPolicy;
  const originalSnapshot = readinessService.getSnapshot;
  const originalArm = engineState.arm;
  const token = 'current-arm-token';
  const calls = [];
  let snapshotCalls = 0;
  livePolicy.getPolicy = async () => policy();
  readinessService.getSnapshot = async () => {
    snapshotCalls += 1;
    return readiness();
  };
  engineState.arm = async ({ readiness: snapshot }) => ({ armed: snapshot.readyToArm, status: 'running' });
  db.query = async (sql) => {
    calls.push({ sql, params: [] });
    if (sql.includes('SELECT whitelist.id')) {
      return { rows: [{ id: 7, activation_version: 3, relations: [], sources: [] }] };
    }
    if (sql.includes("SET status = 'consumed'")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const context = await service.currentPolicyContext();
  db.pool.connect = async () => ({
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT * FROM arm_preparations')) {
        return { rows: [{
          id: 12,
          token_hash: service.tokenHash(token),
          operator: 'operator-a',
          status: 'prepared',
          expires_at: new Date(Date.now() + 60_000),
          configuration_fingerprint: 'configuration-a',
          policy_fingerprint: context.fingerprint,
          activation_versions: { 7: 3 }
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
    assert.equal(snapshotCalls, 1);
    assert.equal(calls.filter((item) => item.sql.includes("SET status = 'arming'")).length, 1);
    assert.equal(calls.filter((item) => item.sql.includes("SET status = 'consumed'")).length, 1);
  } finally {
    db.query = originalQuery;
    db.pool.connect = originalConnect;
    livePolicy.getPolicy = originalPolicy;
    readinessService.getSnapshot = originalSnapshot;
    engineState.arm = originalArm;
  }
});

test('arm confirm records a terminal failure when the engine cannot start', async () => {
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const originalPolicy = livePolicy.getPolicy;
  const originalSnapshot = readinessService.getSnapshot;
  const originalArm = engineState.arm;
  const token = 'failed-arm-token';
  const calls = [];
  livePolicy.getPolicy = async () => policy();
  readinessService.getSnapshot = async () => readiness();
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
    if (sql.includes("SET status = 'failed'")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const context = await service.currentPolicyContext();
  db.pool.connect = async () => ({
    async query(sql) {
      calls.push({ sql, params: [] });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT * FROM arm_preparations')) {
        return { rows: [{
          id: 13,
          token_hash: service.tokenHash(token),
          operator: 'operator-a',
          status: 'prepared',
          expires_at: new Date(Date.now() + 60_000),
          configuration_fingerprint: 'configuration-a',
          policy_fingerprint: context.fingerprint,
          activation_versions: { 7: 3 }
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
    readinessService.getSnapshot = originalSnapshot;
    engineState.arm = originalArm;
  }
});
