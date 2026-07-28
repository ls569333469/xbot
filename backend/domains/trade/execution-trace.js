const crypto = require('crypto');
const { performance } = require('perf_hooks');

const ALLOWED_STAGES = new Set([
  'claim', 'gate', 'cache', 'quote', 'risk', 'attempt', 'evidence',
  'lane', 'swap', 'submitted', 'receipt', 'confirmed', 'fallback'
]);
const MAX_STAGES = 24;

class ExecutionTrace {
  constructor(options = {}) {
    this.traceId = String(options.traceId || crypto.randomUUID()).slice(0, 128);
    this.startedEpochMs = Number(options.startedEpochMs || Date.now());
    this.startedMonoMs = performance.now();
    this.stages = {};
  }

  mark(stage, details = {}) {
    if (!ALLOWED_STAGES.has(stage) || Object.keys(this.stages).length >= MAX_STAGES) return;
    const elapsedMs = Math.max(0, Math.round(performance.now() - this.startedMonoMs));
    const safeDetails = {};
    for (const [key, value] of Object.entries(details || {}).slice(0, 8)) {
      if (/key|secret|signature|authorization|private|payload|response|url/i.test(key)) continue;
      if (['string', 'number', 'boolean'].includes(typeof value) || value === null) {
        safeDetails[String(key).slice(0, 64)] = typeof value === 'string'
          ? value.slice(0, 256)
          : value;
      }
    }
    this.stages[stage] = {
      elapsed_ms: elapsedMs,
      at: new Date(this.startedEpochMs + elapsedMs).toISOString(),
      ...safeDetails
    };
  }

  snapshot() {
    return {
      version: 1,
      trace_id: this.traceId,
      started_at: new Date(this.startedEpochMs).toISOString(),
      elapsed_ms: Math.max(0, Math.round(performance.now() - this.startedMonoMs)),
      stages: { ...this.stages }
    };
  }
}

function createExecutionTrace(options = {}) {
  return new ExecutionTrace(options);
}

module.exports = { ALLOWED_STAGES, ExecutionTrace, createExecutionTrace };
