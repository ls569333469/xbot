class TtlCache {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.entries = new Map();
    this.inflight = new Map();
  }

  async getOrLoad(key, ttlMs, loader) {
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      return { ...existing, cacheHit: true, ageMs: now - existing.fetchedAt };
    }
    if (this.inflight.has(key)) return this.inflight.get(key);

    const promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        const fetchedAt = this.now();
        const version = (existing?.version || 0) + 1;
        const entry = {
          value,
          version,
          fetchedAt,
          expiresAt: fetchedAt + ttlMs,
          cacheHit: false,
          ageMs: 0
        };
        this.entries.set(key, entry);
        return entry;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(prefix = '') {
    for (const key of this.entries.keys()) {
      if (!prefix || key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  status() {
    const now = this.now();
    const entries = [...this.entries.entries()].map(([key, entry]) => ({
      key,
      version: entry.version,
      ageMs: now - entry.fetchedAt,
      ttlRemainingMs: Math.max(0, entry.expiresAt - now),
      fresh: entry.expiresAt > now
    }));
    return {
      total: entries.length,
      fresh: entries.filter((entry) => entry.fresh).length,
      stale: entries.filter((entry) => !entry.fresh).length,
      entries
    };
  }
}

const cache = new TtlCache();

function cacheTtls(env = process.env) {
  const fastMs = Math.min(10_000, Math.max(5_000, Number(env.GMGN_FAST_CACHE_TTL_MS || 10_000)));
  return {
    wallet: Math.max(30_000, Number(env.GMGN_WALLET_CACHE_TTL_MS || 60_000)),
    token: Math.max(60_000, Number(env.GMGN_TOKEN_CACHE_TTL_MS || 3_600_000)),
    security: fastMs,
    pool: fastMs,
    gas: fastMs
  };
}

module.exports = { TtlCache, cache, cacheTtls };
