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
         reset_at, event_type, error_code)
       VALUES ('gmgn', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.path,
        event.method,
        event.weight,
        event.status,
        event.latencyMs,
        Number.isFinite(event.remaining) ? event.remaining : null,
        event.resetAt ? new Date(event.resetAt) : null,
        event.status === 429 ? '429' : 'request',
        event.errorCode
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
