const { fetchKline } = require('../dynamic-signal/gmgn-market-source');
const { REPLAY_PROVIDER_VERSION } = require('./constants');
const {
  ONE_DAY_SECONDS,
  ONE_MINUTE_SECONDS,
  timestampSeconds,
  usableRows
} = require('./kline-utils');

const MAX_HOURLY_CHUNK_SECONDS = 30 * ONE_DAY_SECONDS;
const DEFAULT_GLOBAL_INTERVAL_MS = 1_000;
const DEFAULT_CA_INTERVAL_MS = 2_000;
const MAX_PACING_INTERVAL_MS = 60_000;
const RETRYABLE_CODES = new Set([
  'RATE_LIMIT_EXCEEDED', 'GMGN_RATE_LIMIT_COOLDOWN', 'GMGN_RATE_DEADLINE_EXPIRED',
  'GMGN_REQUEST_TIMEOUT', 'GMGN_NETWORK_ERROR'
]);

function retryablePriceError(error) {
  const code = String(error?.code || '').toUpperCase();
  return error?.status === 429 || RETRYABLE_CODES.has(code) || code.includes('RATE_LIMIT')
    || code.includes('NETWORK') || code.includes('TIMEOUT');
}

function unix(value) {
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

function rowsWithTimestamp(rows) {
  return usableRows(rows).filter((row) => row._timestamp !== null);
}

function pacingInterval(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.max(fallback, Math.min(MAX_PACING_INTERVAL_MS, Math.floor(parsed)));
}

function pacingKey(request = {}) {
  const chain = String(request.chain_id || '').trim().toLowerCase();
  const address = String(request.contract_address || '').trim();
  return `${chain}:${chain === 'sol' ? address : address.toLowerCase()}`;
}

function createKlinePacer(options = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const globalIntervalMs = pacingInterval(
    options.globalIntervalMs ?? process.env.KOL_PERFORMANCE_GMGN_GLOBAL_INTERVAL_MS,
    DEFAULT_GLOBAL_INTERVAL_MS
  );
  const caIntervalMs = pacingInterval(
    options.caIntervalMs ?? process.env.KOL_PERFORMANCE_GMGN_CA_INTERVAL_MS,
    DEFAULT_CA_INTERVAL_MS
  );
  const nextByCa = new Map();
  let nextGlobalAt = 0;
  let tail = Promise.resolve();

  const wait = (request) => {
    const scheduled = tail.then(async () => {
      const key = pacingKey(request);
      const observedAt = Number(now());
      const targetAt = Math.max(observedAt, nextGlobalAt, nextByCa.get(key) || 0);
      const delayMs = Math.max(0, targetAt - observedAt);
      if (delayMs > 0) await sleep(delayMs);
      const releasedAt = Math.max(targetAt, Number(now()));
      nextGlobalAt = releasedAt + globalIntervalMs;
      if (nextByCa.size >= 1_000) {
        for (const [storedKey, nextAt] of nextByCa) {
          if (nextAt <= releasedAt) nextByCa.delete(storedKey);
        }
      }
      nextByCa.set(key, releasedAt + caIntervalMs);
      return { delay_ms: delayMs, released_at: new Date(releasedAt).toISOString() };
    });
    tail = scheduled.catch(() => {});
    return scheduled;
  };

  return { wait, globalIntervalMs, caIntervalMs };
}

async function loadWindow(repository, request, options = {}) {
  const cached = await repository.getReplayCache(request);
  if (Array.isArray(cached) && cached.length > 0) return { rows: cached, cache_hit: true };
  const pacing = options.pacer ? await options.pacer.wait(request) : null;
  let response;
  try {
    response = await (options.fetchKline || fetchKline)({
      chain: request.chain_id, address: request.contract_address, resolution: request.resolution,
      from: request.from_unix, to: request.to_unix,
      requestOptions: { requestContext: { source: 'kol_performance_replay', stage: 'token_kline' } }
    });
  } catch (error) {
    error.pacing = pacing;
    throw error;
  }
  const rows = Array.isArray(response?.rows) ? response.rows : [];
  if (rows.length > 0) await repository.putReplayCache({ ...request, rows });
  return { rows, cache_hit: false, pacing };
}

function bestPeak(rows, initial = null) {
  let peak = initial;
  for (const row of rows) {
    const value = Number.isFinite(Number(row.high)) ? Number(row.high) : Number(row.close);
    if (!Number.isFinite(value)) continue;
    if (!peak || value > peak.price) peak = { price: value, timestamp: row._timestamp };
  }
  return peak;
}

async function replayAsset(asset, asOfAt, repository, options = {}) {
  const eventUnix = unix(asset.source_occurred_at);
  const asOfUnix = unix(asOfAt);
  if (!eventUnix || !asOfUnix || asOfUnix <= eventUnix) {
    return { price_status: 'no_data', price_error_code: 'KLINE_WINDOW_NOT_READY', price_error_detail: 'No complete price window after the source event', provider_snapshot: {} };
  }
  const entryFrom = Math.floor(eventUnix / ONE_MINUTE_SECONDS) * ONE_MINUTE_SECONDS;
  const entryTo = Math.min(asOfUnix, entryFrom + ONE_DAY_SECONDS);
  if (entryTo <= entryFrom) {
    return { price_status: 'no_data', price_error_code: 'KLINE_WINDOW_NOT_READY', price_error_detail: 'No complete entry candle is available', provider_snapshot: {} };
  }
  const requests = [];
  const loadReplayWindow = async (request) => {
    try {
      const window = await loadWindow(repository, request, options);
      requests.push({ ...request, cache_hit: window.cache_hit, pacing: window.pacing || undefined });
      return window;
    } catch (error) {
      // Preserve the exact attempted K-line request for a retryable provider error.
      requests.push({
        ...request, cache_hit: false, outcome: 'failed', pacing: error.pacing || undefined
      });
      error.providerSnapshot = {
        version: REPLAY_PROVIDER_VERSION,
        as_of_at: asOfAt,
        requests
      };
      throw error;
    }
  };
  const entryRequest = {
    chain_id: asset.chain_id, contract_address: asset.contract_address,
    resolution: '1m', from_unix: entryFrom, to_unix: entryTo
  };
  const entryWindow = await loadReplayWindow(entryRequest);
  const entryRows = rowsWithTimestamp(entryWindow.rows);
  const entry = entryRows.find((row) => row._timestamp >= entryFrom);
  if (!entry || !Number.isFinite(entry.close) || entry.close <= 0) {
    return {
      price_status: 'no_data', price_error_code: 'GMGN_KLINE_EMPTY',
      price_error_detail: 'GMGN did not return a usable entry candle',
      provider_snapshot: { version: REPLAY_PROVIDER_VERSION, as_of_at: asOfAt, requests }
    };
  }
  // The entry candle can begin before the source event. Its high therefore cannot
  // be treated as a post-entry peak; the entry close is the initial floor instead.
  let peak = { price: entry.close, timestamp: entry._timestamp };
  peak = bestPeak(entryRows.filter((row) => row._timestamp > entry._timestamp), peak);
  let cursor = entryTo;
  while (cursor < asOfUnix) {
    const to = Math.min(asOfUnix, cursor + MAX_HOURLY_CHUNK_SECONDS);
    const request = {
      chain_id: asset.chain_id, contract_address: asset.contract_address,
      resolution: '1h', from_unix: cursor, to_unix: to
    };
    const window = await loadReplayWindow(request);
    peak = bestPeak(rowsWithTimestamp(window.rows), peak);
    cursor = to;
  }
  if (!peak || !Number.isFinite(peak.price)) {
    return {
      price_status: 'no_data', price_error_code: 'GMGN_KLINE_EMPTY',
      price_error_detail: 'GMGN did not return a usable peak candle',
      provider_snapshot: { version: REPLAY_PROVIDER_VERSION, as_of_at: asOfAt, requests }
    };
  }
  return {
    price_status: 'completed', entry_price: entry.close,
    entry_candle_at: new Date(entry._timestamp * 1000).toISOString(), peak_price: peak.price,
    peak_candle_at: peak.timestamp ? new Date(peak.timestamp * 1000).toISOString() : null,
    peak_multiple: peak.price / entry.close,
    provider_snapshot: { version: REPLAY_PROVIDER_VERSION, as_of_at: asOfAt, requests }
  };
}

module.exports = {
  DEFAULT_CA_INTERVAL_MS,
  DEFAULT_GLOBAL_INTERVAL_MS,
  MAX_HOURLY_CHUNK_SECONDS,
  ONE_MINUTE_SECONDS,
  bestPeak,
  createKlinePacer,
  pacingInterval,
  pacingKey,
  replayAsset,
  retryablePriceError,
  rowsWithTimestamp,
  unix
};
