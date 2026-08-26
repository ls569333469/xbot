const db = require('./db');
const logger = require('./logger');
const { getTradingMode } = require('./runtime-mode');

const RUNTIME_KEY = 'live_engine_control';

let isArmed = false;
let armedAt = null;
let initialized = false;
let state = {
  desired_running: false,
  status: 'stopped',
  operator: null,
  requested_at: null,
  armed_at: null,
  stopped_at: null,
  readiness_snapshot_hash: null,
  scope_type: 'combined',
  scope_id: null,
  scope_chain_ids: [],
  scope_revision: null,
  scope_manifest_hash: null,
  configuration_fingerprint: null,
  last_error: null,
  last_checked_at: null,
  last_recovered_at: null
};

function normalize(value = {}) {
  return {
    ...state,
    ...value,
    desired_running: Boolean(value.desired_running),
    status: ['stopped', 'recovering', 'running', 'paused_transient', 'fault_protected'].includes(value.status)
      ? value.status
      : 'stopped'
  };
}

async function persist(next) {
  await db.query(
    `INSERT INTO trade_runtime_state(key, value_json)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE
       SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [RUNTIME_KEY, next]
  );
  state = next;
}

async function init() {
  if (initialized) return getStatus();
  const result = await db.query(
    'SELECT value_json FROM trade_runtime_state WHERE key = $1',
    [RUNTIME_KEY]
  );
  const saved = result.rows[0]?.value_json;
  isArmed = false;
  armedAt = null;
  const next = saved
    ? normalize({
      ...saved,
      status: saved.desired_running ? 'recovering' : 'stopped',
      last_checked_at: new Date().toISOString()
    })
    : normalize({});
  await persist(next);
  initialized = true;
  logger.info('engine-state', next.desired_running
    ? 'Persisted live intent loaded; waiting for realtime readiness recovery'
    : 'Live trading is stopped');
  return getStatus();
}

async function arm(options = {}) {
  if (getTradingMode() !== 'live') {
    const error = new Error('Engine can only be armed in live mode');
    error.code = 'LIVE_MODE_REQUIRED';
    throw error;
  }
  const now = new Date();
  const next = normalize({
    ...state,
    desired_running: true,
    status: 'running',
    operator: String(options.operator || state.operator || 'admin').slice(0, 128),
    requested_at: options.preserveRequest && state.requested_at
      ? state.requested_at
      : now.toISOString(),
    armed_at: now.toISOString(),
    stopped_at: null,
    readiness_snapshot_hash: options.readiness?.snapshotHash || null,
    scope_type: options.readiness?.scope?.scope_type || state.scope_type || 'combined',
    scope_id: options.readiness?.scope?.scope_id ?? state.scope_id ?? null,
    scope_chain_ids: options.readiness?.scope?.chains || state.scope_chain_ids || [],
    scope_revision: options.readiness?.scope?.policy_revision ?? state.scope_revision ?? null,
    scope_manifest_hash: options.readiness?.scope?.manifest_hash || state.scope_manifest_hash || null,
    configuration_fingerprint: options.readiness?.configurationFingerprint || null,
    last_error: null,
    last_error_details: null,
    last_checked_at: now.toISOString(),
    last_recovered_at: options.recovered ? now.toISOString() : state.last_recovered_at,
    transient_started_at: null,
    transient_reason: null
  });
  await db.query(
    `UPDATE trade_signals AS signal
     SET status = 'signal_only',
         reject_reason = CASE
           WHEN lower(COALESCE(activity.provider, '')) = '6551'
             AND activity.source_created_at IS NULL THEN 'SOURCE_EVENT_TIME_MISSING'
           ELSE 'LIVE_TRADING_STOPPED'
         END,
         updated_at = NOW()
     FROM x_activities AS activity
     WHERE signal.status = 'recorded' AND signal.execution_mode = 'live'
       AND activity.id = signal.activity_id
       AND (
         (lower(COALESCE(activity.provider, '')) = '6551' AND activity.source_created_at IS NULL)
         OR CASE WHEN lower(COALESCE(activity.provider, '')) = '6551'
           THEN activity.source_created_at ELSE COALESCE(activity.source_created_at, signal.created_at) END < $1
       )`,
    [now]
  );
  await persist(next);
  isArmed = true;
  armedAt = now;
  return getStatus();
}

async function stop(options = {}) {
  const now = new Date();
  const next = normalize({
    ...state,
    desired_running: false,
    status: 'stopped',
    operator: String(options.operator || state.operator || 'admin').slice(0, 128),
    stopped_at: now.toISOString(),
    last_error: options.reason || null,
    last_checked_at: now.toISOString()
  });
  await persist(next);
  isArmed = false;
  armedAt = null;
  return getStatus();
}

function getScopeInput() {
  if (!state.scope_type || state.scope_type === 'combined') return { scope_type: 'combined' };
  return {
    scope_type: state.scope_type,
    scope_id: state.scope_id,
    chain_ids: state.scope_chain_ids || []
  };
}

function scopeAllowsSignal(signal = {}, explicitScope = null) {
  const scope = explicitScope || getScopeInput();
  if (scope.scope_type === 'combined') return true;
  if (scope.scope_type === 'dynamic_policy') {
    return Number(signal.actor_policy_id) === Number(scope.scope_id)
      && Number.isInteger(Number(scope.scope_id));
  }
  if (scope.scope_type === 'follow_discovery') {
    return Number(signal.follow_discovery_policy_id) === Number(scope.scope_id)
      && Number.isInteger(Number(scope.scope_id));
  }
  if (scope.scope_type === 'fixed_ca') {
    return !signal.actor_policy_id && !signal.follow_discovery_policy_id
      && (scope.scope_id === null || Number(signal.whitelist_id) === Number(scope.scope_id));
  }
  return false;
}

async function setFaulted(options = {}) {
  const now = new Date();
  const next = normalize({
    ...state,
    desired_running: options.preserveIntent === false ? false : state.desired_running,
    status: 'fault_protected',
    operator: String(options.operator || state.operator || 'system').slice(0, 128),
    stopped_at: now.toISOString(),
    last_error: options.reason || 'READINESS_FAILED',
    last_error_details: options.details || null,
    last_checked_at: now.toISOString()
  });
  await persist(next);
  isArmed = false;
  armedAt = null;
  return getStatus();
}

async function pauseTransient(options = {}) {
  if (!state.desired_running || state.status === 'stopped') return getStatus();
  const now = new Date();
  const next = normalize({
    ...state,
    desired_running: true,
    status: 'paused_transient',
    operator: String(options.operator || state.operator || 'readiness-monitor').slice(0, 128),
    transient_started_at: state.transient_started_at || now.toISOString(),
    transient_reason: options.reason || 'TRANSIENT_READINESS_FAILURE',
    last_error: options.reason || 'TRANSIENT_READINESS_FAILURE',
    last_error_details: options.details || null,
    last_checked_at: now.toISOString()
  });
  await persist(next);
  isArmed = false;
  armedAt = null;
  return getStatus();
}

async function recoverTransient(snapshot, options = {}) {
  if (!state.desired_running || state.status !== 'paused_transient') {
    const error = new Error('Engine is not waiting for transient recovery');
    error.code = 'TRANSIENT_RECOVERY_NOT_ALLOWED';
    throw error;
  }
  if (!snapshot?.readyToArm) {
    const error = new Error('Transient recovery snapshot is not ready');
    error.code = 'TRANSIENT_RECOVERY_NOT_READY';
    throw error;
  }
  if (!state.configuration_fingerprint
      || state.configuration_fingerprint !== snapshot.configurationFingerprint) {
    await setFaulted({
      preserveIntent: false,
      reason: 'LIVE_CONFIGURATION_CHANGED',
      details: {
        expected: state.configuration_fingerprint,
        actual: snapshot.configurationFingerprint
      }
    });
    const error = new Error('Live configuration changed during transient pause');
    error.code = 'LIVE_CONFIGURATION_CHANGED';
    throw error;
  }
  return arm({
    operator: options.operator || state.operator || 'readiness-monitor',
    readiness: snapshot,
    recovered: true,
    preserveRequest: true
  });
}

async function refreshAuthorizedScope(snapshot = {}) {
  const runtime = getStatus();
  if (!isArmed || runtime.status !== 'running' || !state.desired_running) {
    return { updated: false, reason: 'not_running', runtime };
  }
  if (!snapshot.readyToArm || !snapshot.scope) {
    return { updated: false, reason: 'snapshot_not_ready', runtime };
  }
  if (!state.configuration_fingerprint
      || state.configuration_fingerprint !== snapshot.configurationFingerprint) {
    return { updated: false, reason: 'configuration_mismatch', runtime };
  }

  const scopeType = snapshot.scope.scope_type || 'combined';
  const scopeId = snapshot.scope.scope_id ?? null;
  if (scopeType !== state.scope_type
      || Number(scopeId || 0) !== Number(state.scope_id || 0)) {
    return { updated: false, reason: 'scope_identity_mismatch', runtime };
  }

  const revision = snapshot.scope.policy_revision ?? snapshot.scope.scope_revision ?? null;
  const manifestHash = snapshot.scope.manifest_hash
    || snapshot.scope.scope_manifest_hash
    || null;
  if (scopeType !== 'combined' && !manifestHash) {
    return { updated: false, reason: 'scope_manifest_missing', runtime };
  }
  if (state.scope_revision !== null && revision !== null
      && Number(revision) < Number(state.scope_revision)) {
    return { updated: false, reason: 'scope_revision_rollback', runtime };
  }

  const chainIds = [...new Set(
    snapshot.scope.chains || snapshot.scope.scope_chain_ids || []
  )].map(String).sort();
  const changed = JSON.stringify([...(state.scope_chain_ids || [])].sort()) !== JSON.stringify(chainIds)
    || Number(state.scope_revision || 0) !== Number(revision || 0)
    || state.scope_manifest_hash !== manifestHash;
  if (!changed) return { updated: false, reason: 'unchanged', runtime };

  const now = new Date().toISOString();
  await persist(normalize({
    ...state,
    readiness_snapshot_hash: snapshot.snapshotHash || state.readiness_snapshot_hash,
    scope_chain_ids: chainIds,
    scope_revision: revision,
    scope_manifest_hash: manifestHash,
    last_checked_at: now
  }));
  logger.info('engine-state', `Authorized live scope refreshed to ${scopeType}:${scopeId || 'all'} revision ${revision ?? 'n/a'}`);
  return { updated: true, reason: 'scope_refreshed', runtime: getStatus() };
}

async function keepDesiredStateWaiting(reason, details) {
  const now = new Date().toISOString();
  await persist(normalize({
    ...state,
    desired_running: true,
    status: 'recovering',
    last_error: reason,
    last_error_details: details || null,
    last_checked_at: now
  }));
  isArmed = false;
  armedAt = null;
  return getStatus();
}

async function restoreDesiredState(snapshotProvider, options = {}) {
  if (!state.desired_running) return { status: 'skipped', reason: 'stopped' };
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 1));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs || 0));
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retryableBlockers = new Set(options.retryableBlockers || []);
  try {
    let snapshot;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      snapshot = await snapshotProvider({ scope: getScopeInput() });
      if (snapshot.readyToArm) break;
      const blockers = Array.isArray(snapshot.blockers) ? snapshot.blockers : [];
      const retryable = blockers.length > 0
        && blockers.every((blocker) => retryableBlockers.has(blocker));
      if (!retryable || attempt === maxAttempts) {
        if (retryable && options.pauseOnRetryableExhaustion) {
          await keepDesiredStateWaiting('TRANSIENT_READINESS_FAILURE', {
            blockers, snapshot_hash: snapshot.snapshotHash
          });
          return { status: 'waiting', snapshot };
        }
        await keepDesiredStateWaiting('READINESS_FAILED_ON_RESTART', {
          blockers, snapshot_hash: snapshot.snapshotHash
        });
        return { status: 'waiting', snapshot };
      }
      await sleep(retryDelayMs);
    }
    if (!state.configuration_fingerprint
        || state.configuration_fingerprint !== snapshot.configurationFingerprint) {
      await keepDesiredStateWaiting('LIVE_CONFIGURATION_CHANGED', {
        expected: state.configuration_fingerprint,
        actual: snapshot.configurationFingerprint
      });
      return { status: 'waiting', reason: 'configuration_changed', snapshot };
    }
    await arm({
      operator: state.operator || 'supervisor-restore',
      readiness: snapshot,
      recovered: true,
      preserveRequest: true
    });
    logger.info('engine-state', 'Live trading restored after realtime readiness verification');
    return { status: 'restored', snapshot };
  } catch (error) {
    await keepDesiredStateWaiting('READINESS_CHECK_ERROR_ON_RESTART', {
      error: error.code || error.message
    }).catch(() => {});
    logger.error('engine-state', `Live trading recovery failed: ${error.message}`);
    return { status: 'waiting', error: error.code || error.message };
  }
}

function getStatus() {
  return {
    armed: isArmed,
    armedAt: armedAt ? armedAt.toISOString() : null,
    desiredRunning: state.desired_running,
    status: isArmed ? 'running' : state.status,
    operator: state.operator,
    requestedAt: state.requested_at,
    stoppedAt: state.stopped_at,
    readinessSnapshotHash: state.readiness_snapshot_hash,
    scope: {
      scope_type: state.scope_type,
      scope_id: state.scope_id,
      chain_ids: state.scope_chain_ids || [],
      revision: state.scope_revision,
      manifest_hash: state.scope_manifest_hash
    },
    configurationFingerprint: state.configuration_fingerprint,
    lastError: state.last_error,
    lastErrorDetails: state.last_error_details || null,
    lastCheckedAt: state.last_checked_at,
    lastRecoveredAt: state.last_recovered_at,
    transientStartedAt: state.transient_started_at || null,
    transientReason: state.transient_reason || null
  };
}

module.exports = {
  RUNTIME_KEY,
  arm,
  getArmed: () => isArmed,
  getArmedAt: () => armedAt,
  getScopeInput,
  scopeAllowsSignal,
  getConfigurationFingerprint: () => state.configuration_fingerprint,
  getStatus,
  init,
  pauseTransient,
  refreshAuthorizedScope,
  recoverTransient,
  restoreDesiredState,
  setArmed: (value, options = {}) => value ? arm(options) : stop(options),
  setFaulted,
  stop
};
