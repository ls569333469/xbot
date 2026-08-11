const crypto = require('crypto');
const db = require('../../lib/db');
const gmgnAccess = require('../../lib/gmgn-access-service').accessFor('readiness_diagnostic');
const gmgnAdapter = require('../../lib/gmgn-adapter');
const engineState = require('../../lib/engine-state');
const { cache } = require('../../lib/gmgn-cache');
const { decimalToRaw } = require('../../lib/decimal-units');
const { getTradingMode } = require('../../lib/runtime-mode');
const { getGmgnCredentials } = require('../../lib/gmgn-credentials');
const { requireChain, rpcConfig } = require('./chain-adapters');
const { scheduler, TRADE_RESERVATION_WEIGHT } = require('../../lib/gmgn-rate-scheduler');
const livePolicy = require('../signal/live-policy');
const { reconciler } = require('./reconciliation-service');
const { loadCachedContext, requiredCacheKeys } = require('./fast-path-context');
const { latestHeartbeat } = require('../../lib/service-heartbeat');
const { probeRpc } = require('./chain-receipt-service');
const { CHAIN_REGISTRY } = require('../../lib/chain-config');
const { tradeRetryOrchestrator } = require('./trade-retry-orchestrator');
const liveApproval = require('./live-approval-service');
const { executionGateService } = require('./execution-gate-service');
const { p20FeatureState } = require('../../lib/p20-features');
const runtimeScopeService = require('./runtime-scope-service');

const REQUIRED_MIGRATION = '042_p25_gmgn_terminal_execution.sql';
const TRANSIENT_BLOCKERS = new Set([
  'X_6551_INGESTION_UNHEALTHY',
  'GMGN_SCHEDULER_NOT_HEALTHY'
]);
let latestSnapshot = null;

function getLatestSnapshot(maxAgeMs = 5000) {
  if (!latestSnapshot) return null;
  const generatedAt = new Date(latestSnapshot.generatedAt).getTime();
  return Number.isFinite(generatedAt) && Date.now() - generatedAt <= maxAgeMs
    ? latestSnapshot
    : null;
}

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

function providerHistoryReadiness(recent429) {
  return {
    blockers: [],
    advisories: recent429 ? ['GMGN_RECENT_429'] : []
  };
}

function splitChainReadiness(blockers = []) {
  const unique = [...new Set(blockers)];
  return {
    fixedReady: unique.length === 0,
    infrastructureReady: unique.every((code) => code === 'CHAIN_CONTRACT_NOT_TESTED')
  };
}

function strategyChainReady(chainReadiness, options = {}) {
  return Boolean(
    chainReadiness?.infrastructureReady
      && (options.dynamicEnabled || options.followEnabled)
  );
}

function contractApprovalReady(row = {}, evidenceCurrent = false) {
  // Production approval is durable; a transient read-only probe failure must not revoke it.
  return Boolean(evidenceCurrent || row.contract_tested || row.live_enabled);
}

const CHAINS = Object.keys(CHAIN_REGISTRY);

function enabled(value) {
  return String(value || 'false').toLowerCase() === 'true';
}

function dynamicLivePolicyState(rows = [], flags = p20FeatureState()) {
  const runtimeEnabled = Boolean(
    flags.P20_DYNAMIC_RESOLUTION_ENABLED
    && flags.P20_RECORD_ENABLED
    && flags.P20_LIVE_ENABLED
  );
  const valid = (rows || []).filter((row) => {
    const chains = Array.isArray(row.allowed_chain_ids) ? row.allowed_chain_ids : [];
    const budgets = row.chain_budgets && typeof row.chain_budgets === 'object'
      ? row.chain_budgets : {};
    return chains.length > 0
      && Number(row.daily_new_token_limit) > 0
      && Number(row.slippage) > 0
      && chains.every((chain) => {
        const budget = budgets[chain];
        return Number(budget?.budget_per_trade) > 0
          && Number(budget?.daily_budget) >= Number(budget?.budget_per_trade);
      });
  });
  const active = runtimeEnabled ? valid : [];
  const chains = [...new Set(active.flatMap((row) => row.allowed_chain_ids || []))];
  const maxTradeByChain = Object.fromEntries(chains.map((chain) => [
    chain,
    Math.max(...active.map((row) => Number(row.chain_budgets?.[chain]?.budget_per_trade || 0)))
  ]));
  return {
    configured: active.length > 0,
    runtimeEnabled,
    configuredRows: rows.length,
    validRows: valid.length,
    invalidRows: rows.length - valid.length,
    chains,
    maxTradeByChain
  };
}

