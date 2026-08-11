const crypto = require('crypto');
const db = require('../../lib/db');
const { normalizeExitStrategy, clonePreset } = require('../trade/exit-strategy-compiler');
const { followError } = require('./errors');

const MODES = new Set(['record', 'paper', 'live', 'paused']);
const CHAINS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood']);

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]));
}

function contextHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(sortedObject(value))).digest('hex');
}

function allowedChains(value, fallback = []) {
  const chains = [...new Set((Array.isArray(value) ? value : fallback)
    .map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))].sort();
  if (!chains.length || chains.some((chain) => !CHAINS.has(chain))) {
    throw followError('FOLLOW_POLICY_INVALID', 'Follow discovery allowed chains are invalid');
  }
  return chains;
}

function numberAtLeast(value, minimum, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw followError('FOLLOW_POLICY_INVALID', `Follow discovery field is invalid: ${field}`);
  }
  return parsed;
}

function normalizeTradeConfig(value = {}, chains = []) {
  const matrix = value.chain_budgets && typeof value.chain_budgets === 'object'
    && !Array.isArray(value.chain_budgets) ? value.chain_budgets : {};
  const chain_budgets = {};
  for (const chain of chains) {
    const budget = matrix[chain] || {};
    chain_budgets[chain] = {
      budget_per_trade: numberAtLeast(budget.budget_per_trade ?? 0, 0, `${chain}.budget_per_trade`),
      daily_budget: numberAtLeast(budget.daily_budget ?? 0, 0, `${chain}.daily_budget`)
    };
  }
  const perTokenBuyLimit = numberAtLeast(value.per_token_buy_limit ?? 1, 1, 'per_token_buy_limit');
  const dailyNewTokenLimit = numberAtLeast(value.daily_new_token_limit ?? 0, 0, 'daily_new_token_limit');
  const slippage = numberAtLeast(value.slippage ?? 10, 0, 'slippage');
  if (!Number.isInteger(perTokenBuyLimit) || !Number.isInteger(dailyNewTokenLimit) || slippage > 100) {
    throw followError('FOLLOW_POLICY_INVALID', 'Follow discovery numeric limits are invalid');
  }
  return {
    chain_budgets,
    daily_new_token_limit: dailyNewTokenLimit,
    per_token_buy_limit: perTokenBuyLimit,
    slippage,
    exit_strategy: normalizeExitStrategy(value.exit_strategy || clonePreset('principal_no_stop'))
  };
}

function normalizeResolverOptions(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const eventTtlSeconds = Number(input.event_ttl_seconds ?? 900);
  const maxTweets = Number(input.max_tweets ?? 20);
  const minimumAccountAgeDays = Number(input.minimum_account_age_days ?? 7);
  if (!Number.isInteger(eventTtlSeconds) || eventTtlSeconds < 60 || eventTtlSeconds > 86400
      || !Number.isInteger(maxTweets) || maxTweets < 1 || maxTweets > 100
      || !Number.isInteger(minimumAccountAgeDays) || minimumAccountAgeDays < 0
      || minimumAccountAgeDays > 3650) {
    throw followError('FOLLOW_POLICY_INVALID', 'Follow discovery resolver options are invalid');
  }
  return {
    event_ttl_seconds: eventTtlSeconds,
    max_tweets: maxTweets,
    minimum_account_age_days: minimumAccountAgeDays,
    include_profile_website: input.include_profile_website !== false,
    require_original_content: input.require_original_content !== false
  };
}

async function loadTemplate(id, executor = db) {
  if (!id) return null;
  const result = await executor.query('SELECT * FROM dynamic_policy_templates WHERE id = $1', [Number(id)]);
  if (!result.rows[0]) throw followError('FOLLOW_TEMPLATE_NOT_FOUND', 'Trade template not found');
  return result.rows[0];
}

