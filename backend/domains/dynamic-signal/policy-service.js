const crypto = require('crypto');
const db = require('../../lib/db');
const { normalizeXHandle } = require('../../lib/x-handles');
const { normalizeApprovedNameMatchKey } = require('./content-extractor');
const presetRouteRepository = require('./preset-route-repository');
const {
  normalizePresetRoutes,
  routeError,
  routeExecutionSnapshot
} = require('./preset-route-schema');
const { prepareVerifiedRoutes } = require('./preset-route-verification');
const {
  clonePreset,
  normalizeExitStrategy
} = require('../trade/exit-strategy-compiler');

const MODES = new Set(['record', 'paper', 'live', 'paused']);
const CHAINS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood']);
const EVENTS = new Set(['tweet', 'quote', 'reply']);
const TERMS = new Set(['ca', 'cashtag', 'hashtag', 'approved_name']);

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]));
}

function contextHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(sortedObject(value))).digest('hex');
}

function uniqueAllowed(values, allowed, field, required = false) {
  const output = [...new Set((Array.isArray(values) ? values : []).map((item) => (
    String(item || '').trim().toLowerCase()
  )).filter(Boolean))].sort();
  if ((required && output.length === 0) || output.some((item) => !allowed.has(item))) {
    const error = new Error(`Invalid dynamic policy field: ${field}`);
    error.code = 'DYNAMIC_POLICY_INVALID';
    throw error;
  }
  return output;
}

function invalidPolicyField(field) {
  const error = new Error(`Invalid dynamic policy field: ${field}`);
  error.code = 'DYNAMIC_POLICY_INVALID';
  return error;
}

function normalizeBudgetValue(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw invalidPolicyField(field);
  return number;
}

function normalizeChainBudgets(inputValue, current, allowedChainIds, legacyDefaults) {
  const hasExplicitMatrix = inputValue !== undefined;
  const legacyOverride = current?.inputHasLegacyOverride;
  const source = hasExplicitMatrix
    ? inputValue
    : (legacyOverride ? null : current?.chain_budgets);
  if (source !== undefined && source !== null
      && (typeof source !== 'object' || Array.isArray(source))) {
    throw invalidPolicyField('chain_budgets');
  }
  const sourceKeys = Object.keys(source || {});
  if (sourceKeys.some((chain) => !CHAINS.has(chain))) throw invalidPolicyField('chain_budgets');
  const result = {};
  for (const chain of allowedChainIds) {
    const raw = source?.[chain];
    if (hasExplicitMatrix && !raw) throw invalidPolicyField(`chain_budgets.${chain}`);
    const budget = raw || {
      budget_per_trade: legacyDefaults.budgetPerTrade,
      daily_budget: legacyDefaults.dailyBudget
    };
    result[chain] = {
      budget_per_trade: normalizeBudgetValue(budget.budget_per_trade, `chain_budgets.${chain}.budget_per_trade`),
      daily_budget: normalizeBudgetValue(budget.daily_budget, `chain_budgets.${chain}.daily_budget`)
    };
  }
  return result;
}

function chainBudgetFor(policy, chainId) {
  const chain = String(chainId || '').trim().toLowerCase();
  const budget = policy?.chain_budgets?.[chain];
  if (budget && Number.isFinite(Number(budget.budget_per_trade))
      && Number.isFinite(Number(budget.daily_budget))) {
    return {
      budget_per_trade: Number(budget.budget_per_trade),
      daily_budget: Number(budget.daily_budget)
    };
  }
  return null;
}

function normalizeDynamicExitStrategy(value) {
  const emptyObject = value && typeof value === 'object'
    && !Array.isArray(value) && !value.legs;
  const candidate = value === undefined || value === null || emptyObject
    ? clonePreset('principal_no_stop') : value;
  return normalizeExitStrategy(candidate);
}