function followLivePolicyState(rows = [], runtimeEnabled = enabled(process.env.P21_FOLLOW_DISCOVERY_ENABLED)) {
  const valid = (rows || []).filter((row) => {
    const chains = Array.isArray(row.allowed_chain_ids) ? row.allowed_chain_ids : [];
    const budgets = row.trade_config_snapshot?.chain_budgets || {};
    return Boolean(row.enabled && row.mode === 'live' && row.kol_enabled
      && row.profile_status === 'verified' && row.trade_template_id)
      && chains.length > 0
      && Number(row.trade_config_snapshot?.slippage) > 0
      && chains.every((chain) => {
        const budget = budgets[chain];
        return Number(budget?.budget_per_trade) > 0
          && Number(budget?.daily_budget) >= Number(budget?.budget_per_trade);
      });
  });
  const active = runtimeEnabled ? valid : [];
  const chains = [...new Set(active.flatMap((row) => row.allowed_chain_ids || []))];
  const maxTradeByChain = Object.fromEntries(chains.map((chain) => [
    chain,
    Math.max(...active.map((row) => Number(
      row.trade_config_snapshot?.chain_budgets?.[chain]?.budget_per_trade || 0
    )))
  ]));
  return {
    configured: active.length > 0,
    runtimeEnabled,
    configuredRows: rows.length,
    validRows: valid.length,
    invalidRows: rows.length - valid.length,
    unsyncedRows: rows.filter((row) => row.watch_sync_status !== 'succeeded').length,
    chains,
    maxTradeByChain
  };
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
  const credentials = getGmgnCredentials();
  if (!credentials.apiKey || !credentials.privateKey) return result;
  let user;
  try {
    user = await gmgnAccess.getUserInfo({ requestContext: { source: 'readiness_diagnostic', stage: 'wallet_probe' } });
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
             SET implemented = CASE WHEN $5 THEN true ELSE implemented END,
                 wallet_address = $2, balances_json = $3,
             native_balance = $4, last_error = NULL,
             last_checked_at = NOW(), updated_at = NOW()
         WHERE chain = $1`,
        [
          row.chain,
          wallet.address,
          jsonb(wallet.balances || []),
          result[row.chain].nativeBalance,
          Boolean(CHAIN_REGISTRY[row.chain]?.executionImplemented)
        ]
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
  const queue = [...whitelists];
  const worker = async () => {
    while (queue.length > 0) {
      const whitelist = queue.shift();
      if (!whitelist) return;
    try {
      const context = await loadCachedContext(whitelist);
      const inputAmountRaw = decimalToRaw(whitelist.budget_per_trade, context.chain.decimals);
      const quote = gmgnAdapter.normalizeQuote(await gmgnAccess.quoteOrder(
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
  };
  await Promise.all(Array.from(
    { length: Math.min(4, Math.max(1, queue.length)) },
    () => worker()
  ));
  return result;
}

function strategyList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.list)) return value.list;
  if (Array.isArray(value?.orders)) return value.orders;
  return value && typeof value === 'object' ? [value] : [];
}

async function probeStrategies(policy, chainProbes) {
  const result = {};
  for (const chain of policy.chains || []) {
    const wallet = chainProbes[chain]?.wallet;
    if (!wallet) {
      result[chain] = { ok: false, error: 'CHAIN_WALLET_UNAVAILABLE' };
      continue;
    }
    try {
      const response = await gmgnAccess.getStrategyOrders(chain, {
        from_address: wallet,
        group_tag: 'STMix',
        type: 'open',
        limit: 1
      });
      result[chain] = { ok: true, returned: strategyList(response).length };
    } catch (error) {
      result[chain] = { ok: false, error: error.code || error.message };
    }
  }
  return result;
}

async function probePolicyRpcs(policy, chainProbes = {}) {
  const results = await Promise.all((policy.chains || []).map(async (chain) => [
    chain,
    await probeRpc(chain, { walletAddress: chainProbes[chain]?.wallet })
  ]));
  return Object.fromEntries(results);
}

function finiteBalance(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function applyRpcBalanceFallback(chainProbes, rpcProbes, executor = db) {
  for (const [chain, chainProbe] of Object.entries(chainProbes || {})) {
    if (!chainProbe?.ok || finiteBalance(chainProbe.nativeBalance) !== null) continue;
    const rpcBalance = finiteBalance(rpcProbes?.[chain]?.nativeBalance);
    if (rpcBalance === null) continue;
    chainProbe.nativeBalance = rpcBalance;
    chainProbe.nativeBalanceSource = 'rpc';
    await executor.query(
      `UPDATE chain_live_readiness
       SET native_balance = $2, last_error = NULL, last_checked_at = NOW(), updated_at = NOW()
       WHERE chain = $1`,
      [chain, rpcBalance]
    );
  }
  return chainProbes;
}

async function persistContractProbeEvidence(
  policy,
  whitelists,
  probes,
  chainProbes,
  executor = db,
  options = {}
) {
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
    const rpcProbe = options.rpcProbes?.[chain] || null;
    const strategyProbe = options.strategyProbes?.[chain] || null;
    const passed = Boolean(walletProbe?.ok)
      && Boolean(rpcProbe?.ok ?? true)
      && Boolean(strategyProbe?.ok ?? true)
      && contractResults.every((probe) => probe.ok);
    const context = liveApproval.contractContext(chain, selected);
    const summary = {
      observedAt: new Date().toISOString(),
      policy: {
        provider: policy.providers,
        eventTypes: policy.eventTypes,
        chain,
        whitelistIds: selected.map((whitelist) => Number(whitelist.id))
      },
      wallet: walletProbe ? {
        ok: Boolean(walletProbe.ok),
        reference: liveApproval.walletReference(walletProbe.wallet),
        nativeBalance: walletProbe.nativeBalance ?? null,
        error: walletProbe.error || null
      } : null,
      rpc: rpcProbe ? {
        ok: Boolean(rpcProbe.ok),
        identity: rpcProbe.identity || null,
        blockRef: rpcProbe.blockRef || null,
        error: rpcProbe.error || null
      } : null,
      strategy: strategyProbe ? {
        ok: Boolean(strategyProbe.ok),
        returned: Number(strategyProbe.returned || 0),
        error: strategyProbe.error || null
      } : null,
      context: {
        chainId: context.chainId,
        codeVersion: context.codeVersion,
        migration: context.migration,
        rpcUrlHash: context.environment.rpcUrlHash,
        configurationFingerprint: options.configurationFingerprint || null
      },
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
         migration_name, code_version, created_by, context_hash, valid_until
       ) VALUES ($1, 'contract_probe', $2, $3, $4, $5, $6, $7, 'readiness_probe',
                 $8, NOW() + ($9::double precision * interval '1 millisecond'))
       ON CONFLICT (evidence_hash) DO NOTHING
       RETURNING id, created_at, valid_until`,
      [
        chain,
        selected.length === 1 ? selected[0].id : null,
        passed ? 'passed' : 'failed',
        evidenceHash,
        summary,
        REQUIRED_MIGRATION,
        liveApproval.codeVersion(),
        context.contextHash,
        liveApproval.CONTRACT_EVIDENCE_TTL_MS
      ]
    );
    let evidence = inserted.rows[0];
    if (!evidence) {
      evidence = (await executor.query(
        'SELECT id, created_at, valid_until FROM chain_readiness_evidence WHERE evidence_hash = $1',
        [evidenceHash]
      )).rows[0];
    }
    await executor.query(
      `UPDATE chain_live_readiness
       SET contract_tested = CASE WHEN $2 THEN true ELSE contract_tested END,
           last_error = CASE WHEN $2 THEN NULL ELSE 'CONTRACT_PROBE_FAILED' END,
           updated_at = NOW()
       WHERE chain = $1`,
      [chain, passed]
    );
    evidenceByChain[chain] = {
      id: evidence?.id || null,
      type: 'contract_probe',
      status: passed ? 'passed' : 'failed',
      createdAt: evidence?.created_at || null,
      validUntil: evidence?.valid_until || null,
      contextHash: context.contextHash,
      codeVersion: liveApproval.codeVersion(),
      whitelistIds: selected.map((whitelist) => Number(whitelist.id))
    };
  }
  return evidenceByChain;
}

