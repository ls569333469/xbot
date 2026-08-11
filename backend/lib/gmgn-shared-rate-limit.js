const db = require('./db');
const {
  COOLDOWN_REJECT_PRIORITY,
  PRIORITIES,
  TRADE_MAX_RESERVATION_WEIGHT,
  parseResetAt
} = require('./gmgn-rate-scheduler');

const DEFAULT_RATE = 5;
// The shared scope must hold the largest supported initial buy session
// (BSC/Base gas read plus swap). Smaller sessions reserve less at runtime.
const DEFAULT_CAPACITY = TRADE_MAX_RESERVATION_WEIGHT;
const STATE_UNAVAILABLE_COOLDOWN_MS = 60_000;

function enabled(env = process.env) {
  return String(env.P22_GMGN_SHARED_LIMIT_ENABLED ?? 'false').toLowerCase() === 'true';
}

function scopeKey(env = process.env) {
  return String(
    env.P22_GMGN_RATE_SCOPE
      || env.P24_GMGN_RATE_SCOPE
      || `gmgn:${env.GMGN_API_HOST || 'https://openapi.gmgn.ai'}`
  )
    .trim().slice(0, 180);
}

function cooldownError(resetAt, now = Date.now()) {
  const error = new Error('GMGN request rejected during provider rate-limit cooldown');
  error.code = 'GMGN_RATE_LIMIT_COOLDOWN';
  error.resetAt = resetAt || null;
  error.retryAfterSeconds = resetAt
    ? Math.max(1, Math.ceil((Number(resetAt) - now) / 1000)) : null;
  return error;
}

function deadlineError() {
  const error = new Error('GMGN shared rate-limit wait exceeded request deadline');
  error.code = 'GMGN_RATE_DEADLINE_EXPIRED';
  return error;
}

class PostgresGmgnRateLimit {
  constructor(options = {}) {
    this.db = options.db || db;
    this.rate = Number(options.rate || DEFAULT_RATE);
    this.capacity = Number(options.capacity || DEFAULT_CAPACITY);
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.randomJitter = options.randomJitter || (() => Math.floor(25 + Math.random() * 100));
    this.unavailableUntil = 0;
  }

  isEnabled() {
    return enabled();
  }

  async reserve(weight, options = {}) {
    const client = await this.db.pool.connect();
    const nowMs = this.now();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO gmgn_rate_limit_state
          (scope_key, rate_per_second, capacity, available_tokens, refilled_at)
         VALUES ($1,$2,$3,$3,NOW())
         ON CONFLICT (scope_key) DO NOTHING`,
        [scopeKey(), this.rate, this.capacity]
      );
      const result = await client.query(
        `SELECT rate_per_second, capacity, available_tokens,
                EXTRACT(EPOCH FROM refilled_at) * 1000 AS refilled_ms,
                EXTRACT(EPOCH FROM cooldown_until) * 1000 AS cooldown_ms
         FROM gmgn_rate_limit_state WHERE scope_key = $1 FOR UPDATE`,
        [scopeKey()]
      );
      const row = result.rows[0];
      const refilledMs = Number(row.refilled_ms) || nowMs;
      const rate = Number(row.rate_per_second) || this.rate;
      const capacity = Number(row.capacity) || this.capacity;
      const currentTokens = Number(row.available_tokens) || 0;
      const cooldownUntil = Number(row.cooldown_ms) || 0;
      const elapsedSeconds = Math.max(0, nowMs - refilledMs) / 1000;
      const tokens = Math.min(capacity, currentTokens + elapsedSeconds * rate);
      const cooldownActive = cooldownUntil > nowMs;
      const waitMs = cooldownActive
        ? cooldownUntil - nowMs
        : tokens >= weight ? 0 : ((weight - tokens) / rate) * 1000;
      await client.query(
        `UPDATE gmgn_rate_limit_state
         SET available_tokens = $2, refilled_at = $3, updated_at = NOW()
         WHERE scope_key = $1`,
        [scopeKey(), cooldownActive || waitMs > 0 ? tokens : tokens - weight, new Date(nowMs)]
      );
      await client.query('COMMIT');
      return { granted: waitMs <= 0, waitMs, cooldownUntil: cooldownActive ? cooldownUntil : null };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async acquire(weight, options = {}) {
    if (!this.isEnabled() || this.unavailableUntil > this.now()) return null;
    const priority = Number(options.priority ?? PRIORITIES.CACHE_WARMUP);
    const deadlineAt = Number(options.deadlineAt || 0) || null;
    try {
      for (;;) {
        const result = await this.reserve(Number(weight), options);
        if (result.granted) return { release() {} };
        if (result.cooldownUntil && priority >= COOLDOWN_REJECT_PRIORITY) {
          throw cooldownError(result.cooldownUntil, this.now());
        }
        const delay = Math.max(25, Math.ceil(result.waitMs + this.randomJitter()));
        if (deadlineAt && this.now() + delay > deadlineAt) throw deadlineError();
        await this.sleep(delay);
      }
    } catch (error) {
      if (error.code === 'GMGN_RATE_LIMIT_COOLDOWN' || error.code === 'GMGN_RATE_DEADLINE_EXPIRED') {
        throw error;
      }
      // The local scheduler remains the availability fallback during a DB outage.
      this.unavailableUntil = this.now() + STATE_UNAVAILABLE_COOLDOWN_MS;
      return null;
    }
  }

  async observe429(resetAt, options = {}) {
    if (!this.isEnabled() || this.unavailableUntil > this.now()) return;
    const now = this.now();
    const parsed = parseResetAt(resetAt, now);
    const minimum = now + Math.max(60_000, Number(options.minimumCooldownMs || 60_000));
    const cooldownUntil = Math.max(parsed || 0, minimum);
    try {
      await this.db.query(
        `INSERT INTO gmgn_rate_limit_state
          (scope_key, rate_per_second, capacity, available_tokens, refilled_at,
           cooldown_until, last_429_at, last_reset_at)
         VALUES ($1,$2,$3,0,$4,$5,$4,$5)
         ON CONFLICT (scope_key) DO UPDATE SET
           cooldown_until = GREATEST(COALESCE(gmgn_rate_limit_state.cooldown_until, $5), $5),
           last_429_at = $4, last_reset_at = $5, updated_at = NOW()`,
        [scopeKey(), this.rate, this.capacity, new Date(now), new Date(cooldownUntil)]
      );
    } catch {
      this.unavailableUntil = this.now() + STATE_UNAVAILABLE_COOLDOWN_MS;
    }
  }
}

const sharedRateLimiter = new PostgresGmgnRateLimit();

module.exports = {
  DEFAULT_CAPACITY,
  DEFAULT_RATE,
  PostgresGmgnRateLimit,
  enabled,
  scopeKey,
  sharedRateLimiter
};
