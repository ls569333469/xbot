const crypto = require('crypto');
const db = require('../../lib/db');
const { normalizeXHandle } = require('../../lib/x-handles');
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
  const seen = new Set();
  for (const raw of value) {
    const name = String(typeof raw === 'string' ? raw : raw?.name ?? raw?.value ?? '')
      .normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 80) {
      const error = new Error('Dynamic policy aliases must contain 1-80 characters');
      error.code = 'DYNAMIC_POLICY_INVALID';
      throw error;
    }
    const key = name.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(typeof raw === 'string' ? name : { ...raw, name });
  }
  return aliases;
}

function normalizePolicyInput(input = {}, current = {}) {
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
  return { ...config, context_hash: contextHash(config) };
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
            approval.id AS approval_id, approval.expires_at AS approval_expires_at,
            approval.policy_revision AS approval_policy_revision,
            approval.context_hash AS approval_context_hash
     FROM x_actor_dynamic_policies AS policy
     JOIN x_kol_accounts AS kol ON kol.id = policy.kol_id
     LEFT JOIN LATERAL (
       SELECT * FROM dynamic_live_approvals
       WHERE actor_policy_id = policy.id AND status = 'active' AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1
     ) approval ON true
     ${where}
     ORDER BY policy.updated_at DESC`,
    params
  );
  return result.rows;
}

async function getById(id, executor = db, options = {}) {
  const result = await executor.query(
    `SELECT policy.*, kol.x_handle, kol.display_name, kol.enabled AS kol_enabled
     FROM x_actor_dynamic_policies AS policy
     JOIN x_kol_accounts AS kol ON kol.id = policy.kol_id
     WHERE policy.id = $1 ${options.forUpdate ? 'FOR UPDATE OF policy' : ''}`,
    [Number(id)]
  );
  return result.rows[0] || null;
}

async function upsert(kolId, input = {}, executor = db) {
  const existingResult = await executor.query(
    'SELECT * FROM x_actor_dynamic_policies WHERE kol_id = $1', [Number(kolId)]
  );
  const current = existingResult.rows[0] || {};
  const config = normalizePolicyInput(input, current);
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
      `UPDATE dynamic_live_approvals SET status = 'revoked', revoked_at = NOW()
       WHERE actor_policy_id = $1 AND status = 'active'`, [current.id]
    );
  }
  return result.rows[0];
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
    `UPDATE dynamic_live_approvals SET status = 'revoked', revoked_at = NOW()
     WHERE actor_policy_id = $1 AND status = 'active'`, [Number(id)]
  );
  await executor.query(
    `UPDATE dynamic_targets SET status = 'paused', updated_at = NOW()
     WHERE actor_policy_id = $1 AND status = 'active'`, [Number(id)]
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
  CHAINS, EVENTS, MODES, TERMS, chainBudgetFor, contextHash, getById, list,
  normalizeApprovedAliases, normalizePolicyInput, remove, sortedObject, upsert, normalizeXHandle
};
