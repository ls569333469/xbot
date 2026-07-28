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
      scheduler: readiness.scheduler ? {
        state: readiness.scheduler.state,
        configuredCapacity: readiness.scheduler.configuredCapacity,
        availableWeight: readiness.scheduler.availableWeight
      } : null,
      chains: (readiness.chains || []).map((chain) => ({
        chain: chain.chain,
        ready: Boolean(chain.ready),
        blockers: [...new Set(chain.blockers || [])]
      }))
    };
    return this.current;
  }

  getSnapshot() {
    if (!this.current) return null;
    return { ...this.current, ageMs: Math.max(0, Date.now() - this.current.capturedAtMs) };
  }

  assertReady(chain) {
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
    if (!snapshot.readyToArm) {
      const error = new Error(`Execution gate is blocked: ${snapshot.blockers.join(', ')}`);
      error.code = 'LIVE_READINESS_FAILED';
      error.details = snapshot;
      throw error;
    }
    if (!snapshot.configurationFingerprint
        || snapshot.configurationFingerprint !== runtime.configurationFingerprint) {
      const error = new Error('Execution gate configuration fingerprint changed');
      error.code = 'LIVE_CONFIGURATION_CHANGED';
      throw error;
    }
    const target = snapshot.chains.find((item) => item.chain === chain);
    if (!target?.ready) {
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