async function runDiagnostic(options = {}) {
  const chain = String(options.chain || '').trim().toLowerCase();
  const whitelistIds = [...new Set((options.whitelistIds || []).map(Number))]
    .filter(Number.isInteger);
  if (!CHAIN_REGISTRY[chain] || whitelistIds.length === 0) {
    const error = new Error('Diagnostic requires one chain and explicit whitelist IDs');
    error.code = 'DIAGNOSTIC_SCOPE_REQUIRED';
    throw error;
  }
  const whitelistResult = await db.query(
    `SELECT whitelist.id, whitelist.chain_id, whitelist.contract_address, whitelist.symbol,
            whitelist.budget_per_trade, whitelist.total_budget, whitelist.auto_tp_pct,
            whitelist.auto_sl_pct, whitelist.exit_strategy,
            whitelist.exit_strategy_version, whitelist.slippage, whitelist.allow_repeat_buy,
            whitelist.max_repeat_buys, whitelist.expires_at,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'actor_handle', actor.x_handle,
                'target_x_handle', relation.target_x_handle,
                'event_types', relation.event_types
              ) ORDER BY lower(regexp_replace(actor.x_handle, '^@+', '')),
                         relation.target_x_handle)
              FROM x_signal_relations AS relation
              JOIN x_kol_accounts AS actor
                ON actor.id = relation.kol_id AND actor.enabled = true
              WHERE relation.whitelist_id = whitelist.id AND relation.enabled = true
            ), '[]'::jsonb) AS relations,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'actor_handle', actor.x_handle,
                'event_types', rule.event_types,
                'match_mode', rule.match_mode,
                'source_kind', rule.source_kind
              ) ORDER BY lower(regexp_replace(actor.x_handle, '^@+', '')))
              FROM x_signal_source_rules AS rule
              JOIN x_kol_accounts AS actor
                ON actor.id = rule.actor_id AND actor.enabled = true
              WHERE rule.whitelist_id = whitelist.id AND rule.enabled = true
            ), '[]'::jsonb) AS direct_sources
     FROM ca_whitelist AS whitelist
     WHERE whitelist.id = ANY($1::int[]) AND whitelist.chain_id = $2
       AND whitelist.status = 'active'
       AND (whitelist.expires_at IS NULL OR whitelist.expires_at > NOW())
     ORDER BY whitelist.id`,
    [whitelistIds, chain]
  );
  if (whitelistResult.rows.length !== whitelistIds.length) {
    const error = new Error('Every diagnostic whitelist must be active and belong to the requested chain');
    error.code = 'DIAGNOSTIC_WHITELIST_INVALID';
    throw error;
  }
  const readinessResult = await db.query(
    'SELECT * FROM chain_live_readiness WHERE chain = $1',
    [chain]
  );
  const policy = {
    providers: ['6551'],
    eventTypes: [],
    chains: [chain],
    whitelistIds
  };
  const chainProbes = await probeChains(policy, readinessResult.rows);
  const contractProbes = await probeContracts(whitelistResult.rows);
  const rpcProbes = {
    [chain]: await probeRpc(chain, { walletAddress: chainProbes[chain]?.wallet })
  };
  await applyRpcBalanceFallback(chainProbes, rpcProbes);
  const strategyProbes = await probeStrategies(policy, chainProbes);
  const evidence = await persistContractProbeEvidence(
    policy,
    whitelistResult.rows,
    contractProbes,
    chainProbes,
    db,
    { rpcProbes, strategyProbes }
  );
  return {
    chain,
    whitelistIds,
    wallet: chainProbes[chain] ? {
      ok: Boolean(chainProbes[chain].ok),
      reference: liveApproval.walletReference(chainProbes[chain].wallet),
      nativeBalance: chainProbes[chain].nativeBalance ?? null,
      error: chainProbes[chain].error || null
    } : null,
    rpc: rpcProbes[chain],
    strategy: strategyProbes[chain],
    contracts: contractProbes,
    evidence: evidence[chain] || null
  };
}