function normalizeApprovedAliases(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) {
    const error = new Error('Dynamic policy aliases must be an array with at most 50 items');
    error.code = 'DYNAMIC_POLICY_INVALID';
    throw error;
  }
  const aliases = [];
  const seen = new Map();
  for (const [index, raw] of value.entries()) {
    const name = String(typeof raw === 'string' ? raw : raw?.name ?? raw?.value ?? '')
      .trim().replace(/\s+/g, ' ');
    if (!name || name.length > 80) {
      const error = new Error('Dynamic policy aliases must contain 1-80 characters');
      error.code = 'DYNAMIC_POLICY_INVALID';
      throw error;
    }
    const key = normalizeApprovedNameMatchKey(name);
    if (!key) {
      const error = new Error(`Dynamic policy alias at line ${index + 1} has no matchable characters`);
      error.code = 'DYNAMIC_POLICY_INVALID';
      throw error;
    }
    const firstLine = seen.get(key);
    if (firstLine !== undefined) {
      const error = new Error(`Dynamic policy alias at line ${index + 1} duplicates line ${firstLine} after punctuation normalization`);
      error.code = 'DYNAMIC_POLICY_ALIAS_DUPLICATE';
      throw error;
    }
    seen.set(key, index + 1);
    aliases.push(typeof raw === 'string' ? name : { ...raw, name });
  }
  return aliases;
}

function normalizePolicyInput(input = {}, current = {}, options = {}) {
  const mode = String(input.mode ?? current.mode ?? 'record').toLowerCase();
  if (!MODES.has(mode)) {
    const error = new Error('Dynamic policy mode is invalid');
    error.code = 'DYNAMIC_POLICY_INVALID';
    throw error;
  }
  const budgetPerTrade = normalizeBudgetValue(
    input.budget_per_trade ?? current.budget_per_trade ?? 0, 'budget_per_trade'
  );
  const dailyBudget = normalizeBudgetValue(
    input.daily_budget ?? current.daily_budget ?? 0, 'daily_budget'
  );
  const allowed_chain_ids = uniqueAllowed(
    input.allowed_chain_ids ?? current.allowed_chain_ids,
    CHAINS,
    'allowed_chain_ids',
    true
  );
  const chain_budgets = normalizeChainBudgets(input.chain_budgets, {
    ...current,
    inputHasLegacyOverride: input.budget_per_trade !== undefined || input.daily_budget !== undefined
  }, allowed_chain_ids, { budgetPerTrade, dailyBudget });
  const budgetValues = Object.values(chain_budgets);
  const legacyBudgetPerTrade = budgetValues.length
    ? Math.max(...budgetValues.map((item) => item.budget_per_trade)) : budgetPerTrade;
  const legacyDailyBudget = budgetValues.length
    ? Math.max(...budgetValues.map((item) => item.daily_budget)) : dailyBudget;
  const config = {
    mode,
    enabled: input.enabled === undefined ? current.enabled !== false : Boolean(input.enabled),
    allowed_chain_ids,
    allowed_event_types: uniqueAllowed(input.allowed_event_types ?? current.allowed_event_types ?? ['tweet'], EVENTS, 'allowed_event_types', true),
    allowed_term_types: uniqueAllowed(input.allowed_term_types ?? current.allowed_term_types ?? ['ca', 'cashtag', 'hashtag'], TERMS, 'allowed_term_types', true),
    approved_aliases: normalizeApprovedAliases(input.approved_aliases ?? current.approved_aliases),
    chain_budgets,
    budget_per_trade: legacyBudgetPerTrade,
    daily_budget: legacyDailyBudget,
    daily_new_token_limit: Number(input.daily_new_token_limit ?? current.daily_new_token_limit ?? 0),
    per_token_buy_limit: Number(input.per_token_buy_limit ?? current.per_token_buy_limit ?? 1),
    slippage: Number(input.slippage ?? current.slippage ?? 10),
    exit_strategy: normalizeDynamicExitStrategy(input.exit_strategy ?? current.exit_strategy),
    resolver_options: input.resolver_options ?? current.resolver_options ?? {}
  };
  const preset_asset_routes = normalizePresetRoutes(
    input.preset_asset_routes ?? current.preset_asset_routes ?? [],
    {
      legacyAliases: config.approved_aliases,
      allowTrustedFields: options.allowTrustedRouteFields === true
    }
  );
  if (![config.budget_per_trade, config.daily_budget, config.slippage].every(Number.isFinite)
      || config.budget_per_trade < 0 || config.daily_budget < 0
      || config.slippage < 0 || config.slippage > 100
      || !Number.isInteger(config.daily_new_token_limit) || config.daily_new_token_limit < 0
      || !Number.isInteger(config.per_token_buy_limit) || config.per_token_buy_limit < 1) {
    const error = new Error('Dynamic policy numeric limits are invalid');
    error.code = 'DYNAMIC_POLICY_INVALID';
    throw error;
  }
  if (['paper', 'live'].includes(config.mode)
      && budgetValues.some((budget) => budget.budget_per_trade <= 0 || budget.daily_budget <= 0)) {
    const error = new Error(`${config.mode} dynamic policy requires positive trade and daily limits`);
    error.code = config.mode === 'live'
      ? 'DYNAMIC_POLICY_LIVE_LIMITS_REQUIRED' : 'DYNAMIC_POLICY_PAPER_LIMITS_REQUIRED';
    throw error;
  }
  if (['paper', 'live'].includes(config.mode) && config.slippage <= 0) {
    const error = new Error(`${config.mode} dynamic policy requires positive slippage`);
    error.code = 'DYNAMIC_POLICY_SLIPPAGE_REQUIRED';
    throw error;
  }
  if (['paper', 'live'].includes(config.mode)
      && budgetValues.some((budget) => budget.daily_budget < budget.budget_per_trade)) {
    const error = new Error('Dynamic daily budget cannot be lower than one trade budget');
    error.code = 'DYNAMIC_POLICY_BUDGET_ORDER_INVALID';
    throw error;
  }
  if (preset_asset_routes.some((route) => !config.allowed_chain_ids.includes(route.chain_id))) {
    throw routeError('DYNAMIC_ROUTE_CHAIN_NOT_ALLOWED', 'Every asset route chain must be enabled by the policy');
  }
  if (preset_asset_routes.some((route) => route.enabled)
      && !config.allowed_term_types.includes('approved_name')) {
    throw routeError('DYNAMIC_ROUTE_TERM_TYPE_REQUIRED', 'Enabled asset routes require the project-name term type');
  }
  if (['paper', 'live'].includes(config.mode) && config.approved_aliases.length > 0) {
    throw routeError(
      'DYNAMIC_ROUTE_BINDING_REQUIRED',
      'Paper and live policies require every approved keyword to be bound to an asset route'
    );
  }
  const executionConfig = {
    ...config,
    preset_asset_routes: routeExecutionSnapshot(preset_asset_routes)
  };
  return {
    ...config,
    preset_asset_routes,
    context_hash: contextHash(executionConfig)
  };
}

