const crypto = require('crypto');
const db = require('../../lib/db');
const engineState = require('../../lib/engine-state');
const { CHAIN_REGISTRY } = require('../../lib/chain-config');
const { codeVersion } = require('../../lib/code-version');

const REQUIRED_MIGRATION = '020_p16_1_prelaunch_project_monitor.sql';
const CONTRACT_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACCEPTANCE_MINUTES = 30;

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function walletReference(address) {
  const value = String(address || '').trim().toLowerCase();
  return value ? `wallet:${hash(value).slice(0, 16)}` : null;
}

function contractContext(chain, whitelists = []) {
  const definition = CHAIN_REGISTRY[chain];
  if (!definition) {
    const error = new Error(`Unsupported chain: ${chain}`);
    error.code = 'CHAIN_UNSUPPORTED';
    throw error;
  }
  const contracts = whitelists
    .map((item) => {
      const relations = (Array.isArray(item.relations) ? item.relations : [])
        .map((relation) => ({
          actorHandle: String(relation.actor_handle || '').trim().replace(/^@+/, '').toLowerCase(),
          targetHandle: String(relation.target_x_handle || '').trim().replace(/^@+/, '').toLowerCase(),
          eventTypes: [...new Set((relation.event_types || []).map((event) => (
            String(event || '').trim().toLowerCase()
          )))].sort()
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const directSources = (Array.isArray(item.direct_sources) ? item.direct_sources : [])
        .map((source) => ({
          actorHandle: String(source.actor_handle || '').trim().replace(/^@+/, '').toLowerCase(),
          eventTypes: [...new Set((source.event_types || []).map((event) => (
            String(event || '').trim().toLowerCase()
          )))].sort(),
          matchMode: String(source.match_mode || 'ca_only').toLowerCase(),
          sourceKind: String(source.source_kind || 'project').toLowerCase()
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      return {
        whitelistId: Number(item.id),
        contractAddress: String(item.contract_address || '').trim(),
        budgetPerTrade: String(item.budget_per_trade ?? ''),
        totalBudget: String(item.total_budget ?? ''),
        takeProfitPct: String(item.auto_tp_pct ?? ''),
        stopLossPct: String(item.auto_sl_pct ?? ''),
        exitStrategy: item.exit_strategy || null,
        exitStrategyVersion: Number(item.exit_strategy_version || 1),
        slippagePct: String(item.slippage ?? ''),
        allowRepeatBuy: Boolean(item.allow_repeat_buy),
        maxRepeatBuys: Number(item.max_repeat_buys || 1),
        expiresAt: item.expires_at ? new Date(item.expires_at).toISOString() : null,
        relations,
        directSources
      };
    })
    .sort((left, right) => left.whitelistId - right.whitelistId);
  const environment = {
    rpcUrlHash: hash(process.env[definition.rpcEnvKey] || ''),
    maxFeeReserve: process.env[`GMGN_MAX_FEE_RESERVE_${chain.toUpperCase()}`] || '',
    minimumGasReserve: process.env[`GMGN_MIN_GAS_RESERVE_${chain.toUpperCase()}`] || '',
    gmgnCredentialsHash: hash({
      apiKey: process.env.GMGN_API_KEY || '',
      privateKey: process.env.GMGN_PRIVATE_KEY || ''
    })
  };
  const context = {
    chain,
    chainId: definition.chainId || null,
    codeVersion: codeVersion(),
    migration: REQUIRED_MIGRATION,
    contracts,
    environment
  };
  return { ...context, contextHash: hash(context) };
}

async function getAcceptanceScope(executor = db) {
  const result = await executor.query(
    `SELECT scope.*, whitelist.chain_id, whitelist.status AS whitelist_status,
            whitelist.contract_address, whitelist.symbol
     FROM live_acceptance_scopes AS scope
     JOIN ca_whitelist AS whitelist ON whitelist.id = scope.whitelist_id
     WHERE scope.status = 'active'
     ORDER BY scope.id DESC LIMIT 1`
  );
  const scope = result.rows[0] || null;
  return scope ? {
    ...scope,
    expired: new Date(scope.expires_at).getTime() <= Date.now()
  } : null;
}

async function expireAcceptanceScopes(executor = db) {
  const result = await executor.query(
    `UPDATE live_acceptance_scopes
     SET status = 'cancelled', completion_reason = 'EXPIRED',
         completed_at = NOW(), updated_at = NOW()
     WHERE status = 'active' AND expires_at <= NOW()
     RETURNING *`
  );
  return result.rows;
}

async function latestValidContractEvidence(chain, whitelistId, executor = db) {
  const result = await executor.query(
    `SELECT evidence.*
     FROM chain_readiness_evidence AS evidence
     WHERE evidence.chain = $1
       AND evidence.evidence_type = 'contract_probe'
       AND evidence.status = 'passed'
       AND evidence.valid_until > NOW()
       AND (
         evidence.whitelist_id = $2
         OR COALESCE(evidence.summary_json->'policy'->'whitelistIds', '[]'::jsonb)
              @> jsonb_build_array($2::int)
       )
     ORDER BY evidence.created_at DESC, evidence.id DESC LIMIT 1`,
    [chain, Number(whitelistId)]
  );
  return result.rows[0] || null;
}

function assertEngineStopped() {
  const status = engineState.getStatus();
  if (status.armed || status.desiredRunning) {
    const error = new Error('Live engine must be stopped before changing chain approval');
    error.code = 'ENGINE_MUST_BE_STOPPED';
    throw error;
  }
}

function assertAcceptanceEnvironment(chain) {
  const definition = CHAIN_REGISTRY[chain];
  const rpcUrl = definition ? String(process.env[definition.rpcEnvKey] || '').trim() : '';
  const maxFeeReserve = Number(process.env[`GMGN_MAX_FEE_RESERVE_${chain.toUpperCase()}`]);
  const minimumGasReserve = Number(process.env[`GMGN_MIN_GAS_RESERVE_${chain.toUpperCase()}`]);
  const missing = [];
  if (!rpcUrl) missing.push(definition?.rpcEnvKey || 'RPC_URL');
  if (!Number.isFinite(maxFeeReserve) || maxFeeReserve <= 0) {
    missing.push(`GMGN_MAX_FEE_RESERVE_${chain.toUpperCase()}`);
  }
  if (!Number.isFinite(minimumGasReserve) || minimumGasReserve <= 0) {
    missing.push(`GMGN_MIN_GAS_RESERVE_${chain.toUpperCase()}`);
  }
  if (missing.length > 0) {
    const error = new Error(`Live acceptance environment is incomplete: ${missing.join(', ')}`);
    error.code = 'ACCEPTANCE_ENVIRONMENT_INCOMPLETE';
    error.details = { missing };
    throw error;
  }
}

async function startAcceptanceScope(options, executor = db) {
  assertEngineStopped();
  const chain = String(options.chain || '').trim().toLowerCase();
  const whitelistId = Number(options.whitelistId);
  const durationMinutes = Math.max(1, Math.min(
    MAX_ACCEPTANCE_MINUTES,
    Number(options.durationMinutes || MAX_ACCEPTANCE_MINUTES)
  ));
  const definition = CHAIN_REGISTRY[chain];
  if (!definition?.executionImplemented || !Number.isInteger(whitelistId)) {
    const error = new Error('Acceptance scope requires an executable chain and one whitelist');
    error.code = 'ACCEPTANCE_SCOPE_INVALID';
    throw error;
  }
  assertAcceptanceEnvironment(chain);
  const whitelistResult = await executor.query(
    `SELECT whitelist.*,
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
     WHERE whitelist.id = $1 AND whitelist.chain_id = $2
       AND whitelist.status = 'active'
       AND (whitelist.expires_at IS NULL OR whitelist.expires_at > NOW())
       AND (
         EXISTS (
           SELECT 1 FROM x_signal_relations AS relation
           JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id AND actor.enabled = true
           WHERE relation.whitelist_id = whitelist.id AND relation.enabled = true
         )
         OR EXISTS (
           SELECT 1 FROM x_signal_source_rules AS rule
           JOIN x_kol_accounts AS actor ON actor.id = rule.actor_id AND actor.enabled = true
           WHERE rule.whitelist_id = whitelist.id AND rule.enabled = true
         )
       )`,
    [whitelistId, chain]
  );
  const whitelist = whitelistResult.rows[0];
  if (!whitelist) {
    const error = new Error('Acceptance whitelist or active relation not found');
    error.code = 'ACCEPTANCE_WHITELIST_INVALID';
    throw error;
  }
  const readinessResult = await executor.query(
    'SELECT * FROM chain_live_readiness WHERE chain = $1',
    [chain]
  );
  const readiness = readinessResult.rows[0];
  if (!readiness?.implemented || !readiness?.contract_tested) {
    const error = new Error('Chain contract validation must pass before live acceptance');
    error.code = 'CHAIN_CONTRACT_NOT_TESTED';
    throw error;
  }
  const evidence = await latestValidContractEvidence(chain, whitelistId, executor);
  const context = contractContext(chain, [whitelist]);
  if (!evidence || evidence.context_hash !== context.contextHash) {
    const error = new Error('Contract evidence is missing, expired, or stale for this configuration');
    error.code = 'CONTRACT_EVIDENCE_STALE';
    throw error;
  }
  const activeScope = await getAcceptanceScope(executor);
  if (activeScope && !activeScope.expired) {
    const error = new Error('Another live acceptance scope is already active');
    error.code = 'ACCEPTANCE_SCOPE_ALREADY_ACTIVE';
    throw error;
  }
  await expireAcceptanceScopes(executor);
  const result = await executor.query(
    `INSERT INTO live_acceptance_scopes(
       chain, whitelist_id, contract_evidence_id, context_hash,
       expires_at, created_by
     ) VALUES ($1,$2,$3,$4,NOW() + ($5::double precision * interval '1 minute'),$6)
     RETURNING *`,
    [chain, whitelistId, evidence.id, context.contextHash, durationMinutes, options.operator]
  );
  return result.rows[0];
}

async function finishAcceptanceScope(options = {}, executor = db) {
  assertEngineStopped();
  const result = await executor.query(
    `UPDATE live_acceptance_scopes
     SET status = $1, completed_by = $2, completion_reason = $3,
         completed_at = NOW(), updated_at = NOW()
     WHERE status = 'active'
     RETURNING *`,
    [options.completed ? 'completed' : 'cancelled', options.operator, options.reason || null]
  );
  return result.rows[0] || null;
}

async function approveProduction(chain, operator, executor = db) {
  assertEngineStopped();
  const normalized = String(chain || '').trim().toLowerCase();
  const definition = CHAIN_REGISTRY[normalized];
  if (!definition?.executionImplemented) {
    const error = new Error('Chain execution capability is not implemented');
    error.code = 'CHAIN_NOT_IMPLEMENTED';
    throw error;
  }
  const activeScope = await getAcceptanceScope(executor);
  if (activeScope) {
    const error = new Error('Finish the live acceptance scope before production approval');
    error.code = activeScope.expired
      ? 'ACCEPTANCE_SCOPE_EXPIRED'
      : 'ACCEPTANCE_SCOPE_STILL_ACTIVE';
    throw error;
  }
  const completedScopeResult = await executor.query(
    `SELECT scope.*, whitelist.id AS current_whitelist_id,
            whitelist.chain_id, whitelist.contract_address,
            whitelist.budget_per_trade, whitelist.total_budget,
            whitelist.auto_tp_pct, whitelist.auto_sl_pct, whitelist.exit_strategy,
            whitelist.exit_strategy_version, whitelist.slippage,
            whitelist.allow_repeat_buy, whitelist.max_repeat_buys, whitelist.expires_at,
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
            ), '[]'::jsonb) AS direct_sources,
            contract_evidence.context_hash AS evidence_context_hash,
            contract_evidence.status AS evidence_status,
            contract_evidence.valid_until AS evidence_valid_until,
            contract_evidence.code_version AS evidence_code_version
     FROM live_acceptance_scopes AS scope
     JOIN ca_whitelist AS whitelist ON whitelist.id = scope.whitelist_id
     JOIN chain_readiness_evidence AS contract_evidence
       ON contract_evidence.id = scope.contract_evidence_id
     WHERE scope.chain = $1 AND scope.status = 'completed'
     ORDER BY scope.completed_at DESC, scope.id DESC LIMIT 1`,
    [normalized]
  );
  const completedScope = completedScopeResult.rows[0];
  const currentContext = completedScope
    ? contractContext(normalized, [{
      ...completedScope,
      id: completedScope.current_whitelist_id
    }])
    : null;
  if (!completedScope
      || completedScope.evidence_status !== 'passed'
      || new Date(completedScope.evidence_valid_until).getTime() <= Date.now()
      || completedScope.evidence_code_version !== codeVersion()
      || completedScope.context_hash !== currentContext.contextHash
      || completedScope.evidence_context_hash !== currentContext.contextHash) {
    const error = new Error('Completed acceptance and current contract evidence are required');
    error.code = 'ACCEPTANCE_EVIDENCE_STALE';
    throw error;
  }
  const result = await executor.query(
    `UPDATE chain_live_readiness AS readiness
     SET live_enabled = true, updated_at = NOW()
     WHERE readiness.chain = $1
       AND readiness.implemented = true
       AND readiness.contract_tested = true
       AND EXISTS (
         SELECT 1 FROM chain_readiness_evidence AS evidence
         JOIN live_acceptance_scopes AS scope
           ON scope.whitelist_id = evidence.whitelist_id
          AND scope.chain = evidence.chain
          AND scope.id = $3
          AND scope.status = 'completed'
          AND evidence.created_at >= scope.created_at
          AND evidence.created_at <= COALESCE(scope.completed_at, NOW())
          AND evidence.created_at <= scope.expires_at
         JOIN chain_readiness_evidence AS contract_evidence
           ON contract_evidence.id = scope.contract_evidence_id
         WHERE evidence.chain = readiness.chain
           AND evidence.evidence_type = 'manual_e2e'
           AND evidence.status = 'passed'
           AND evidence.summary_json->>'complete' = 'true'
           AND evidence.code_version = $2
           AND contract_evidence.status = 'passed'
           AND contract_evidence.valid_until > NOW()
           AND contract_evidence.code_version = $2
       )
     RETURNING *`,
    [normalized, codeVersion(), completedScope.id]
  );
  if (result.rows.length === 0) {
    const error = new Error('Complete Buy/Close evidence for the current code version is required');
    error.code = 'MANUAL_E2E_EVIDENCE_REQUIRED';
    throw error;
  }
  await executor.query(
    `INSERT INTO system_logs(level, module, message, meta)
     VALUES ('audit','chain-approval','CHAIN_PRODUCTION_APPROVED',$1)`,
    [{ chain: normalized, operator, code_version: codeVersion() }]
  );
  return result.rows[0];
}

module.exports = {
  CONTRACT_EVIDENCE_TTL_MS,
  MAX_ACCEPTANCE_MINUTES,
  REQUIRED_MIGRATION,
  approveProduction,
  assertAcceptanceEnvironment,
  codeVersion,
  contractContext,
  expireAcceptanceScopes,
  finishAcceptanceScope,
  getAcceptanceScope,
  hash,
  latestValidContractEvidence,
  startAcceptanceScope,
  walletReference
};