async function getSnapshot(options = {}) {
  if (options.probe === true && engineState.getArmed()) {
    const error = new Error('GMGN readiness diagnostics are disabled while live execution is armed');
    error.code = 'GMGN_DIAGNOSTIC_BLOCKED_WHILE_LIVE';
    throw error;
  }
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

  const p20Features = p20FeatureState();
  const scoped = options.scope ? await runtimeScopeService.resolveScope(options.scope) : null;
  const [fullPolicy, dynamicPolicyResult, followPolicyResult] = await Promise.all([
    livePolicy.getPolicy(),
    db.query(
      `SELECT policy.id, policy.allowed_chain_ids, policy.chain_budgets,
              policy.daily_new_token_limit, policy.slippage
       FROM x_actor_dynamic_policies AS policy
       JOIN x_kol_accounts AS kol ON kol.id = policy.kol_id AND kol.enabled = true
       WHERE policy.enabled = true AND policy.mode = 'live'`
    ),
    db.query(
      `SELECT policy.id, policy.allowed_chain_ids, policy.trade_template_id,
              policy.trade_config_snapshot, policy.revision, policy.context_hash,
              policy.mode, policy.enabled, kol.enabled AS kol_enabled,
              kol.profile_status,
              watch.status AS watch_sync_status
       FROM follow_discovery_policies AS policy
       JOIN x_kol_accounts AS kol ON kol.id = policy.kol_id
       LEFT JOIN LATERAL (
         SELECT status
         FROM x_watch_sync_outbox
         WHERE actor_handle = lower(regexp_replace(kol.x_handle, '^@+', ''))
         ORDER BY x_watch_sync_outbox.updated_at DESC,
                  x_watch_sync_outbox.desired_version DESC
         LIMIT 1
       ) watch ON true
       WHERE policy.archived_at IS NULL AND policy.enabled = true AND policy.mode = 'live'
       ORDER BY policy.id`
    )
  ]);
  const policy = scoped && scoped.scope_type !== 'combined'
    ? {
      providers: scoped.scope_type === 'fixed_ca' ? fullPolicy.providers : [],
      eventTypes: scoped.scope_type === 'fixed_ca' ? fullPolicy.eventTypes : [],
      verifiedEventTypes: fullPolicy.verifiedEventTypes,
      chains: scoped.scope_type === 'fixed_ca' ? scoped.chains : [],
      whitelistIds: scoped.scope_type === 'fixed_ca' ? scoped.whitelist_ids : [],
      maxSignalAgeSeconds: fullPolicy.maxSignalAgeSeconds
    }
    : fullPolicy;
  const dynamicRows = scoped?.scope_type === 'dynamic_policy'
    ? dynamicPolicyResult.rows.filter((row) => Number(row.id) === Number(scoped.scope_id))
    : scoped && scoped.scope_type !== 'combined' ? [] : dynamicPolicyResult.rows;
  const dynamicPolicy = dynamicLivePolicyState(dynamicRows, p20Features);
  const followEnabled = enabled(process.env.P21_FOLLOW_DISCOVERY_ENABLED);
  const followRows = scoped?.scope_type === 'follow_discovery'
    ? followPolicyResult.rows.filter((row) => Number(row.id) === Number(scoped.scope_id))
    : scoped && scoped.scope_type !== 'combined' ? [] : followPolicyResult.rows;
  const followPolicy = {
    ...followLivePolicyState(followRows, followEnabled),
    policyId: scoped?.scope_type === 'follow_discovery' ? scoped.follow_policy_id : null,
    revision: scoped?.scope_type === 'follow_discovery' ? scoped.policy_revision : null,
    watchSync: scoped?.scope_type === 'follow_discovery' ? scoped.watch_sync : null
  };
  const executionPolicy = {
    ...policy,
    chains: scoped ? scoped.chains
      : [...new Set([...policy.chains, ...dynamicPolicy.chains, ...followPolicy.chains])]
  };
  const [chainResult, uncertainResult, unprotectedResult, rate429Result, outboxResult,
    reconcilerStatus, chainConfigResult, invalidWhitelistResult, whitelistResult,
    relationResult, latestEvidenceResult, latencyResult, tradeEvidenceResult,
    readinessEvidenceResult, retryStatus, quarantineResult, acceptanceScope] = await Promise.all([
    db.query('SELECT * FROM chain_live_readiness ORDER BY chain'),
    db.query("SELECT COUNT(*)::int AS count FROM trade_attempts WHERE status IN ('submission_uncertain','reconciliation_required')"),
    db.query("SELECT COUNT(*)::int AS count FROM positions WHERE execution_mode = 'live' AND status = 'open_unprotected'"),
    db.query("SELECT MAX(created_at) AS last_at FROM provider_rate_events WHERE event_type = '429'"),
    db.query("SELECT COUNT(*)::int AS count FROM notification_outbox WHERE status IN ('pending','failed') AND next_attempt_at <= NOW()"),
    reconciler.getStatus(),
    db.query("SELECT value_json FROM config WHERE key = 'chain_configs'"),
    db.query(
      `SELECT COUNT(*)::int AS count FROM ca_whitelist
       WHERE status = 'active' AND id = ANY($1::int[])
         AND (budget_per_trade <= 0 OR total_budget <= 0 OR budget_per_trade > total_budget
              OR slippage <= 0 OR slippage > 100
              OR exit_strategy IS NULL
              OR CASE WHEN jsonb_typeof(exit_strategy->'legs') = 'array'
                THEN jsonb_array_length(exit_strategy->'legs') NOT BETWEEN 1 AND 10
                ELSE true END)`,
      [policy.whitelistIds.length > 0 ? policy.whitelistIds : [-1]]
    ),
    db.query(
      `SELECT whitelist.id, whitelist.chain_id, whitelist.contract_address, whitelist.symbol,
              whitelist.budget_per_trade, whitelist.total_budget, whitelist.auto_tp_pct,
              whitelist.auto_sl_pct, whitelist.exit_strategy,
              whitelist.exit_strategy_version, whitelist.slippage, whitelist.allow_repeat_buy,
              whitelist.max_repeat_buys, whitelist.expires_at,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'actor_handle', actor.x_handle,
                  'target_x_handle', relation.target_x_handle,
                  'event_types', relation.event_types
                ) ORDER BY lower(regexp_replace(actor.x_handle, '^@+', '')),
                           relation.target_x_handle)
                FROM x_signal_relations AS relation
                JOIN x_kol_accounts AS actor
                  ON actor.id = relation.kol_id AND actor.enabled = true
                WHERE relation.whitelist_id = whitelist.id AND relation.enabled = true
              ), '[]'::jsonb) AS relations,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'actor_handle', actor.x_handle,
                  'event_types', rule.event_types,
                  'match_mode', rule.match_mode,
                  'source_kind', rule.source_kind
                ) ORDER BY lower(regexp_replace(actor.x_handle, '^@+', '')))
                FROM x_signal_source_rules AS rule
                JOIN x_kol_accounts AS actor
                  ON actor.id = rule.actor_id AND actor.enabled = true
                WHERE rule.whitelist_id = whitelist.id AND rule.enabled = true
              ), '[]'::jsonb) AS direct_sources
       FROM ca_whitelist AS whitelist
       WHERE whitelist.status = 'active' AND whitelist.id = ANY($1::int[])
         AND whitelist.chain_id = ANY($2::text[])
       ORDER BY whitelist.id`,
      [policy.whitelistIds.length > 0 ? policy.whitelistIds : [-1],
        policy.chains.length > 0 ? policy.chains : ['__none__']]
    ),
    db.query(
      `SELECT relation.id, relation.whitelist_id, actor.x_handle AS actor_handle,
              relation.target_x_handle, relation.event_types, 'interaction' AS trigger_kind,
              NULL::text AS match_mode, NULL::text AS source_kind
       FROM x_signal_relations AS relation
       JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id AND actor.enabled = true
       WHERE relation.enabled = true AND relation.whitelist_id = ANY($1::int[])
       UNION ALL
       SELECT rule.id, rule.whitelist_id, actor.x_handle AS actor_handle,
              NULL::text AS target_x_handle, rule.event_types, 'direct_source' AS trigger_kind,
              rule.match_mode, rule.source_kind
       FROM x_signal_source_rules AS rule
       JOIN x_kol_accounts AS actor ON actor.id = rule.actor_id AND actor.enabled = true
       WHERE rule.enabled = true AND rule.whitelist_id = ANY($1::int[])
       ORDER BY whitelist_id, trigger_kind, id`,
      [policy.whitelistIds.length > 0 ? policy.whitelistIds : [-1]]
    ),
    db.query(
      `SELECT provider_event.provider_event_id, activity.id AS activity_id,
              signal.id AS signal_id, signal.status AS signal_status,
              attempt.id AS attempt_id, attempt.status AS attempt_status,
              orders.provider_order_id, orders.tx_hash,
              receipt.receipt_status,
              activity.source_created_at AS signal_source_created_at,
              signal.created_at AS signal_created_at
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
         percentile_cont(0.99) WITHIN GROUP (ORDER BY receive_to_swap_ms) AS receive_swap_p99,
         COUNT(receive_to_submitted_ms)::int AS receive_submitted_count,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY receive_to_submitted_ms) AS receive_submitted_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY receive_to_submitted_ms) AS receive_submitted_p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY receive_to_submitted_ms) AS receive_submitted_p99
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
         id, chain, evidence_type, status, created_at, summary_json,
         context_hash, valid_until, code_version
       FROM chain_readiness_evidence
       WHERE evidence_type = 'contract_probe'
       ORDER BY chain, evidence_type, created_at DESC, id DESC`
    ),
    tradeRetryOrchestrator.getStatus(),
    db.query("SELECT COUNT(*)::int AS count FROM wallet_write_lanes WHERE state = 'quarantined'"),
    liveApproval.getAcceptanceScope()
  ]);
  const chainRows = chainResult.rows;
  const chainConfigs = chainConfigResult.rows[0]?.value_json || {};
  const executionSettings = Object.fromEntries(Object.entries(chainConfigs).map(([chain, value]) => [
    chain,
    {
      retryEnabled: Boolean(value?.retryEnabled),
      maxRetries: Number(value?.maxRetries || 0),
      retryWindowMs: Number(value?.retryWindowMs || 0),
      failureEvidenceWindowMs: Number(value?.failureEvidenceWindowMs || 0),
      feeEscalationEnabled: Boolean(value?.feeEscalationEnabled),
      maxRetryFeeNative: Number(value?.maxRetryFeeNative || 0),
      exitGasReserve: Number(value?.exitGasReserve || 0)
    }
  ]));
  const mode = getTradingMode();
  const liveEnabled = enabled(process.env.LIVE_TRADING_ENABLED);
  const emergencyStop = enabled(process.env.EMERGENCY_STOP);
  const xProvider = String(process.env.X_DATA_PROVIDER || '').toLowerCase();
  const keyExclusive = enabled(process.env.GMGN_KEY_EXCLUSIVE);
  const scopeType = scoped?.scope_type || 'combined';
  const scopeIncludesFixed = ['combined', 'fixed_ca'].includes(scopeType);
  const scopeIncludesDynamic = ['combined', 'dynamic_policy'].includes(scopeType);
  const scopeIncludesFollow = ['combined', 'follow_discovery'].includes(scopeType);
  const selectedChains = new Set(executionPolicy.chains);
  const configurationFingerprint = hashSnapshot({
    mode,
    liveEnabled,
    emergencyStop,
    xProvider,
    keyExclusive,
    runtimeScope: {
      type: scopeType,
      id: scoped?.scope_id ?? null,
      chains: [...selectedChains].sort()
    },
    p20Features: scopeIncludesDynamic ? p20Features : null,
    p21FollowEnabled: scopeIncludesFollow ? followEnabled : null,
    credentials: hashSnapshot({
      profile: getGmgnCredentials().profile,
      apiKey: getGmgnCredentials().apiKey,
      privateKey: getGmgnCredentials().privateKey
    }),
    executionSettings: Object.fromEntries(Object.entries(executionSettings)
      .filter(([chain]) => selectedChains.has(chain))),
    chainRuntime: Object.fromEntries([...selectedChains].map((chain) => [chain, {
      rpc: process.env[`${chain === 'sol' ? 'SOLANA' : chain.toUpperCase()}_RPC_URL`] || '',
      feeReserve: process.env[`GMGN_MAX_FEE_RESERVE_${chain.toUpperCase()}`] || '',
      minimumGasReserve: process.env[`GMGN_MIN_GAS_RESERVE_${chain.toUpperCase()}`] || ''
    }]))
  });
  const ingestionHeartbeat = await latestHeartbeat(['ingestion', 'all']).catch(() => null);
  // Do not queue more GMGN probes after a 429 starts the scheduler cooldown.
  // A readiness check must fail promptly instead of waiting behind a multi-minute
  // cooldown for every whitelist quote and strategy query.
  const probeAllowed = options.probe && scheduler.getStatus().state !== 'cooling';
  const selectedChainRows = chainRows.filter((row) => selectedChains.has(row.chain));
  const probes = probeAllowed ? await probeChains(executionPolicy, selectedChainRows) : {};
  const probeCooling = options.probe && scheduler.getStatus().state === 'cooling';
  const contractProbes = options.probe && !probeCooling ? await probeContracts(whitelistResult.rows) : {};
  const rpcProbes = options.probe && !probeCooling ? await probePolicyRpcs(executionPolicy, probes) : {};
  if (options.probe && !probeCooling) await applyRpcBalanceFallback(probes, rpcProbes);
  const strategyProbes = options.probe && !probeCooling ? await probeStrategies(policy, probes) : {};
  const contractEvidence = options.probe && !probeCooling
    ? await persistContractProbeEvidence(
      policy,
      whitelistResult.rows,
      contractProbes,
      probes,
      db,
      { rpcProbes, strategyProbes, configurationFingerprint }
    )
    : {};
  const schedulerStatus = scheduler.getStatus();
  const cacheStatus = cache.status();
  const requiredKeys = requiredCacheKeys(whitelistResult.rows);
  const freshCacheKeys = new Set(
    cacheStatus.entries.filter((entry) => entry.fresh).map((entry) => entry.key)
  );
  const missingCacheKeys = requiredKeys.filter((key) => !freshCacheKeys.has(key));
  const last429At = rate429Result.rows[0].last_at;
  const recent429 = last429At && Date.now() - new Date(last429At).getTime() < 15 * 60_000;
  const credentials = getGmgnCredentials();
  const providerConfigured = Boolean(credentials.apiKey && credentials.privateKey);
  const ingestionHealthy = xProvider !== '6551' || Boolean(
    ingestionHeartbeat?.fresh && ingestionHeartbeat.status?.wss?.status === 'subscribed'
  );
  const alertsVerified = enabled(process.env.TRADE_ALERTS_VERIFIED);
  const tradeEvidenceByChain = new Map(
    tradeEvidenceResult.rows.map((row) => [row.chain, normalizeTradeEvidence(row)])
  );
  const evidenceWhitelistIds = [...new Set(readinessEvidenceResult.rows.flatMap(
    (row) => row.summary_json?.policy?.whitelistIds || []
  ).map(Number).filter(Number.isInteger))];
  const evidenceWhitelistRows = evidenceWhitelistIds.length > 0
    ? (await db.query(
      `SELECT whitelist.id, whitelist.chain_id, whitelist.contract_address,
              whitelist.budget_per_trade, whitelist.total_budget, whitelist.auto_tp_pct,
              whitelist.auto_sl_pct, whitelist.exit_strategy,
              whitelist.exit_strategy_version, whitelist.slippage, whitelist.allow_repeat_buy,
              whitelist.max_repeat_buys, whitelist.expires_at,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'actor_handle', actor.x_handle,
                  'target_x_handle', relation.target_x_handle,
                  'event_types', relation.event_types
                ) ORDER BY lower(regexp_replace(actor.x_handle, '^@+', '')),
                           relation.target_x_handle)
                FROM x_signal_relations AS relation
                JOIN x_kol_accounts AS actor
                  ON actor.id = relation.kol_id AND actor.enabled = true
                WHERE relation.whitelist_id = whitelist.id AND relation.enabled = true
              ), '[]'::jsonb) AS relations,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'actor_handle', actor.x_handle,
                  'event_types', rule.event_types,
                  'match_mode', rule.match_mode,
                  'source_kind', rule.source_kind
                ) ORDER BY lower(regexp_replace(actor.x_handle, '^@+', '')))
                FROM x_signal_source_rules AS rule
                JOIN x_kol_accounts AS actor
                  ON actor.id = rule.actor_id AND actor.enabled = true
                WHERE rule.whitelist_id = whitelist.id AND rule.enabled = true
              ), '[]'::jsonb) AS direct_sources
       FROM ca_whitelist AS whitelist
       WHERE whitelist.id = ANY($1::int[]) ORDER BY whitelist.id`,
      [evidenceWhitelistIds]
    )).rows
    : [];
  const persistedContractEvidence = new Map(readinessEvidenceResult.rows.map((row) => [
    row.chain,
    {
      id: row.id,
      type: row.evidence_type,
      status: row.status,
      createdAt: row.created_at,
      validUntil: row.valid_until,
      contextHash: row.context_hash,
      codeVersion: row.code_version,
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
    receiveToSwap: latencyMetric(latencyRow, 'receive_swap'),
    receiveToSubmitted: latencyMetric(latencyRow, 'receive_submitted')
  };
  latencySlo.passed = latencySlo.signal.count >= latencySlo.requiredSamples
    && latencySlo.execution.count >= latencySlo.requiredSamples
    && latencySlo.signal.p95 !== null && latencySlo.signal.p95 <= 300
    && latencySlo.execution.p95 !== null && latencySlo.execution.p95 <= 300;

  const chains = CHAINS.filter((chain) => selectedChains.has(chain)).map((chain) => {
    const row = chainRows.find((item) => item.chain === chain) || { chain };
    const chainDefinition = CHAIN_REGISTRY[chain];
    const failureCircuit = retryStatus.circuits?.find((item) => item.chain === chain) || null;
    const implemented = Boolean(chainDefinition.executionImplemented && (row.implemented || probes[chain]?.ok));
    const evidence = contractEvidence[chain] || persistedContractEvidence.get(chain) || null;
    const evidenceIds = new Set((evidence?.whitelistIds || []).map(Number));
    const selectedWhitelists = contractEvidence[chain]
      ? whitelistResult.rows.filter((item) => item.chain_id === chain)
      : evidenceWhitelistRows.filter(
        (item) => item.chain_id === chain && evidenceIds.has(Number(item.id))
      );
    const evidenceFresh = Boolean(
      evidence?.status === 'passed'
      && evidence?.validUntil
      && new Date(evidence.validUntil).getTime() > Date.now()
      && evidence?.codeVersion === liveApproval.codeVersion()
    );
    const expectedContext = selectedWhitelists.length > 0
      && selectedWhitelists.length === evidenceIds.size
      ? liveApproval.contractContext(chain, selectedWhitelists).contextHash
      : null;
    const evidenceCurrent = Boolean(
      evidenceFresh && expectedContext && evidence.contextHash === expectedContext
    );
    const currentProbeEvidence = contractEvidence[chain] || null;
    const contractTested = currentProbeEvidence
      ? currentProbeEvidence.status === 'passed'
      : Boolean(evidenceCurrent || row.contract_tested);
    const contractApproved = contractApprovalReady(row, evidenceCurrent)
      || currentProbeEvidence?.status === 'passed';
    const acceptanceAuthorized = Boolean(
      acceptanceScope
      && !acceptanceScope.expired
      && acceptanceScope.chain === chain
      && policy.whitelistIds.includes(Number(acceptanceScope.whitelist_id))
    );
    const blockers = [];
    const advisories = [];
    if (!implemented) blockers.push('CHAIN_NOT_IMPLEMENTED');
    const contractRequired = scopeIncludesFixed
      && policy.chains.includes(chain)
      && whitelistResult.rows.some((whitelist) => whitelist.chain_id === chain);
    if (contractRequired && !contractApproved) blockers.push('CHAIN_CONTRACT_NOT_TESTED');
    if (!row.live_enabled && !acceptanceAuthorized) blockers.push('CHAIN_PRODUCTION_NOT_APPROVED');
    if (!row.shadow_verified) advisories.push('CHAIN_SHADOW_NOT_VERIFIED');
    if (failureCircuit?.state === 'tripped') blockers.push('CHAIN_CONSECUTIVE_FAILURE_LOCK');
    if (retryStatus.quarantines?.some((item) => item.chain === chain)) {
      blockers.push('WALLET_QUARANTINE_ACTIVE');
    }
    if (!rpcConfig(chain).url) blockers.push('CHAIN_RPC_MISSING');
    const feeReserveValue = Number(process.env[`GMGN_MAX_FEE_RESERVE_${chain.toUpperCase()}`]);
    const minimumGasReserveValue = Number(process.env[`GMGN_MIN_GAS_RESERVE_${chain.toUpperCase()}`]);
    if (!Number.isFinite(feeReserveValue) || feeReserveValue <= 0) {
      blockers.push('CHAIN_FEE_RESERVE_MISSING');
    }
    if (!Number.isFinite(minimumGasReserveValue) || minimumGasReserveValue <= 0) {
      blockers.push('CHAIN_GAS_RESERVE_MISSING');
    }
    const limits = chainConfigs[chain] || {};
    if (options.probe && executionPolicy.chains.includes(chain)) {
      const nativeBalance = probes[chain]?.nativeBalance;
      const maximumWhitelistTrade = whitelistResult.rows
        .filter((whitelist) => whitelist.chain_id === chain)
        .reduce((maximum, whitelist) => Math.max(maximum, Number(whitelist.budget_per_trade || 0)), 0);
      const maximumTrade = Math.max(
        maximumWhitelistTrade,
        Number(dynamicPolicy.maxTradeByChain[chain] || 0),
        Number(followPolicy.maxTradeByChain[chain] || 0)
      );
      const requiredBalance = maximumTrade + minimumGasReserveValue + feeReserveValue;
      if (!Number.isFinite(nativeBalance)) blockers.push('CHAIN_NATIVE_BALANCE_UNKNOWN');
      else if (nativeBalance < requiredBalance) blockers.push('CHAIN_NATIVE_BALANCE_INSUFFICIENT');
    }
    if (options.probe && probes[chain] && !probes[chain].ok) blockers.push(probes[chain].error);
    if (options.probe && executionPolicy.chains.includes(chain) && !rpcProbes[chain]?.ok) {
      blockers.push(rpcProbes[chain]?.error || 'CHAIN_RPC_UNAVAILABLE');
    }
    const chainReadiness = splitChainReadiness(blockers);
    const strategyReady = strategyChainReady(chainReadiness, {
      dynamicEnabled: dynamicPolicy.chains.includes(chain),
      followEnabled: followPolicy.chains.includes(chain)
    });
    return {
      ...row,
      implemented,
      wallet_address: probes[chain]?.wallet || row.wallet_address || null,
      native_balances: probes[chain]?.balances || row.balances_json || [],
      native_balance: probes[chain]?.ok ? probes[chain].nativeBalance : row.native_balance,
      last_error: probes[chain]?.ok ? null : (probes[chain]?.error || row.last_error || null),
      contract_tested: contractTested,
      code_capable: implemented,
      production_approved: Boolean(row.live_enabled),
      acceptance_status: acceptanceAuthorized ? 'active' : (acceptanceScope?.chain === chain
        ? (acceptanceScope.expired ? 'expired' : acceptanceScope.status)
        : 'none'),
      contract_evidence: evidence ? { ...evidence, stale: !evidenceCurrent } : null,
      rpc_probe: rpcProbes[chain] || null,
      policy_enabled: policy.chains.includes(chain),
      dynamic_policy_enabled: dynamicPolicy.chains.includes(chain),
      follow_policy_enabled: followPolicy.chains.includes(chain),
      trade_evidence: tradeEvidenceByChain.get(chain) || normalizeTradeEvidence(),
      failure_circuit: failureCircuit,
      limits: executionSettings[chain] || {},
      blockers,
      advisories,
      infrastructure_ready: chainReadiness.infrastructureReady,
      strategy_ready: strategyReady,
      contract_approved: contractApproved,
      ready: chainReadiness.fixedReady && (
        scoped ? scoped.chains.includes(chain)
          : policy.chains.includes(chain) || dynamicPolicy.chains.includes(chain)
            || followPolicy.chains.includes(chain)
      )
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
  const providerHistoryGate = providerHistoryReadiness(recent429);
  blockers.push(...providerHistoryGate.blockers);
  advisories.push(...providerHistoryGate.advisories);
  if (options.probe && missingCacheKeys.length > 0) advisories.push('FAST_PATH_CACHE_NOT_READY');
  if (options.probe && Object.values(contractProbes).some((probe) => !probe.ok)) {
    blockers.push('CONTRACT_PROBE_FAILED');
  }
  if (options.probe && Object.values(strategyProbes).some((probe) => !probe.ok)) {
    blockers.push('STRATEGY_PROBE_FAILED');
  }
  if (scopeIncludesFixed && acceptanceScope?.expired) blockers.push('LIVE_ACCEPTANCE_SCOPE_EXPIRED');
  if (Number(uncertainResult.rows[0].count) > 0) blockers.push('UNRESOLVED_TRADE_ATTEMPTS');
  if (Number(quarantineResult.rows[0].count) > 0) advisories.push('WALLET_QUARANTINE_ACTIVE');
  if (Number(unprotectedResult.rows[0].count) > 0) blockers.push('UNPROTECTED_LIVE_POSITIONS');
  const fixedPolicyConfigured = Array.isArray(policy.providers) && policy.providers.length > 0
    && Array.isArray(policy.eventTypes) && policy.eventTypes.length > 0
    && Array.isArray(policy.whitelistIds) && policy.whitelistIds.length > 0;
  if (scopeType === 'combined' && !fixedPolicyConfigured
      && dynamicPolicy.configuredRows === 0 && followPolicy.configuredRows === 0) {
    blockers.push('LIVE_POLICY_EMPTY');
  }
  if (scopeType === 'dynamic_policy' && (!scoped.enabled || scoped.mode !== 'live')) {
    blockers.push('DYNAMIC_POLICY_NOT_LIVE');
  }
  if (scopeIncludesDynamic && dynamicPolicy.configuredRows > 0 && !dynamicPolicy.runtimeEnabled) {
    blockers.push('P20_LIVE_DISABLED');
  }
  if (scopeIncludesDynamic && dynamicPolicy.runtimeEnabled && dynamicPolicy.invalidRows > 0) {
    blockers.push('DYNAMIC_POLICY_CONFIG_INVALID');
  }
  if (policy.whitelistIds.length > 0 && whitelistResult.rows.length !== policy.whitelistIds.length) {
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
  if (scopeIncludesFollow && followPolicy.configuredRows > 0 && !followPolicy.runtimeEnabled) {
    blockers.push('P21_FOLLOW_DISCOVERY_DISABLED');
  }
  if (scopeIncludesFollow && followPolicy.runtimeEnabled && followPolicy.invalidRows > 0) {
    blockers.push('FOLLOW_POLICY_CONFIG_INVALID');
  }
  if (scopeIncludesFollow && followPolicy.unsyncedRows > 0) {
    blockers.push('FOLLOW_WATCH_NOT_SYNCED');
  }
  if (scopeType === 'follow_discovery') {
    if (followPolicy.configuredRows === 0 || !scoped.enabled || scoped.mode !== 'live') {
      blockers.push('FOLLOW_POLICY_NOT_LIVE');
    }
    if (followPolicy.chains.length === 0) blockers.push('FOLLOW_SCOPE_CHAIN_MISSING');
  }
  const selectedChainReady = chains.some((chain) => {
    if (!executionPolicy.chains.includes(chain.chain)) return false;
    return scopeType === 'fixed_ca' ? chain.ready : chain.infrastructure_ready;
  });
  if (executionPolicy.chains.length === 0 || !selectedChainReady) blockers.push('NO_LIVE_CHAIN_READY');
  if (Number(invalidWhitelistResult.rows[0].count) > 0) blockers.push('WHITELIST_HARD_LIMIT_INVALID');
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
      walletQuarantines: Number(quarantineResult.rows[0].count),
      unprotectedPositions: Number(unprotectedResult.rows[0].count),
      pendingAlerts: Number(outboxResult.rows[0].count)
    },
    chains,
    retry: retryStatus,
    scheduler: schedulerStatus,
    cache: cacheStatus,
    cacheRequired: {
      total: requiredKeys.length,
      missing: missingCacheKeys,
      ready: missingCacheKeys.length === 0
    },
    latencySlo,
    contractProbes,
    strategyProbes,
    rpcProbes,
    acceptanceScope,
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
    dynamicPolicy,
    followPolicy,
    relations: relationResult.rows.map((row) => ({
      id: Number(row.id),
      whitelistId: Number(row.whitelist_id),
      actorHandle: row.actor_handle,
      targetHandle: row.target_x_handle,
      eventTypes: row.event_types || [],
      triggerKind: row.trigger_kind || 'interaction',
      matchMode: row.match_mode || null,
      sourceKind: row.source_kind || null
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
      signalSourceCreatedAt: latestEvidenceResult.rows[0].signal_source_created_at || null,
      signalCreatedAt: latestEvidenceResult.rows[0].signal_created_at || null
    } : null,
    pollingPolicy: reconcilerStatus.pollingPolicy
  };
  snapshot.scope = scoped || {
    scope_type: 'combined',
    scope_id: null,
    chains: executionPolicy.chains,
    whitelist_ids: policy.whitelistIds,
    manifest_hash: hashSnapshot({ type: 'combined', policy, dynamicPolicy })
  };
  snapshot.provider = {
    cooldown_until: schedulerStatus.cooldownUntil || schedulerStatus.resetAt || null,
    affected: schedulerStatus.state === 'cooling' ? [snapshot.scope.scope_type] : [],
    advisories: snapshot.advisories.filter((code) => code.startsWith('GMGN_'))
  };
  snapshot.checks.probed = Boolean(options.probe);
  snapshot.checks.scope = snapshot.scope.scope_type;
  snapshot.snapshotHash = hashSnapshot(snapshot);
  latestSnapshot = snapshot;
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
    this.onRecover = options.onRecover || (async (details) => {
      await db.query(
        `INSERT INTO notification_outbox(topic, aggregate_type, aggregate_id, payload)
         VALUES ('trade.auto_resumed', 'system', 'readiness', $1)`,
        [details]
      );
    });
    this.onReminder = options.onReminder || (async (details) => {
      await db.query(
        `INSERT INTO notification_outbox(topic, aggregate_type, aggregate_id, payload)
         VALUES ('trade.transient_pause_reminder', 'system', 'readiness', $1)`,
        [details]
      );
    });
    this.intervalMs = Math.max(500, Number(options.intervalMs || 1000));
    this.recoveryHealthyChecks = Math.max(1, Number(options.recoveryHealthyChecks || 3));
    this.transientReminderMs = Math.max(
      1000,
      Number(options.transientReminderMs || options.transientTimeoutMs || 5 * 60_000)
    );
    this.now = options.now || (() => Date.now());
    this.lastTransientReminderAt = null;
    this.healthyCount = 0;
    this.timer = null;
    this.lastError = null;
  }

  async checkOnce() {
    const engineStatus = this.engine.getStatus?.() || {};
    const transientPaused = engineStatus.status === 'paused_transient' && engineStatus.desiredRunning;
    if (!this.engine.getArmed() && !transientPaused) {
      this.healthyCount = 0;
      return { status: 'skipped', reason: 'not_armed' };
    }
    try {
      const scope = this.engine.getScopeInput?.();
      const snapshot = await this.snapshotProvider(scope ? { scope } : {});
      executionGateService.update(snapshot);
      if (snapshot.readyToArm) {
        if (!transientPaused) return { status: 'ready', snapshot };
        this.healthyCount += 1;
        if (this.healthyCount < this.recoveryHealthyChecks) {
          return { status: 'recovering', healthyChecks: this.healthyCount, snapshot };
        }
        await this.engine.recoverTransient(snapshot);
        this.healthyCount = 0;
        this.lastTransientReminderAt = null;
        await this.onRecover({
          reason: 'TRANSIENT_READINESS_RECOVERED',
          snapshot_hash: snapshot.snapshotHash || null,
          generated_at: snapshot.generatedAt || new Date()
        });
        return { status: 'resumed', snapshot };
      }
      this.healthyCount = 0;
      const blockers = [...new Set(snapshot.blockers || [])];
      const transientOnly = blockers.length > 0
        && blockers.every((blocker) => TRANSIENT_BLOCKERS.has(blocker));
      if (transientOnly) {
        const now = this.now();
        const startedAt = engineStatus.transientStartedAt
          ? new Date(engineStatus.transientStartedAt).getTime()
          : now;
        const reminderDue = transientPaused
          && now - startedAt >= this.transientReminderMs
          && (this.lastTransientReminderAt === null
            || now - this.lastTransientReminderAt >= this.transientReminderMs);
        if (reminderDue) {
          this.lastTransientReminderAt = now;
          await this.onReminder({
            reason: 'TRANSIENT_READINESS_WAITING', blockers,
            paused_since: new Date(startedAt),
            snapshot_hash: snapshot.snapshotHash || null,
            generated_at: snapshot.generatedAt || new Date()
          });
        }
        if (!transientPaused) {
          await this.engine.pauseTransient({
            reason: 'TRANSIENT_READINESS_FAILURE',
            details: { blockers, snapshot_hash: snapshot.snapshotHash }
          });
          await this.onDisarm({
            reason: 'TRANSIENT_READINESS_FAILURE', blockers,
            snapshot_hash: snapshot.snapshotHash || null,
            generated_at: snapshot.generatedAt || new Date()
          });
          this.lastTransientReminderAt = now;
        }
        return { status: 'paused_transient', reminder: reminderDue, snapshot };
      }
      this.lastTransientReminderAt = null;
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
  TRANSIENT_BLOCKERS,
  applyRpcBalanceFallback,
  dynamicLivePolicyState,
  followLivePolicyState,
  getSnapshot,
  getLatestSnapshot,
  schedulerReadiness,
  providerHistoryReadiness,
  strategyChainReady,
  contractApprovalReady,
  splitChainReadiness,
  jsonb,
  monitor,
  normalizeTradeEvidence,
  persistContractProbeEvidence,
  runDiagnostic
};