async function list(filters = {}, executor = db) {
  const params = [];
  let where = 'WHERE 1=1';
  if (filters.kol_id) {
    params.push(Number(filters.kol_id));
    where += ` AND policy.kol_id = $${params.length}`;
  }
  const result = await executor.query(
    `SELECT policy.*, kol.x_handle, kol.display_name,
            watch.status AS watch_sync_status,
            watch.last_error AS watch_sync_error,
            watch.synced_at AS watch_synced_at,
            watch.desired_version AS watch_desired_version
     FROM x_actor_dynamic_policies AS policy
     JOIN x_kol_accounts AS kol ON kol.id = policy.kol_id
     LEFT JOIN x_watch_sync_outbox AS watch
       ON watch.actor_handle = lower(regexp_replace(kol.x_handle, '^@+', ''))
     ${where}
     ORDER BY policy.updated_at DESC`,
    params
  );
  return presetRouteRepository.attachRoutes(result.rows, executor);
}

async function getById(id, executor = db, options = {}) {
  const result = await executor.query(
    `SELECT policy.*, kol.x_handle, kol.display_name, kol.enabled AS kol_enabled
     FROM x_actor_dynamic_policies AS policy
     JOIN x_kol_accounts AS kol ON kol.id = policy.kol_id
     WHERE policy.id = $1 ${options.forUpdate ? 'FOR UPDATE OF policy' : ''}`,
    [Number(id)]
  );
  const policy = result.rows[0] || null;
  if (!policy) return null;
  return (await presetRouteRepository.attachRoutes([policy], executor))[0];
}