async function normalizePolicyInput(input = {}, current = {}, executor = db) {
  const mode = String(input.mode ?? current.mode ?? 'record').toLowerCase();
  if (!MODES.has(mode)) throw followError('FOLLOW_POLICY_INVALID', 'Follow discovery mode is invalid');
  const templateId = input.trade_template_id === undefined
    ? current.trade_template_id : (input.trade_template_id || null);
  const template = await loadTemplate(templateId, executor);
  const templateConfig = template?.config || current.trade_config_snapshot || {};
  const chains = allowedChains(input.allowed_chain_ids, current.allowed_chain_ids || templateConfig.allowed_chain_ids);
  const tradeConfig = normalizeTradeConfig(templateConfig, chains);
  if (['paper', 'live'].includes(mode)) {
    if (!template) throw followError('FOLLOW_TEMPLATE_REQUIRED', `${mode} follow discovery requires a trade template`);
    if (Object.values(tradeConfig.chain_budgets).some((budget) => (
      budget.budget_per_trade <= 0 || budget.daily_budget < budget.budget_per_trade
    ))) {
      throw followError('FOLLOW_BUDGET_REQUIRED', `${mode} follow discovery requires positive chain budgets`);
    }
    if (tradeConfig.slippage <= 0) {
      throw followError('FOLLOW_SLIPPAGE_REQUIRED', `${mode} follow discovery requires positive slippage`);
    }
  }
  const resolverOptions = normalizeResolverOptions(input.resolver_options ?? current.resolver_options);
  const config = {
    mode,
    enabled: input.enabled === undefined ? current.enabled !== false : Boolean(input.enabled),
    allowed_chain_ids: chains,
    trade_template_id: template ? Number(template.id) : null,
    trade_template_version: template ? Number(template.version) : null,
    trade_config_snapshot: tradeConfig,
    resolver_options: resolverOptions
  };
  return { ...config, context_hash: contextHash(config) };
}

async function list(filters = {}, executor = db) {
  const params = [];
  let where = 'WHERE policy.archived_at IS NULL';
  if (filters.kol_id) {
    params.push(Number(filters.kol_id));
    where += ` AND policy.kol_id = $${params.length}`;
  }
  const result = await executor.query(
    `SELECT policy.*, kol.x_user_id, kol.x_handle, kol.display_name,
            template.name AS trade_template_name, template.version AS current_template_version,
            watch.status AS watch_sync_status, watch.last_error AS watch_sync_error,
            watch.synced_at AS watch_synced_at
     FROM follow_discovery_policies policy
     JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     LEFT JOIN dynamic_policy_templates template ON template.id = policy.trade_template_id
     LEFT JOIN x_watch_sync_outbox watch
       ON watch.actor_handle = lower(regexp_replace(kol.x_handle, '^@+', ''))
     ${where}
     ORDER BY policy.updated_at DESC`, params
  );
  return result.rows;
}

async function getById(id, executor = db, options = {}) {
  const archivedClause = options.includeArchived ? '' : 'AND policy.archived_at IS NULL';
  const result = await executor.query(
    `SELECT policy.*, kol.x_user_id, kol.x_handle, kol.display_name,
            kol.enabled AS kol_enabled, kol.profile_status,
            template.name AS trade_template_name
     FROM follow_discovery_policies policy
     JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     LEFT JOIN dynamic_policy_templates template ON template.id = policy.trade_template_id
     WHERE policy.id = $1 ${archivedClause} ${options.forUpdate ? 'FOR UPDATE OF policy' : ''}`,
    [Number(id)]
  );
  return result.rows[0] || null;
}

