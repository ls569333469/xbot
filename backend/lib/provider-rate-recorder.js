const db = require('./db');
const logger = require('./logger');
const gmgnHttp = require('./gmgn-http');

let requestListener = null;
let statusListener = null;

function start(options = {}) {
  if (requestListener) return;
  const wsBroadcast = options.wsBroadcast;
  requestListener = (event) => {
    db.query(
      `INSERT INTO provider_rate_events
        (provider, endpoint, method, weight, http_status, latency_ms, remaining,
         reset_at, event_type, error_code, source, process_role,
         signal_id, policy_id, whitelist_id, context_json)
       VALUES ('gmgn', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        event.path,
        event.method,
        event.weight,
        event.status,
        event.latencyMs,
        Number.isFinite(event.remaining) ? event.remaining : null,
        event.resetAt ? new Date(event.resetAt) : null,
        event.status === 429 || String(event.errorCode || '').includes('RATE_LIMIT') ? '429' : 'request',
        event.errorCode,
        event.source || 'unspecified',
        event.processRole || 'all',
        event.signalId,
        event.policyId,
        event.whitelistId,
        JSON.stringify({
          ...(event.context || {}),
          stage: event.stage || event.context?.stage || null,
          trace_id: event.traceId || event.context?.trace_id || event.context?.traceId || null,
          execution_session_id: event.executionSessionId
            || event.context?.execution_session_id || event.context?.executionSessionId || null,
          rate_scope: event.rateScope || event.context?.rate_scope || event.context?.rateScope || null
        })
      ]
    ).catch((error) => logger.warn('gmgn-rate', `Failed to persist rate event: ${error.message}`));
  };
  statusListener = (status) => {
    wsBroadcast?.({ type: 'gmgn:scheduler', payload: status });
  };
  gmgnHttp.requestEvents.on('request', requestListener);
  gmgnHttp.scheduler.on('status', statusListener);
  gmgnHttp.scheduler.on('429', statusListener);
}

function stop() {
  if (requestListener) gmgnHttp.requestEvents.off('request', requestListener);
  if (statusListener) {
    gmgnHttp.scheduler.off('status', statusListener);
    gmgnHttp.scheduler.off('429', statusListener);
  }
  requestListener = null;
  statusListener = null;
}

module.exports = { start, stop };