async function getByKolId(kolId, executor = db, options = {}) {
  const result = await executor.query(
    `SELECT policy.*, kol.x_handle, kol.display_name, kol.enabled AS kol_enabled
     FROM x_actor_dynamic_policies AS policy
     JOIN x_kol_accounts AS kol ON kol.id = policy.kol_id
     WHERE policy.kol_id = $1 ${options.forUpdate ? 'FOR UPDATE OF policy' : ''}`,
    [Number(kolId)]
  );
  const policy = result.rows[0] || null;
  if (!policy) return null;
  return (await presetRouteRepository.attachRoutes([policy], executor))[0];
}

function routeStateHash(routes = []) {
  return contextHash(routes.map((route) => ({
    route_id: route.route_id ?? null,
    label: route.label,
    aliases: route.aliases,
    chain_id: route.chain_id,
    contract_address: route.contract_address,
    enabled: route.enabled !== false,
    variant_id: route.variant_id ?? null,
    verified_at: route.verification?.verified_at ?? null
  })));
}

async function persistNormalizedPolicy(kolId, config, current, executor = db) {
  if (config.mode === 'live' && config.daily_new_token_limit <= 0) {
    const error = new Error('Live dynamic policy requires explicit positive trade and daily limits');
    error.code = 'DYNAMIC_POLICY_LIVE_LIMITS_REQUIRED';
    throw error;
  }
  const changed = !current.id || current.context_hash !== config.context_hash;
  const revision = current.id ? Number(current.revision) + (changed ? 1 : 0) : 1;
  const result = await executor.query(
    `INSERT INTO x_actor_dynamic_policies
      (kol_id, mode, enabled, allowed_chain_ids, allowed_event_types, allowed_term_types,
       approved_aliases, chain_budgets, budget_per_trade, daily_budget, daily_new_token_limit,
       per_token_buy_limit, slippage, exit_strategy, resolver_options, revision, context_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (kol_id) DO UPDATE SET
       mode = EXCLUDED.mode, enabled = EXCLUDED.enabled,
       allowed_chain_ids = EXCLUDED.allowed_chain_ids,
       allowed_event_types = EXCLUDED.allowed_event_types,
       allowed_term_types = EXCLUDED.allowed_term_types,
       approved_aliases = EXCLUDED.approved_aliases,
        chain_budgets = EXCLUDED.chain_budgets,
        budget_per_trade = EXCLUDED.budget_per_trade,
       daily_budget = EXCLUDED.daily_budget,
       daily_new_token_limit = EXCLUDED.daily_new_token_limit,
       per_token_buy_limit = EXCLUDED.per_token_buy_limit,
       slippage = EXCLUDED.slippage, exit_strategy = EXCLUDED.exit_strategy,
       resolver_options = EXCLUDED.resolver_options,
       revision = EXCLUDED.revision, context_hash = EXCLUDED.context_hash,
       updated_at = NOW()
     RETURNING *`,
    [Number(kolId), config.mode, config.enabled, config.allowed_chain_ids,
       config.allowed_event_types, config.allowed_term_types, JSON.stringify(config.approved_aliases),
       JSON.stringify(config.chain_budgets), config.budget_per_trade, config.daily_budget, config.daily_new_token_limit,
      config.per_token_buy_limit, config.slippage, JSON.stringify(config.exit_strategy),
      JSON.stringify(config.resolver_options), revision, config.context_hash]
  );
  if (changed && current.id) {
    await executor.query(
      `UPDATE trade_signals SET status = 'signal_only',
         reject_reason = 'DYNAMIC_POLICY_CHANGED', updated_at = NOW()
       WHERE actor_policy_id = $1 AND actor_policy_revision <> $2
         AND status IN('recorded','pending','approved')`,
      [Number(current.id), revision]
    );
    await executor.query(
      `UPDATE ca_whitelist SET status = 'archived', updated_at = NOW()
       WHERE actor_policy_id = $1 AND actor_policy_revision <> $2
         AND source = 'dynamic_keyword' AND status = 'active'`,
      [Number(current.id), revision]
    );
    await executor.query(
      `UPDATE whitelist_activation_outbox SET status = 'failed',
         locked_at = NULL, last_error_code = 'DYNAMIC_POLICY_CHANGED',
         last_error_detail = 'Superseded by a newer dynamic policy revision',
         completed_at = NOW(), updated_at = NOW()
       WHERE whitelist_id IN (
         SELECT id FROM ca_whitelist
         WHERE actor_policy_id = $1 AND actor_policy_revision <> $2
           AND source = 'dynamic_keyword'
       ) AND status IN('pending','processing')`,
      [Number(current.id), revision]
    );
    await executor.query(
      `UPDATE dynamic_targets SET status = 'paused', updated_at = NOW()
       WHERE actor_policy_id = $1 AND actor_policy_revision <> $2
         AND status = 'active'`,
      [Number(current.id), revision]
    );
    await executor.query(
      `UPDATE dynamic_signal_jobs SET status = 'cancelled',
         failure_code = 'DYNAMIC_POLICY_CHANGED', completed_at = NOW(),
         lease_expires_at = NULL, locked_at = NULL, updated_at = NOW()
       WHERE actor_policy_id = $1 AND policy_revision <> $2
         AND status IN('pending','processing')`,
      [Number(current.id), revision]
    );
  }
  return result.rows[0];
}

