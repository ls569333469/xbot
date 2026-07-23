const crypto = require('crypto');
const db = require('../../lib/db');
const gmgnHttp = require('../../lib/gmgn-http');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const engineState = require('../../lib/engine-state');
const { cache } = require('../../lib/gmgn-cache');
const { decimalToRaw } = require('../../lib/decimal-units');
const { getTradingMode } = require('../../lib/runtime-mode');
const { requireChain, rpcConfig } = require('./chain-adapters');
const { scheduler, TRADE_RESERVATION_WEIGHT } = require('../../lib/gmgn-rate-scheduler');
const livePolicy = require('../signal/live-policy');
const { reconciler } = require('./reconciliation-service');
const { loadCachedContext, requiredCacheKeys } = require('./fast-path-context');
const { cacheWarmer } = require('../../jobs/gmgn-cache-warmup');
const { latestHeartbeat } = require('../../lib/service-heartbeat');
const { probeRpc } = require('./chain-receipt-service');

const REQUIRED_MIGRATION = '012_shadow_run_sessions.sql';

function schedulerReadiness(status) {
  const blockers = [];
  const advisories = [];
  if (status.state === 'cooling') blockers.push('GMGN_SCHEDULER_NOT_HEALTHY');
  if (Number(status.configuredCapacity) < TRADE_RESERVATION_WEIGHT) {
    blockers.push('GMGN_TRADE_WEIGHT_UNAVAILABLE');
  } else if (Number(status.availableWeight) < TRADE_RESERVATION_WEIGHT) {
    advisories.push('GMGN_TRADE_WEIGHT_REFILLING');
  }
  if (status.state === 'queued') advisories.push('GMGN_SCHEDULER_BUSY');
  return { blockers, advisories };
}
const CHAINS = ['sol', 'bsc', 'base', 'eth'];

function enabled(value) {
  return String(value || 'false').toLowerCase() === 'true';
}

function jsonb(value) {
  return JSON.stringify(value ?? []);
}

function normalizeTradeEvidence(row = {}) {
  return {
    confirmedBuys: Number(row.confirmed_buy_attempts || 0),
    confirmedSells: Number(row.confirmed_sell_attempts || 0),
    confirmedOrders: Number(row.confirmed_orders || 0),
    confirmedReceipts: Number(row.confirmed_receipts || 0),
    lastConfirmedAt: row.last_confirmed_at || null
  };
}

