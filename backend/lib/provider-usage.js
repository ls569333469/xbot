const db = require('./db');
const logger = require('./logger');

const TWITTERAPI_USD_PER_CREDIT = 0.00001;
const warnedBudgets = new Set();

class ProviderBudgetExceededError extends Error {
  constructor(provider, limit, current, requested) {
    super(`${provider} daily credit limit exceeded (${current} + ${requested} > ${limit})`);
    this.name = 'ProviderBudgetExceededError';
    this.code = 'PROVIDER_BUDGET_EXCEEDED';
  }
}

async function reserveUsage(provider, endpoint, estimatedCredits, dailyLimit) {
  const credits = Math.max(0, Number(estimatedCredits || 0));
  const limit = Math.max(1, Number(dailyLimit));
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider-usage:${provider}`]);
    const totalRes = await client.query(
      `SELECT COALESCE(SUM(credits_used), 0) AS credits
       FROM x_provider_usage_daily
       WHERE provider = $1 AND usage_date = CURRENT_DATE`,
      [provider]
    );
    const current = Number(totalRes.rows[0].credits || 0);
    if (current + credits > limit) {
      throw new ProviderBudgetExceededError(provider, limit, current, credits);
    }

    await client.query(
      `INSERT INTO x_provider_usage_daily
        (provider, usage_date, endpoint, request_count, credits_used, updated_at)
       VALUES ($1, CURRENT_DATE, $2, 1, $3, NOW())
       ON CONFLICT (provider, usage_date, endpoint)
       DO UPDATE SET
         request_count = x_provider_usage_daily.request_count + 1,
         credits_used = x_provider_usage_daily.credits_used + EXCLUDED.credits_used,
         updated_at = NOW()`,
      [provider, endpoint, credits]
    );
    await client.query('COMMIT');

    const warningPct = Math.min(99, Math.max(
      1,
      Number(process.env.TWITTERAPI_IO_CREDIT_WARNING_PCT || 80)
    ));
    const usedAfterReservation = current + credits;
    const warningKey = `${provider}:${new Date().toISOString().slice(0, 10)}`;
    if (usedAfterReservation >= limit * (warningPct / 100) && !warnedBudgets.has(warningKey)) {
      warnedBudgets.add(warningKey);
      logger.warn('provider-usage', `${provider} daily credits reached ${warningPct}%`, {
        credits_used: usedAfterReservation,
        credit_limit: limit
      });
    }

    return { provider, endpoint, reservedCredits: credits };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeUsage(reservation, actualCredits, latencyMs, isError) {
  if (!reservation) return;
  const delta = Number(actualCredits ?? reservation.reservedCredits) - reservation.reservedCredits;
  await db.query(
    `UPDATE x_provider_usage_daily
     SET credits_used = GREATEST(0, credits_used + $1),
         error_count = error_count + $2,
         latency_ms_total = latency_ms_total + $3,
         updated_at = NOW()
     WHERE provider = $4 AND usage_date = CURRENT_DATE AND endpoint = $5`,
    [delta, isError ? 1 : 0, Math.max(0, Math.round(latencyMs || 0)), reservation.provider, reservation.endpoint]
  );
}

async function getDailyUsage(provider) {
  const result = await db.query(
    `SELECT
       COALESCE(SUM(request_count), 0) AS request_count,
       COALESCE(SUM(credits_used), 0) AS credits_used,
       COALESCE(SUM(error_count), 0) AS error_count,
       COALESCE(SUM(latency_ms_total), 0) AS latency_ms_total
     FROM x_provider_usage_daily
     WHERE provider = $1 AND usage_date = CURRENT_DATE`,
    [provider]
  );
  const row = result.rows[0];
  const creditsUsed = Number(row.credits_used || 0);
  if (provider === '6551') {
    return {
      provider,
      unit: 'points',
      request_count: Number(row.request_count || 0),
      credits_used: creditsUsed,
      points_used: creditsUsed,
      error_count: Number(row.error_count || 0),
      latency_ms_total: Number(row.latency_ms_total || 0),
      estimated_usd: null,
      credit_limit: null,
      credits_remaining: null,
      usage_pct: null,
      circuit_open: false
    };
  }
  const creditLimit = Math.max(
    1,
    Number(process.env.TWITTERAPI_IO_DAILY_CREDIT_LIMIT || 50000)
  );

  return {
    provider,
    unit: 'credits',
    request_count: Number(row.request_count || 0),
    credits_used: creditsUsed,
    error_count: Number(row.error_count || 0),
    latency_ms_total: Number(row.latency_ms_total || 0),
    estimated_usd: Number((creditsUsed * TWITTERAPI_USD_PER_CREDIT).toFixed(6)),
    credit_limit: creditLimit,
    credits_remaining: Math.max(0, creditLimit - creditsUsed),
    usage_pct: Number(((creditsUsed / creditLimit) * 100).toFixed(2)),
    circuit_open: creditsUsed >= creditLimit
  };
}

module.exports = {
  ProviderBudgetExceededError,
  reserveUsage,
  finalizeUsage,
  getDailyUsage
};