async function upsert(kolId, input = {}, executor = db) {
  if (Object.prototype.hasOwnProperty.call(input, 'preset_asset_routes')) {
    throw routeError(
      'DYNAMIC_ROUTE_PREFLIGHT_REQUIRED',
      'Asset routes must be saved through the verified policy upsert flow'
    );
  }
  await executor.query('SELECT pg_advisory_xact_lock(20, $1::int)', [Number(kolId)]);
  const existingResult = await executor.query(
    'SELECT * FROM x_actor_dynamic_policies WHERE kol_id = $1 FOR UPDATE', [Number(kolId)]
  );
  const current = existingResult.rows[0] || {};
  if (current.id) {
    current.preset_asset_routes = await presetRouteRepository.listForPolicy(current.id, executor);
  }
  const config = normalizePolicyInput(input, current, { allowTrustedRouteFields: true });
  const saved = await persistNormalizedPolicy(kolId, config, current, executor);
  return { ...saved, preset_asset_routes: current.preset_asset_routes || [] };
}

async function preparePolicyUpsert(kolId, input = {}, executor = db, dependencies = {}) {
  const current = await getByKolId(kolId, executor);
  if (!current) {
    const kolResult = await executor.query(
      'SELECT id FROM x_kol_accounts WHERE id = $1', [Number(kolId)]
    );
    if (!kolResult.rows[0]) {
      throw routeError('DYNAMIC_POLICY_KOL_NOT_FOUND', 'KOL account was not found');
    }
  }
  const config = normalizePolicyInput(input, current || {});
  const routes = await prepareVerifiedRoutes(
    config.preset_asset_routes,
    current?.preset_asset_routes || [],
    dependencies
  );
  return {
    kol_id: Number(kolId),
    baseline: current ? {
      policy_id: Number(current.id),
      revision: Number(current.revision),
      context_hash: current.context_hash,
      route_state_hash: routeStateHash(current.preset_asset_routes)
    } : null,
    config: { ...config, preset_asset_routes: routes }
  };
}