function hashSnapshot(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function latencyMetric(row, prefix) {
  const value = (suffix) => {
    const parsed = Number(row[`${prefix}_${suffix}`]);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    count: Number(row[`${prefix}_count`] || 0),
    p50: value('p50'),
    p95: value('p95'),
    p99: value('p99')
  };
}

function emptyLatencySlo() {
  const metric = { count: 0, p50: null, p95: null, p99: null };
  return {
    windowHours: 24,
    requiredSamples: 50,
    passed: false,
    inbox: { ...metric },
    signal: { ...metric },
    execution: { ...metric },
    receiveToSwap: { ...metric }
  };
}

async function safeQuery(sql, params = []) {
  try {
    return { ok: true, result: await db.query(sql, params) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function probeChains(policy, rows) {
  const result = {};
  if (!process.env.GMGN_API_KEY || !process.env.GMGN_PRIVATE_KEY) return result;
  let user;
  try {
    user = await gmgnHttp.getUserInfo();
  } catch (error) {
    const errorCode = error.code || error.message;
    for (const row of rows) {
      result[row.chain] = { ok: false, error: errorCode };
      await db.query(
        `UPDATE chain_live_readiness
         SET last_error = $2, last_checked_at = NOW(), updated_at = NOW()
         WHERE chain = $1`,
        [row.chain, errorCode]
      );
    }
    return result;
  }
  for (const row of rows) {
    try {
      const wallet = gmgnAdapter.selectWallet(user, row.chain);
      const chainDefinition = requireChain(row.chain);
      const nativeBalanceEntry = (wallet.balances || []).find(
        (item) => String(item.symbol || '').toUpperCase() === chainDefinition.nativeSymbol
      );
      const nativeBalance = Number(
        nativeBalanceEntry?.balance ?? nativeBalanceEntry?.amount ?? nativeBalanceEntry?.ui_amount
      );
      result[row.chain] = {
        ok: true,
        wallet: wallet.address,
        balances: wallet.balances,
        nativeBalance: Number.isFinite(nativeBalance) ? nativeBalance : null
      };
      await db.query(
        `UPDATE chain_live_readiness
         SET implemented = true, wallet_address = $2, balances_json = $3,
             native_balance = $4, last_error = NULL,
             last_checked_at = NOW(), updated_at = NOW()
         WHERE chain = $1`,
        [row.chain, wallet.address, jsonb(wallet.balances || []), result[row.chain].nativeBalance]
      );
    } catch (error) {
      result[row.chain] = { ok: false, error: error.code || error.message };
      await db.query(
        `UPDATE chain_live_readiness
         SET last_error = $2, last_checked_at = NOW(), updated_at = NOW()
         WHERE chain = $1`,
        [row.chain, error.code || error.message]
      );
    }
  }
  return result;
}

async function probeContracts(whitelists) {
  const result = {};
  for (const whitelist of whitelists) {
    try {
      const context = await loadCachedContext(whitelist);
      const inputAmountRaw = decimalToRaw(whitelist.budget_per_trade, context.chain.decimals);
      const quote = gmgnAdapter.normalizeQuote(await gmgnHttp.quoteOrder(
        context.chain.id,
        context.wallet.address,
        context.chain.nativeToken,
        whitelist.contract_address,
        inputAmountRaw,
        Number(whitelist.slippage || 0)
      ));
      result[whitelist.id] = {
        ok: true,
        chain: context.chain.id,
        contractAddress: whitelist.contract_address,
        inputAmountDisplay: String(whitelist.budget_per_trade),
        inputAmountRaw,
        tokenDecimals: context.token.decimals,
        liquidityUsd: context.pool.liquidityUsd ?? context.token.liquidityUsd,
        quoteOutputAmountRaw: quote.outputAmountRaw
      };
    } catch (error) {
      result[whitelist.id] = {
        ok: false,
        chain: whitelist.chain_id,
        contractAddress: whitelist.contract_address,
        error: error.code || error.message
      };
    }
  }
  return result;
}

async function probePolicyRpcs(policy) {
  const results = await Promise.all((policy.chains || []).map(async (chain) => [
    chain,
    await probeRpc(chain)
  ]));
  return Object.fromEntries(results);
}

async function persistContractProbeEvidence(policy, whitelists, probes, chainProbes, executor = db) {
  const evidenceByChain = {};
  for (const chain of policy.chains || []) {
    const selected = whitelists.filter((whitelist) => whitelist.chain_id === chain);
    if (selected.length === 0) continue;
    const contractResults = selected.map((whitelist) => ({
      whitelistId: Number(whitelist.id),
      contractAddress: whitelist.contract_address,
      ...probes[whitelist.id]
    }));
    const walletProbe = chainProbes[chain] || null;
    const passed = Boolean(walletProbe?.ok) && contractResults.every((probe) => probe.ok);
    const summary = {
      policy: {
        provider: policy.providers,
        eventTypes: policy.eventTypes,
        chain,
        whitelistIds: selected.map((whitelist) => Number(whitelist.id))
      },
      wallet: walletProbe ? {
        ok: Boolean(walletProbe.ok),
        address: walletProbe.wallet || null,
        nativeBalance: walletProbe.nativeBalance ?? null,
        error: walletProbe.error || null
      } : null,
      contracts: contractResults
    };
    const evidenceHash = hashSnapshot({
      evidenceType: 'contract_probe',
      chain,
      status: passed ? 'passed' : 'failed',
      summary
    });
    const inserted = await executor.query(
      `INSERT INTO chain_readiness_evidence(
         chain, evidence_type, whitelist_id, status, evidence_hash, summary_json,
         migration_name, code_version, created_by
       ) VALUES ($1, 'contract_probe', $2, $3, $4, $5, $6, $7, 'readiness_probe')
       ON CONFLICT (evidence_hash) DO NOTHING
       RETURNING id, created_at`,
      [
        chain,
        selected.length === 1 ? selected[0].id : null,
        passed ? 'passed' : 'failed',
        evidenceHash,
        summary,
        REQUIRED_MIGRATION,
        process.env.XBOT_CODE_VERSION || 'local-worktree'
      ]
    );
    let evidence = inserted.rows[0];
    if (!evidence) {
      evidence = (await executor.query(
        'SELECT id, created_at FROM chain_readiness_evidence WHERE evidence_hash = $1',
        [evidenceHash]
      )).rows[0];
    }
    if (passed) {
      await executor.query(
        `UPDATE chain_live_readiness
         SET contract_tested = true, last_error = NULL, updated_at = NOW()
         WHERE chain = $1`,
        [chain]
      );
    }
    evidenceByChain[chain] = {
      id: evidence?.id || null,
      type: 'contract_probe',
      status: passed ? 'passed' : 'failed',
      createdAt: evidence?.created_at || null,
      whitelistIds: selected.map((whitelist) => Number(whitelist.id))
    };
  }
  return evidenceByChain;
}

async function getSnapshot(options = {}) {
  const migration = await safeQuery('SELECT 1 FROM schema_migrations WHERE name = $1', [REQUIRED_MIGRATION]);
  if (!migration.ok || migration.result.rows.length === 0) {
    return {
      readyToArm: false,
      snapshotHash: null,
      generatedAt: new Date(),
      blockers: ['MIGRATION_NOT_CURRENT'],
      checks: { database: migration.ok, migration: false },
      chains: [],
      scheduler: scheduler.getStatus(),
      cache: cache.status(),
      latencySlo: emptyLatencySlo(),
      reconciler: null
    };
  }

  const policy = await livePolicy.getPolicy();
  const [chainResult, uncertainResult, unprotectedResult, rate429Result, outboxResult,
    reconcilerStatus, chainConfigResult, riskConfigResult, invalidWhitelistResult, whitelistResult,
    relationResult, latestEvidenceResult, latencyResult, tradeEvidenceResult,
    readinessEvidenceResult] = await Promise.all([
    db.query('SELECT * FROM chain_live_readiness ORDER BY chain'),
    db.query("SELECT COUNT(*)::int AS count FROM trade_attempts WHERE status IN ('submission_uncertain','reconciliation_required')"),
    db.query("SELECT COUNT(*)::int AS count FROM positions WHERE execution_mode = 'live' AND status = 'open_unprotected'"),
    db.query("SELECT MAX(created_at) AS last_at FROM provider_rate_events WHERE event_type = '429'"),
    db.query("SELECT COUNT(*)::int AS count FROM notification_outbox WHERE status IN ('pending','failed') AND next_attempt_at <= NOW()"),
    reconciler.getStatus(),
    db.query("SELECT value_json FROM config WHERE key = 'chain_configs'"),
    db.query("SELECT value_json FROM config WHERE key = 'risk_config'"),
    db.query(
      `SELECT COUNT(*)::int AS count FROM ca_whitelist
       WHERE status = 'active' AND id = ANY($1::int[])
         AND (budget_per_trade <= 0 OR total_budget <= 0 OR budget_per_trade > total_budget
              OR slippage <= 0 OR slippage > 100)`,
      [policy.whitelistIds.length > 0 ? policy.whitelistIds : [-1]]
    ),
    db.query(
      `SELECT id, chain_id, contract_address, symbol, budget_per_trade, total_budget, slippage
       FROM ca_whitelist
       WHERE status = 'active' AND id = ANY($1::int[]) AND chain_id = ANY($2::text[])
       ORDER BY id`,
      [policy.whitelistIds.length > 0 ? policy.whitelistIds : [-1],
        policy.chains.length > 0 ? policy.chains : ['__none__']]
    ),
    db.query(
      `SELECT relation.id, relation.whitelist_id, actor.x_handle AS actor_handle,
              relation.target_x_handle
       FROM x_signal_relations AS relation
       JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id AND actor.enabled = true
       WHERE relation.enabled = true AND relation.whitelist_id = ANY($1::int[])
       ORDER BY relation.whitelist_id, relation.id`,
      [policy.whitelistIds.length > 0 ? policy.whitelistIds : [-1]]
    ),
    db.query(
      `SELECT provider_event.provider_event_id, activity.id AS activity_id,
              signal.id AS signal_id, signal.status AS signal_status,
              attempt.id AS attempt_id, attempt.status AS attempt_status,
              orders.provider_order_id, orders.tx_hash,
              receipt.receipt_status, signal.created_at AS signal_created_at
       FROM trade_signals AS signal
       JOIN x_activities AS activity ON activity.id = signal.activity_id
       LEFT JOIN LATERAL (
         SELECT event.provider_event_id
         FROM x_provider_events AS event
         WHERE activity.id = ANY(COALESCE(event.activity_ids, '{}'::int[]))
         ORDER BY event.received_at DESC LIMIT 1
       ) AS provider_event ON true
       LEFT JOIN trade_attempts AS attempt ON attempt.signal_id = signal.id AND attempt.side = 'buy'
       LEFT JOIN trade_orders AS orders ON orders.attempt_id = attempt.id
       LEFT JOIN chain_receipts AS receipt ON receipt.order_id = orders.id
       WHERE signal.whitelist_id = ANY($1::int[])
       ORDER BY signal.created_at DESC, attempt.id DESC, orders.id DESC
       LIMIT 1`,
      [policy.whitelistIds.length > 0 ? policy.whitelistIds : [-1]]
    ),
    db.query(
      `SELECT
         COUNT(receive_to_inbox_ms)::int AS inbox_count,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY receive_to_inbox_ms) AS inbox_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY receive_to_inbox_ms) AS inbox_p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY receive_to_inbox_ms) AS inbox_p99,
         COUNT(receive_to_signal_ms)::int AS signal_count,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY receive_to_signal_ms) AS signal_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY receive_to_signal_ms) AS signal_p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY receive_to_signal_ms) AS signal_p99,
         COUNT(signal_to_execution_ms)::int AS execution_count,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY signal_to_execution_ms) AS execution_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY signal_to_execution_ms) AS execution_p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY signal_to_execution_ms) AS execution_p99,
         COUNT(receive_to_swap_ms)::int AS receive_swap_count,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY receive_to_swap_ms) AS receive_swap_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY receive_to_swap_ms) AS receive_swap_p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY receive_to_swap_ms) AS receive_swap_p99
       FROM x_provider_events
       WHERE provider = '6551' AND received_at >= NOW() - INTERVAL '24 hours'`
    ),
    db.query(
      `SELECT
         attempts.chain,
         COUNT(DISTINCT attempts.id) FILTER (
           WHERE attempts.side = 'buy' AND attempts.status = 'confirmed'
         )::int AS confirmed_buy_attempts,
         COUNT(DISTINCT attempts.id) FILTER (
           WHERE attempts.side = 'sell' AND attempts.status = 'confirmed'
         )::int AS confirmed_sell_attempts,
         COUNT(DISTINCT orders.id) FILTER (
           WHERE orders.normalized_status = 'confirmed'
         )::int AS confirmed_orders,
         COUNT(DISTINCT receipts.id) FILTER (
           WHERE receipts.receipt_status = 'confirmed'
         )::int AS confirmed_receipts,
         MAX(GREATEST(attempts.confirmed_at, orders.confirmed_at, receipts.verified_at)) FILTER (
           WHERE attempts.status = 'confirmed'
              OR orders.normalized_status = 'confirmed'
              OR receipts.receipt_status = 'confirmed'
         ) AS last_confirmed_at
       FROM trade_attempts AS attempts
       LEFT JOIN trade_orders AS orders ON orders.attempt_id = attempts.id
       LEFT JOIN chain_receipts AS receipts ON receipts.order_id = orders.id
       WHERE attempts.side IN ('buy', 'sell')
       GROUP BY attempts.chain`
    ),
    db.query(
      `SELECT DISTINCT ON (chain, evidence_type)
         id, chain, evidence_type, status, created_at, summary_json
       FROM chain_readiness_evidence
       WHERE evidence_type = 'contract_probe'
       ORDER BY chain, evidence_type, created_at DESC, id DESC`
    )
  ]);
  const chainRows = chainResult.rows;
  const ingestionHeartbeat = await latestHeartbeat(['ingestion', 'all']).catch(() => null);
  const probes = options.probe ? await probeChains(policy, chainRows) : {};
  const contractProbes = options.probe ? await probeContracts(whitelistResult.rows) : {};
  const rpcProbes = options.probe ? await probePolicyRpcs(policy) : {};
  const contractEvidence = options.probe
    ? await persistContractProbeEvidence(
      policy,
      whitelistResult.rows,
      contractProbes,
      probes
    )
    : {};
  const schedulerStatus = scheduler.getStatus();
  const cacheStatus = cache.status();
  const requiredKeys = requiredCacheKeys(whitelistResult.rows);
  const freshCacheKeys = new Set(
    cacheStatus.entries.filter((entry) => entry.fresh).map((entry) => entry.key)
  );
  const missingCacheKeys = requiredKeys.filter((key) => !freshCacheKeys.has(key));
  const cacheWarmerStatus = cacheWarmer.getStatus();
  const last429At = rate429Result.rows[0].last_at;
  const recent429 = last429At && Date.now() - new Date(last429At).getTime() < 15 * 60_000;
  const providerConfigured = Boolean(process.env.GMGN_API_KEY && process.env.GMGN_PRIVATE_KEY);
  const xProvider = String(process.env.X_DATA_PROVIDER || '').toLowerCase();
  const ingestionHealthy = xProvider !== '6551' || Boolean(
    ingestionHeartbeat?.fresh && ingestionHeartbeat.status?.wss?.status === 'subscribed'
  );
  const keyExclusive = enabled(process.env.GMGN_KEY_EXCLUSIVE);
  const alertsVerified = enabled(process.env.TRADE_ALERTS_VERIFIED);
  const liveEnabled = enabled(process.env.LIVE_TRADING_ENABLED);
  const emergencyStop = enabled(process.env.EMERGENCY_STOP);
  const mode = getTradingMode();
  const chainConfigs = chainConfigResult.rows[0]?.value_json || {};
  const riskConfig = riskConfigResult.rows[0]?.value_json || {};
  const configurationFingerprint = hashSnapshot({
    mode,
    liveEnabled,
    emergencyStop,
    xProvider,
    keyExclusive,
    credentials: hashSnapshot({
      apiKey: process.env.GMGN_API_KEY || '',
      privateKey: process.env.GMGN_PRIVATE_KEY || ''
    }),
    policy,
    chainConfigs,
    riskConfig,
    whitelists: whitelistResult.rows,
    globalLimits: {
      dailyUsd: process.env.GMGN_GLOBAL_DAILY_USD_LIMIT || '',
      weeklyUsd: process.env.GMGN_GLOBAL_WEEKLY_USD_LIMIT || ''
    },
    chainRuntime: Object.fromEntries(CHAINS.map((chain) => [chain, {
      rpc: process.env[`${chain === 'sol' ? 'SOLANA' : chain.toUpperCase()}_RPC_URL`] || '',
      feeReserve: process.env[`GMGN_MAX_FEE_RESERVE_${chain.toUpperCase()}`] || '',
      minimumGasReserve: process.env[`GMGN_MIN_GAS_RESERVE_${chain.toUpperCase()}`] || ''
    }]))
  });
  const tradeEvidenceByChain = new Map(
    tradeEvidenceResult.rows.map((row) => [row.chain, normalizeTradeEvidence(row)])
  );
  const persistedContractEvidence = new Map(readinessEvidenceResult.rows.map((row) => [
    row.chain,
    {
      id: row.id,
      type: row.evidence_type,
      status: row.status,
      createdAt: row.created_at,
      whitelistIds: row.summary_json?.policy?.whitelistIds || []
    }
  ]));
  const latencyRow = latencyResult.rows[0] || {};
  const latencySlo = {
    windowHours: 24,
    requiredSamples: 50,
    inbox: latencyMetric(latencyRow, 'inbox'),
    signal: latencyMetric(latencyRow, 'signal'),
    execution: latencyMetric(latencyRow, 'execution'),
    receiveToSwap: latencyMetric(latencyRow, 'receive_swap')
  };
  latencySlo.passed = latencySlo.signal.count >= latencySlo.requiredSamples
    && latencySlo.execution.count >= latencySlo.requiredSamples
    && latencySlo.signal.p95 !== null && latencySlo.signal.p95 <= 300
    && latencySlo.execution.p95 !== null && latencySlo.execution.p95 <= 300;

  const chains = CHAINS.map((chain) => {
    const row = chainRows.find((item) => item.chain === chain) || { chain };
    const implemented = Boolean(row.implemented || probes[chain]?.ok);
    const contractTested = Boolean(row.contract_tested || contractEvidence[chain]?.status === 'passed');
    const blockers = [];
    const advisories = [];
    if (!implemented) blockers.push('CHAIN_NOT_IMPLEMENTED');
    if (!contractTested) blockers.push('CHAIN_CONTRACT_NOT_TESTED');
    if (!row.shadow_verified) advisories.push('CHAIN_SHADOW_NOT_VERIFIED');
    if (!row.live_enabled) advisories.push('CHAIN_LIVE_FLAG_NOT_SET');
    if (!rpcConfig(chain).url) blockers.push('CHAIN_RPC_MISSING');
    const limits = chainConfigs[chain] || {};
    if (!limits.enabled) blockers.push('CHAIN_BUDGET_DISABLED');
    if (![limits.dailyBudget, limits.weeklyBudget, limits.maxPerTrade,
      limits.maxOpenPositions, limits.dailyLossLimit]
      .every((value) => Number.isFinite(Number(value)) && Number(value) > 0)) {
      blockers.push('CHAIN_HARD_LIMIT_INVALID');
    }
    if (options.probe && policy.chains.includes(chain)) {
      const chainDefinition = requireChain(chain);
      const nativeBalance = probes[chain]?.nativeBalance;
      const minimumGasReserve = Number(process.env[`GMGN_MIN_GAS_RESERVE_${chain.toUpperCase()}`] || 0);
      const feeReserve = Number(process.env[`GMGN_MAX_FEE_RESERVE_${chain.toUpperCase()}`] || 0);
      const requiredBalance = Number(limits.maxPerTrade || 0) + minimumGasReserve + feeReserve;
      if (!Number.isFinite(nativeBalance)) blockers.push('CHAIN_NATIVE_BALANCE_UNKNOWN');
      else if (nativeBalance < requiredBalance) blockers.push('CHAIN_NATIVE_BALANCE_INSUFFICIENT');
    }
    if (options.probe && probes[chain] && !probes[chain].ok) blockers.push(probes[chain].error);
    if (options.probe && policy.chains.includes(chain) && !rpcProbes[chain]?.ok) {
      blockers.push(rpcProbes[chain]?.error || 'CHAIN_RPC_UNAVAILABLE');
    }
    return {
      ...row,
      implemented,
      wallet_address: probes[chain]?.wallet || row.wallet_address || null,
      native_balances: probes[chain]?.balances || row.balances_json || [],
      native_balance: probes[chain]?.ok ? probes[chain].nativeBalance : row.native_balance,
      last_error: probes[chain]?.ok ? null : (probes[chain]?.error || row.last_error || null),
      contract_tested: contractTested,
      contract_evidence: contractEvidence[chain] || persistedContractEvidence.get(chain) || null,
      rpc_probe: rpcProbes[chain] || null,
      policy_enabled: policy.chains.includes(chain),
      trade_evidence: tradeEvidenceByChain.get(chain) || normalizeTradeEvidence(),
      limits,
      blockers,
      advisories,
      ready: blockers.length === 0 && policy.chains.includes(chain)
    };
  });

  const blockers = [];
  const advisories = [];
  const schedulerGate = schedulerReadiness(schedulerStatus);
  if (mode !== 'live') blockers.push('LIVE_MODE_REQUIRED');
  if (!liveEnabled) blockers.push('LIVE_TRADING_DISABLED');
  if (emergencyStop) blockers.push('EMERGENCY_STOP_ACTIVE');
  if (!providerConfigured) blockers.push('GMGN_CREDENTIALS_MISSING');
  if (!ingestionHealthy) blockers.push('X_6551_INGESTION_UNHEALTHY');
  if (!keyExclusive) blockers.push('GMGN_KEY_EXCLUSIVE_NOT_CONFIRMED');
  blockers.push(...schedulerGate.blockers);
  advisories.push(...schedulerGate.advisories);
  if (options.probe && missingCacheKeys.length > 0) blockers.push('FAST_PATH_CACHE_NOT_READY');
  if (policy.whitelistIds.length > 0 && !cacheWarmerStatus.running) blockers.push('FAST_PATH_WARMER_NOT_RUNNING');
  if (cacheWarmerStatus.lastError) blockers.push('FAST_PATH_WARMER_ERROR');
  if (options.probe && Object.values(contractProbes).some((probe) => !probe.ok)) {
    blockers.push('CONTRACT_PROBE_FAILED');
  }
  if (recent429) blockers.push('GMGN_RECENT_429');
  if (Number(uncertainResult.rows[0].count) > 0) blockers.push('UNRESOLVED_TRADE_ATTEMPTS');
  if (Number(unprotectedResult.rows[0].count) > 0) blockers.push('UNPROTECTED_LIVE_POSITIONS');
  if (!Array.isArray(policy.providers) || policy.providers.length === 0
      || !Array.isArray(policy.eventTypes) || policy.eventTypes.length === 0
      || !Array.isArray(policy.whitelistIds) || policy.whitelistIds.length === 0) {
    blockers.push('LIVE_POLICY_EMPTY');
  }
  if (whitelistResult.rows.length !== policy.whitelistIds.length) {
    blockers.push('LIVE_POLICY_WHITELIST_MISSING');
  }
  const relationWhitelistIds = new Set(relationResult.rows.map((row) => Number(row.whitelist_id)));
  if (policy.whitelistIds.some((id) => !relationWhitelistIds.has(Number(id)))) {
    blockers.push('LIVE_POLICY_RELATION_MISSING');
  }
  if (policy.eventTypes.some((eventType) => !policy.verifiedEventTypes.includes(eventType))) {
    blockers.push('LIVE_POLICY_CONTAINS_UNVERIFIED_EVENT');
  }
  if (policy.whitelistIds.length > 0 && !latencySlo.passed) advisories.push('FAST_PATH_SLO_NOT_VERIFIED');
  if (!alertsVerified) advisories.push('TRADE_ALERTS_NOT_VERIFIED');
  if (!chains.some((chain) => chain.ready)) blockers.push('NO_LIVE_CHAIN_READY');
  if (Number(invalidWhitelistResult.rows[0].count) > 0) blockers.push('WHITELIST_HARD_LIMIT_INVALID');
  if (Number(process.env.GMGN_GLOBAL_DAILY_USD_LIMIT || 0) <= 0
      || Number(process.env.GMGN_GLOBAL_WEEKLY_USD_LIMIT || 0) <= 0) {
    blockers.push('GLOBAL_USD_LIMIT_INVALID');
  }
  if (!reconcilerStatus.running) blockers.push('RECONCILER_NOT_RUNNING');
  if (reconcilerStatus.lastError) blockers.push('RECONCILER_ERROR');
  const armedFingerprint = engineState.getConfigurationFingerprint?.();
  if (engineState.getArmed() && armedFingerprint
      && armedFingerprint !== configurationFingerprint) {
    blockers.push('LIVE_CONFIGURATION_CHANGED');
  }

  const snapshot = {
    generatedAt: new Date(),
    mode,
    armed: engineState.getArmed(),
    liveEnabled,
    configurationFingerprint,
    readyToArm: blockers.length === 0,
    blockers: [...new Set(blockers)],
    advisories: [...new Set(advisories)],
    checks: {
      database: true,
      migration: true,
      providerConfigured,
      ingestionHealthy,
      keyExclusive,
      alertsVerified,
      recent429: Boolean(recent429),
      uncertainAttempts: Number(uncertainResult.rows[0].count),
      unprotectedPositions: Number(unprotectedResult.rows[0].count),
      pendingAlerts: Number(outboxResult.rows[0].count)
    },
    chains,
    scheduler: schedulerStatus,
    cache: cacheStatus,
    cacheRequired: {
      total: requiredKeys.length,
      missing: missingCacheKeys,
      ready: missingCacheKeys.length === 0
    },
    cacheWarmer: cacheWarmerStatus,
    latencySlo,
    contractProbes,
    rpcProbes,
    reconciler: reconcilerStatus,
    services: {
      ingestion: ingestionHeartbeat ? {
        role: ingestionHeartbeat.role,
        heartbeatAt: ingestionHeartbeat.heartbeatAt,
        heartbeatAgeMs: ingestionHeartbeat.ageMs,
        fresh: ingestionHeartbeat.fresh,
        wssStatus: ingestionHeartbeat.status?.wss?.status || 'unknown'
      } : null
    },
    policy,
    relations: relationResult.rows.map((row) => ({
      id: Number(row.id),
      whitelistId: Number(row.whitelist_id),
      actorHandle: row.actor_handle,
      targetHandle: row.target_x_handle
    })),
    latestEvidence: latestEvidenceResult.rows[0] ? {
      providerEventId: latestEvidenceResult.rows[0].provider_event_id || null,
      activityId: latestEvidenceResult.rows[0].activity_id || null,
      signalId: latestEvidenceResult.rows[0].signal_id || null,
      signalStatus: latestEvidenceResult.rows[0].signal_status || null,
      attemptId: latestEvidenceResult.rows[0].attempt_id || null,
      attemptStatus: latestEvidenceResult.rows[0].attempt_status || null,
      providerOrderId: latestEvidenceResult.rows[0].provider_order_id || null,
      txHash: latestEvidenceResult.rows[0].tx_hash || null,
      receiptStatus: latestEvidenceResult.rows[0].receipt_status || null,
      signalCreatedAt: latestEvidenceResult.rows[0].signal_created_at || null
    } : null,
    pollingPolicy: reconcilerStatus.pollingPolicy
  };
  snapshot.snapshotHash = hashSnapshot(snapshot);
  return snapshot;
}

async function assertReadyToArm() {
  const snapshot = await getSnapshot({ probe: true });
  if (!snapshot.readyToArm) {
    const error = new Error(`Live readiness failed: ${snapshot.blockers.join(', ')}`);
    error.code = 'LIVE_READINESS_FAILED';
    error.details = snapshot;
    throw error;
  }
  await db.query(
    `INSERT INTO trade_runtime_state(key, value_json)
     VALUES ('arm_readiness_snapshot', $1)
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [snapshot]
  );
  return snapshot;
}

class ReadinessMonitor {
  constructor(options = {}) {
    this.snapshotProvider = options.snapshotProvider || getSnapshot;
    this.engine = options.engine || engineState;
    this.onDisarm = options.onDisarm || (async (details) => {
      await db.query(
        `INSERT INTO notification_outbox(topic, aggregate_type, aggregate_id, payload)
         VALUES ('trade.auto_disarmed', 'system', 'readiness', $1)`,
        [details]
      );
    });
    this.intervalMs = Math.max(500, Number(options.intervalMs || 5000));
    this.timer = null;
    this.lastError = null;
  }

  async checkOnce() {
    if (!this.engine.getArmed()) return { status: 'skipped', reason: 'not_armed' };
    try {
      const snapshot = await this.snapshotProvider();
      if (snapshot.readyToArm) return { status: 'ready', snapshot };
      if (typeof this.engine.setFaulted === 'function') {
        await this.engine.setFaulted({
          reason: 'READINESS_FAILED',
          details: { blockers: snapshot.blockers, snapshot_hash: snapshot.snapshotHash }
        });
      } else {
        await this.engine.setArmed(false);
      }
      await this.onDisarm({
        reason: 'READINESS_FAILED',
        blockers: snapshot.blockers || [],
        snapshot_hash: snapshot.snapshotHash || null,
        generated_at: snapshot.generatedAt || new Date()
      });
      return { status: 'disarmed', snapshot };
    } catch (error) {
      this.lastError = error.message;
      if (typeof this.engine.setFaulted === 'function') {
        await this.engine.setFaulted({
          reason: 'READINESS_CHECK_ERROR',
          details: { error: error.code || error.message }
        }).catch(() => {});
      } else {
        await this.engine.setArmed(false).catch(() => {});
      }
      await this.onDisarm({
        reason: 'READINESS_CHECK_ERROR',
        error: error.code || error.message,
        generated_at: new Date()
      }).catch(() => {});
      return { status: 'disarmed', error: error.code || error.message };
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const monitor = new ReadinessMonitor();

module.exports = {
  REQUIRED_MIGRATION,
  ReadinessMonitor,
  assertReadyToArm,
  getSnapshot,
  schedulerReadiness,
  jsonb,
  monitor,
  normalizeTradeEvidence,
  persistContractProbeEvidence
};
