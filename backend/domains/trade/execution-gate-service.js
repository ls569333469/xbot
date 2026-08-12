const engineState = require('../../lib/engine-state');

const MAX_AGE_MS = 1500;

class ExecutionGateService {
  constructor(options = {}) {
    this.engine = options.engine || engineState;
    this.maxAgeMs = Math.max(250, Number(options.maxAgeMs || MAX_AGE_MS));
    this.current = null;
  }

  update(readiness) {
    if (!readiness) return null;
    this.current = {
      generatedAt: readiness.generatedAt || new Date().toISOString(),
      capturedAtMs: Date.now(),
      readyToArm: Boolean(readiness.readyToArm),
      blockers: [...new Set(readiness.blockers || [])],
      configurationFingerprint: readiness.configurationFingerprint || null,
      scope: readiness.scope ? {
        scope_type: readiness.scope.scope_type || 'combined',
        scope_id: readiness.scope.scope_id ?? null,
        chains: [...new Set(readiness.scope.chains || readiness.scope.scope_chain_ids || [])].sort(),
        revision: readiness.scope.policy_revision ?? readiness.scope.scope_revision ?? null,
        manifest_hash: readiness.scope.manifest_hash || readiness.scope.scope_manifest_hash || null
      } : null,
      scheduler: readiness.scheduler ? {
        state: readiness.scheduler.state,
        configuredCapacity: readiness.scheduler.configuredCapacity,
        availableWeight: readiness.scheduler.availableWeight
      } : null,
      chains: (readiness.chains || []).map((chain) => ({
        chain: chain.chain,
        ready: Boolean(chain.ready),
        infrastructureReady: Boolean(chain.infrastructure_ready),
        blockers: [...new Set(chain.blockers || [])]
      }))
    };
    return this.current;
  }

  getSnapshot() {
    if (!this.current) return null;
    return { ...this.current, ageMs: Math.max(0, Date.now() - this.current.capturedAtMs) };
  }

  assertReady(chain, options = {}) {
    const snapshot = this.getSnapshot();
    if (!snapshot || snapshot.ageMs > this.maxAgeMs) {
      const error = new Error('Execution gate snapshot is missing or stale');
      error.code = 'EXECUTION_GATE_STALE';
      error.details = snapshot;
      throw error;
    }
    const runtime = this.engine.getStatus?.() || {};
    if (!this.engine.getArmed?.() || runtime.status !== 'running') {
      const error = new Error('Live engine is not armed');
      error.code = 'LIVE_ENGINE_NOT_ARMED';
      throw error;
    }
    const globalBlockers = (snapshot.blockers || []).filter((blocker) => (
      blocker !== 'UNPROTECTED_LIVE_POSITIONS'
    ));
    if (globalBlockers.length > 0) {
      const error = new Error(`Execution gate is blocked: ${globalBlockers.join(', ')}`);
      error.code = 'LIVE_READINESS_FAILED';
      error.details = { ...snapshot, blockers: globalBlockers };
      throw error;
    }
    if (!snapshot.configurationFingerprint
        || snapshot.configurationFingerprint !== runtime.configurationFingerprint) {
      const error = new Error('Execution gate configuration fingerprint changed');
      error.code = 'LIVE_CONFIGURATION_CHANGED';
      throw error;
    }
    if (snapshot.scope && runtime.scope
        && (snapshot.scope.scope_type !== runtime.scope.scope_type
          || Number(snapshot.scope.scope_id || 0) !== Number(runtime.scope.scope_id || 0)
          || (snapshot.scope.chains.length > 0
            && JSON.stringify(snapshot.scope.chains)
              !== JSON.stringify([...(runtime.scope.chain_ids || [])].sort()))
          || (snapshot.scope.revision !== null && snapshot.scope.revision !== undefined
            && Number(snapshot.scope.revision || 0) !== Number(runtime.scope.revision || 0))
          || (snapshot.scope.manifest_hash && runtime.scope.manifest_hash
            && snapshot.scope.manifest_hash !== runtime.scope.manifest_hash))) {
      const error = new Error('Execution gate snapshot belongs to another runtime scope');
      error.code = 'LIVE_SCOPE_SNAPSHOT_MISMATCH';
      throw error;
    }
    const target = snapshot.chains.find((item) => item.chain === chain);
    const strategyScope = Boolean(options.strategyScope ?? options.dynamicScope);
    const targetReady = strategyScope
      ? target?.infrastructureReady
      : target?.ready;
    if (!targetReady) {
      const error = new Error(`Execution gate rejected ${chain}`);
      error.code = 'LIVE_CHAIN_READINESS_FAILED';
      error.details = target || { chain, blockers: ['CHAIN_READINESS_MISSING'] };
      throw error;
    }
    return snapshot;
  }
}

const executionGateService = new ExecutionGateService();

module.exports = { ExecutionGateService, MAX_AGE_MS, executionGateService };