async function commitPreparedPolicyUpsert(prepared, executor = db) {
  const kolId = Number(prepared?.kol_id);
  if (!Number.isInteger(kolId) || kolId <= 0 || !prepared?.config) {
    throw routeError('DYNAMIC_ROUTE_PREFLIGHT_REQUIRED', 'Verified policy input is missing');
  }
  await executor.query('SELECT pg_advisory_xact_lock(20, $1::int)', [kolId]);
  const existingResult = await executor.query(
    'SELECT * FROM x_actor_dynamic_policies WHERE kol_id = $1 FOR UPDATE', [kolId]
  );
  const current = existingResult.rows[0] || {};
  const currentRoutes = current.id
    ? await presetRouteRepository.listForPolicy(current.id, executor)
    : [];
  const baseline = prepared.baseline;
  const concurrent = baseline
    ? !current.id
      || Number(current.id) !== baseline.policy_id
      || Number(current.revision) !== baseline.revision
      || current.context_hash !== baseline.context_hash
      || routeStateHash(currentRoutes) !== baseline.route_state_hash
    : Boolean(current.id);
  if (concurrent) {
    throw routeError(
      'DYNAMIC_POLICY_CONCURRENT_UPDATE',
      'Dynamic policy changed while asset routes were being verified'
    );
  }
  const config = normalizePolicyInput(
    prepared.config,
    { ...current, preset_asset_routes: currentRoutes },
    { allowTrustedRouteFields: true }
  );
  if (config.context_hash !== prepared.config.context_hash) {
    throw routeError('DYNAMIC_ROUTE_PREFLIGHT_REQUIRED', 'Verified route payload no longer matches the policy input');
  }
  const saved = await persistNormalizedPolicy(kolId, config, current, executor);
  const routes = await presetRouteRepository.sync(saved.id, config.preset_asset_routes, executor);
  return { ...saved, preset_asset_routes: routes };
}

async function remove(id, executor = db) {
  const current = await getById(id, executor, { forUpdate: true });
  if (!current) return false;
  const config = normalizePolicyInput({ mode: 'paused', enabled: false }, current);
  await executor.query(
    `UPDATE x_actor_dynamic_policies SET mode = 'paused', enabled = false,
       revision = revision + 1, context_hash = $2, updated_at = NOW()
     WHERE id = $1`,
    [Number(id), config.context_hash]
  );
  await executor.query(
    `UPDATE dynamic_targets SET status = 'paused', updated_at = NOW()
     WHERE actor_policy_id = $1 AND status = 'active'`, [Number(id)]
  );
  await executor.query(
    `UPDATE ca_whitelist SET status = 'archived', updated_at = NOW()
     WHERE actor_policy_id = $1 AND source = 'dynamic_keyword'
       AND status = 'active'`, [Number(id)]
  );
  await executor.query(
    `UPDATE whitelist_activation_outbox SET status = 'failed',
       locked_at = NULL, last_error_code = 'DYNAMIC_POLICY_REMOVED',
       last_error_detail = 'Dynamic policy was removed', completed_at = NOW(), updated_at = NOW()
     WHERE whitelist_id IN (
       SELECT id FROM ca_whitelist
       WHERE actor_policy_id = $1 AND source = 'dynamic_keyword'
     ) AND status IN('pending','processing')`, [Number(id)]
  );
  await executor.query(
    `UPDATE trade_signals SET status = 'signal_only',
       reject_reason = 'DYNAMIC_POLICY_REMOVED', updated_at = NOW()
     WHERE actor_policy_id = $1 AND status IN('recorded','pending','approved')`, [Number(id)]
  );
  await executor.query(
    `UPDATE dynamic_signal_jobs SET status = 'cancelled',
       failure_code = 'DYNAMIC_POLICY_REMOVED', completed_at = NOW(),
       lease_expires_at = NULL, locked_at = NULL, updated_at = NOW()
     WHERE actor_policy_id = $1 AND status IN('pending','processing')`, [Number(id)]
  );
  return true;
}

module.exports = {
  CHAINS, EVENTS, MODES, TERMS, chainBudgetFor, commitPreparedPolicyUpsert, contextHash,
  getById, getByKolId, list, normalizeApprovedAliases, normalizePolicyInput,
  normalizeXHandle, persistNormalizedPolicy, preparePolicyUpsert, remove, routeStateHash,
  sortedObject, upsert
};