async function create(input = {}, executor = db) {
  const kolId = Number(input.kol_id);
  if (!Number.isInteger(kolId) || kolId <= 0) {
    throw followError('FOLLOW_POLICY_INVALID', 'A valid KOL account is required');
  }
  await executor.query('SELECT pg_advisory_xact_lock(21, $1::int)', [kolId]);
  const kolResult = await executor.query(
    'SELECT * FROM x_kol_accounts WHERE id = $1 FOR SHARE', [kolId]
  );
  const kol = kolResult.rows[0];
  if (!kol) throw followError('FOLLOW_KOL_NOT_FOUND', 'KOL account not found');
  if (kol.profile_status !== 'verified' || !kol.x_user_id
      || String(kol.x_user_id).toLowerCase() === String(kol.x_handle).replace(/^@+/, '').toLowerCase()) {
    throw followError('FOLLOW_ACTOR_IDENTITY_UNVERIFIED', 'KOL requires a stable verified X User ID');
  }
  const existing = await executor.query(
    `SELECT * FROM follow_discovery_policies
     WHERE kol_id = $1 AND archived_at IS NULL FOR UPDATE`, [kolId]
  );
  if (existing.rows[0]) throw followError('FOLLOW_POLICY_EXISTS', 'This KOL already has a follow discovery policy');
  const config = await normalizePolicyInput(input, {}, executor);
  const result = await executor.query(
    `INSERT INTO follow_discovery_policies
      (kol_id, mode, enabled, allowed_chain_ids, trade_template_id,
       trade_config_snapshot, resolver_options, revision, context_hash, baseline_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,NOW()) RETURNING *`,
    [kolId, config.mode, config.enabled, config.allowed_chain_ids, config.trade_template_id,
      config.trade_config_snapshot, config.resolver_options, config.context_hash]
  );
  return result.rows[0];
}

async function update(id, input = {}, executor = db) {
  const current = await getById(id, executor, { forUpdate: true });
  if (!current) throw followError('FOLLOW_POLICY_NOT_FOUND', 'Follow discovery policy not found');
  const config = await normalizePolicyInput(input, current, executor);
  const changed = config.context_hash !== current.context_hash;
  const revision = Number(current.revision) + (changed ? 1 : 0);
  const result = await executor.query(
    `UPDATE follow_discovery_policies SET mode = $2, enabled = $3,
       allowed_chain_ids = $4, trade_template_id = $5, trade_config_snapshot = $6,
       resolver_options = $7, revision = $8, context_hash = $9, updated_at = NOW()
     WHERE id = $1 AND archived_at IS NULL RETURNING *`,
    [Number(id), config.mode, config.enabled, config.allowed_chain_ids,
      config.trade_template_id, config.trade_config_snapshot, config.resolver_options,
      revision, config.context_hash]
  );
  if (changed) {
    await executor.query(
      `UPDATE follow_discovery_events SET status = 'cancelled', stage = 'revision_changed',
         failure_code = 'FOLLOW_POLICY_REVISION_CHANGED', locked_at = NULL,
         lease_expires_at = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE policy_id = $1 AND policy_revision <> $2
         AND status IN ('pending','processing')`, [Number(id), revision]
    );
    await executor.query(
      `UPDATE ca_whitelist SET status = 'archived', updated_at = NOW()
       WHERE follow_discovery_policy_id = $1 AND source = 'follow_discovery'
         AND status = 'active'`, [Number(id)]
    );
  }
  return result.rows[0];
}

async function remove(id, executor = db) {
  const policyId = Number(id);
  const result = await executor.query(
    `UPDATE follow_discovery_policies
     SET enabled = false, mode = 'paused', archived_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND archived_at IS NULL RETURNING id`, [policyId]
  );
  if (!result.rows[0]) return false;
  await executor.query(
    `UPDATE follow_discovery_events
     SET status = 'cancelled', stage = 'policy_archived',
         failure_code = 'FOLLOW_POLICY_ARCHIVED', locked_at = NULL,
         lease_expires_at = NULL, worker_id = NULL, completed_at = NOW(), updated_at = NOW()
     WHERE policy_id = $1 AND status IN ('pending', 'processing')`, [policyId]
  );
  await executor.query(
    `UPDATE ca_whitelist
     SET status = 'archived', updated_at = NOW()
     WHERE follow_discovery_policy_id = $1 AND source = 'follow_discovery'
       AND status = 'active'`, [policyId]
  );
  return true;
}

function chainBudgetFor(policy, chainId) {
  const budget = policy?.trade_config_snapshot?.chain_budgets?.[String(chainId || '').toLowerCase()];
  if (!budget) return null;
  return { budget_per_trade: Number(budget.budget_per_trade), daily_budget: Number(budget.daily_budget) };
}

module.exports = {
  chainBudgetFor, contextHash, create, getById, list, normalizePolicyInput,
  normalizeResolverOptions, normalizeTradeConfig, remove, update
};
