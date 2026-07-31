const { EventEmitter } = require('events');

const OFFICIAL_RATE = 20;
const OFFICIAL_CAPACITY = 20;
const INTERNAL_RATE = 14;
const INTERNAL_CAPACITY = 14;
const TRADE_RESERVATION_WEIGHT = 7;
const TRADE_EVIDENCE_WEIGHT = 4;

const ENDPOINT_WEIGHTS = new Map([
  ['GET /v1/user/info', 1],
  ['GET /v1/user/wallet_token_balance', 1],
  ['GET /v1/user/wallet_activity', 3],
  ['GET /v1/token/info', 1],
  ['GET /v1/token/security', 1],
  ['GET /v1/token/pool_info', 1],
  ['GET /v1/market/rank', 1],
  ['POST /v1/market/hot_searches', 3],
  ['POST /v1/trenches', 3],
  ['GET /v1/market/token_top_holders', 5],
  ['POST /v1/trade/swap', 5],
  ['POST /v1/trade/multi_swap', 5],
  ['GET /v1/trade/quote', 2],
  ['GET /v1/trade/query_order', 1],
  ['POST /v1/trade/strategy/create', 5],
  ['POST /v1/trade/strategy/cancel', 2],
  ['GET /v1/trade/strategy/orders', 1],
  ['GET /v1/trade/gas_price', 1]
]);

const PRIORITIES = Object.freeze({
  CRITICAL_RECONCILIATION: 0,
  NEW_TRADE: 1,
  TRADE_EVIDENCE: 2,
  STRATEGY_ACTION: 3,
  STABLE_RECONCILIATION: 4,
  CACHE_WARMUP: 5
});

function endpointWeight(method, path) {
  return ENDPOINT_WEIGHTS.get(`${String(method).toUpperCase()} ${path}`) || 5;
}

function parseResetAt(value, fallbackNow = Date.now()) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallbackNow + 60_000;
}

class RateLease {
  constructor(scheduler, weight, context) {
    this.scheduler = scheduler;
    this.totalWeight = weight;
    this.remainingWeight = weight;
    this.context = context;
    this.closed = false;
    this.scheduler.registerLease(this);
  }

  consume(weight) {
    const amount = Number(weight);
    if (this.closed || !Number.isFinite(amount) || amount <= 0 || amount > this.remainingWeight) {
      const error = new Error('GMGN rate reservation is invalid or exhausted');
      error.code = 'GMGN_RATE_RESERVATION_INVALID';
      throw error;
    }
    this.remainingWeight -= amount;
    this.scheduler.recordConsumption(amount);
    if (this.remainingWeight === 0) {
      this.closed = true;
      this.scheduler.closeLease(this);
    }
  }

  release() {
    if (this.closed || this.remainingWeight <= 0) return 0;
    const released = this.remainingWeight;
    this.remainingWeight = 0;
    this.closed = true;
    this.scheduler.release(released, this);
    return released;
  }
}

