const crypto = require('crypto');
const db = require('./db');
const logger = require('./logger');

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_STALE_MS = 15_000;

class ServiceHeartbeat {
  constructor(options = {}) {
    this.db = options.db || db;
    this.logger = options.logger || logger;
    this.now = options.now || (() => new Date());
    this.processId = options.processId ?? process.pid;
    this.instanceId = options.instanceId || crypto.randomUUID();
    this.intervalMs = Math.max(1_000, Number(options.intervalMs || HEARTBEAT_INTERVAL_MS));
    this.role = null;
    this.startedAt = null;
    this.statusProvider = null;
    this.timer = null;
    this.writing = false;
  }

  async write(statusOverride) {
    if (!this.role || this.writing) return false;
    this.writing = true;
    try {
      const status = statusOverride || await this.statusProvider?.() || {};
      const heartbeatAt = this.now();
      await this.db.query(
        `INSERT INTO service_heartbeats(
           role, instance_id, process_id, status_json, started_at, heartbeat_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (role) DO UPDATE SET
           instance_id = EXCLUDED.instance_id,
           process_id = EXCLUDED.process_id,
           status_json = EXCLUDED.status_json,
           started_at = EXCLUDED.started_at,
           heartbeat_at = EXCLUDED.heartbeat_at,
           updated_at = NOW()`,
        [this.role, this.instanceId, this.processId, status, this.startedAt, heartbeatAt]
      );
      return true;
    } finally {
      this.writing = false;
    }
  }

  start(options = {}) {
    if (this.timer) return false;
    this.role = String(options.role || '').trim().toLowerCase();
    this.statusProvider = options.statusProvider || (() => ({}));
    this.startedAt = this.now();
    void this.write().catch((error) => {
      this.logger.error('service-heartbeat', `Initial ${this.role} heartbeat failed: ${error.message}`);
    });
    this.timer = setInterval(() => {
      void this.write().catch((error) => {
        this.logger.error('service-heartbeat', `${this.role} heartbeat failed: ${error.message}`);
      });
    }, this.intervalMs);
    this.timer.unref?.();
    return true;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.role) return;
    await this.write({ status: 'stopped' }).catch(() => {});
  }
}

async function latestHeartbeat(roles, executor = db) {
  const normalizedRoles = (Array.isArray(roles) ? roles : [roles])
    .map((role) => String(role || '').trim().toLowerCase())
    .filter(Boolean);
  if (normalizedRoles.length === 0) return null;
  const result = await executor.query(
    `SELECT latest.role, latest.instance_id, latest.process_id, latest.status_json,
            latest.started_at, latest.heartbeat_at,
            GREATEST(
              0::bigint,
              ROUND(EXTRACT(EPOCH FROM (NOW() - latest.heartbeat_at)) * 1000)::bigint
            ) AS age_ms
     FROM (
       SELECT role, instance_id, process_id, status_json, started_at, heartbeat_at
       FROM service_heartbeats
       WHERE role = ANY($1::text[])
       ORDER BY heartbeat_at DESC
       LIMIT 1
     ) AS latest`,
    [normalizedRoles]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    role: row.role,
    instanceId: row.instance_id,
    processId: row.process_id,
    status: row.status_json || {},
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    ageMs: Number(row.age_ms || 0),
    fresh: Number(row.age_ms || 0) <= HEARTBEAT_STALE_MS
  };
}

const serviceHeartbeat = new ServiceHeartbeat();

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  ServiceHeartbeat,
  latestHeartbeat,
  serviceHeartbeat
};