class WeightedRateScheduler extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rate = Number(options.rate || INTERNAL_RATE);
    this.capacity = Number(options.capacity || INTERNAL_CAPACITY);
    this.currentRate = this.rate;
    this.tokens = this.capacity;
    this.lastRefillAt = (options.now || Date.now)();
    this.cooldownUntil = 0;
    this.last429At = null;
    this.lastResetAt = null;
    this.queue = [];
    this.sequence = 0;
    this.timer = null;
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.jitter = options.jitter || (() => Math.floor(100 + Math.random() * 401));
    this.activeLeases = new Set();
    this.recentReservations = [];
    this.recentConsumption = [];
  }

  _refill(now = this.now()) {
    if (now <= this.lastRefillAt) return;
    const elapsedSeconds = (now - this.lastRefillAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.currentRate);
    this.lastRefillAt = now;
    this.recentReservations = this.recentReservations.filter((entry) => now - entry.at < 1000);
    this.recentConsumption = this.recentConsumption.filter((entry) => now - entry.at < 1000);
  }

  _schedule(delayMs) {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this._drain();
    }, Math.max(1, Math.ceil(delayMs)));
    this.timer.unref?.();
  }

  _drain() {
    const now = this.now();
    this._refill(now);
    this.queue = this.queue.filter((item) => {
      if (!item.deadlineAt || item.deadlineAt > now) return true;
      const error = new Error('GMGN rate queue deadline expired');
      error.code = 'GMGN_RATE_DEADLINE_EXPIRED';
      item.reject(error);
      return false;
    });
    if (this.queue.length === 0) return;

    this.queue.sort((left, right) => (
      left.priority - right.priority
      || (left.deadlineAt || Infinity) - (right.deadlineAt || Infinity)
      || left.sequence - right.sequence
    ));

    if (this.cooldownUntil > now) {
      this._schedule(this.cooldownUntil - now + this.jitter());
      return;
    }

    while (this.queue.length > 0) {
      const item = this.queue[0];
      if (this.tokens + Number.EPSILON < item.weight) break;
      this.queue.shift();
      this.tokens -= item.weight;
      this.recentReservations.push({ at: now, weight: item.weight });
      item.resolve(new RateLease(this, item.weight, item.context));
    }

    if (this.queue.length > 0) {
      const needed = Math.max(0, this.queue[0].weight - this.tokens);
      this._schedule((needed / this.currentRate) * 1000);
    }
    this.emit('status', this.getStatus());
  }

  acquire(weight, options = {}) {
    const amount = Number(weight);
    if (!Number.isFinite(amount) || amount <= 0 || amount > this.capacity) {
      const error = new Error(`Invalid GMGN request weight: ${weight}`);
      error.code = 'GMGN_RATE_WEIGHT_INVALID';
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        weight: amount,
        priority: Number(options.priority ?? PRIORITIES.CACHE_WARMUP),
        deadlineAt: options.deadlineAt ? Number(options.deadlineAt) : null,
        context: options.context || {},
        sequence: this.sequence++,
        resolve,
        reject
      });
      this._drain();
    });
  }

  reserveTrade(options = {}) {
    return this.acquire(TRADE_RESERVATION_WEIGHT, {
      ...options,
      priority: PRIORITIES.NEW_TRADE
    });
  }

  reserveTradeEvidence(options = {}) {
    return this.acquire(TRADE_EVIDENCE_WEIGHT, {
      ...options,
      priority: PRIORITIES.TRADE_EVIDENCE
    });
  }

  registerLease(lease) {
    this.activeLeases.add(lease);
  }

  closeLease(lease) {
    this.activeLeases.delete(lease);
  }

  recordConsumption(weight) {
    this._refill();
    this.recentConsumption.push({ at: this.now(), weight: Number(weight) });
  }

  release(weight, lease) {
    if (lease) this.closeLease(lease);
    this._refill();
    this.tokens = Math.min(this.capacity, this.tokens + Number(weight || 0));
    this._drain();
  }

  observe429(resetAt) {
    const now = this.now();
    const parsedReset = parseResetAt(resetAt, now);
    const minimumReset = now + 60_000;
    this.cooldownUntil = Math.max(this.cooldownUntil, parsedReset || minimumReset);
    if (!resetAt) this.cooldownUntil = Math.max(this.cooldownUntil, minimumReset);
    this.last429At = now;
    this.lastResetAt = this.cooldownUntil;
    this.currentRate = Math.max(5, Math.floor(this.currentRate * 0.8));
    this.emit('429', this.getStatus());
    this._drain();
  }

  resetForTests() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.currentRate = this.rate;
    this.tokens = this.capacity;
    this.lastRefillAt = this.now();
    this.cooldownUntil = 0;
    this.last429At = null;
    this.lastResetAt = null;
    for (const lease of this.activeLeases) {
      lease.remainingWeight = 0;
      lease.closed = true;
    }
    this.activeLeases.clear();
    this.queue.splice(0).forEach((item) => {
      const error = new Error('Scheduler reset');
      error.code = 'GMGN_SCHEDULER_RESET';
      item.reject(error);
    });
    this.recentReservations = [];
    this.recentConsumption = [];
  }

  getStatus() {
    const now = this.now();
    this._refill(now);
    const reservedLastSecond = this.recentReservations
      .reduce((total, entry) => total + entry.weight, 0);
    const consumedLastSecond = this.recentConsumption
      .reduce((total, entry) => total + entry.weight, 0);
    const reservedWeight = [...this.activeLeases]
      .reduce((total, lease) => total + lease.remainingWeight, 0);
    const queueByPriority = {};
    this.queue.forEach((item) => {
      queueByPriority[item.priority] = (queueByPriority[item.priority] || 0) + 1;
    });
    return {
      state: this.cooldownUntil > now ? 'cooling' : this.queue.length > 0 ? 'queued' : 'healthy',
      officialRate: OFFICIAL_RATE,
      officialCapacity: OFFICIAL_CAPACITY,
      configuredRate: this.rate,
      configuredCapacity: this.capacity,
      currentRate: this.currentRate,
      availableWeight: Number(this.tokens.toFixed(4)),
      reservedWeight: Number(reservedWeight.toFixed(4)),
      reservedLastSecond,
      consumedLastSecond,
      reservedOrConsumedLastSecond: reservedLastSecond,
      queueDepth: this.queue.length,
      queueByPriority,
      cooldownUntil: this.cooldownUntil || null,
      last429At: this.last429At,
      resetAt: this.lastResetAt,
      endpointWeights: Object.fromEntries(ENDPOINT_WEIGHTS)
    };
  }
}

const scheduler = new WeightedRateScheduler();

module.exports = {
  ENDPOINT_WEIGHTS,
  INTERNAL_CAPACITY,
  INTERNAL_RATE,
  OFFICIAL_CAPACITY,
  OFFICIAL_RATE,
  PRIORITIES,
  TRADE_RESERVATION_WEIGHT,
  TRADE_EVIDENCE_WEIGHT,
  WeightedRateScheduler,
  endpointWeight,
  parseResetAt,
  scheduler
};
