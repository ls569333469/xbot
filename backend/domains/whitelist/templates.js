const db = require('../../lib/db');
const { getAllChains } = require('../../lib/chain-config');
const { normalizeXHandle } = require('../../lib/x-handles');
const { normalizeExitStrategy } = require('../trade/exit-strategy-compiler');
const {
  DIRECT_SOURCE_EVENT_TYPES,
  RELATION_EVENT_TYPES,
  X_HANDLE_PATTERN,
  normalizeEventTypes
} = require('./relations');

const CHAIN_IDS = new Set(getAllChains().map((chain) => chain.id));
const TEMPLATE_SCHEMA_VERSION = 2;
const RELATION_TARGET_POLICIES = new Set(['all_selected_project_identities']);

function normalizeHandleList(values, label) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new Error(`Template ${label} must be an array`);
  const handles = [...new Set(values.map(normalizeXHandle).filter(Boolean))];
  const invalid = handles.find((handle) => !X_HANDLE_PATTERN.test(handle));
  if (invalid) throw new Error(`Invalid template X handle: ${invalid}`);
  return handles.sort();
}

function normalizeRuleEnabled(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`Template ${label} must be a boolean`);
  return value;
}

function normalizeTemplateSnapshot(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('template_snapshot must be an object');
  }
  const budgetPerTrade = Number(value.budget_per_trade);
  const totalBudget = Number(value.total_budget);
  if (!Number.isFinite(budgetPerTrade) || budgetPerTrade <= 0) {
    throw new Error('Template budget_per_trade must be a positive number');
  }
  if (!Number.isFinite(totalBudget) || totalBudget <= 0 || budgetPerTrade > totalBudget) {
    throw new Error('Template total_budget must be positive and not less than budget_per_trade');
  }
  const allowRepeatBuy = value.allow_repeat_buy ?? false;
  if (typeof allowRepeatBuy !== 'boolean') {
    throw new Error('Template allow_repeat_buy must be a boolean');
  }
  const requestedMaxRepeatBuys = Number(value.max_repeat_buys ?? 1);
  if (!Number.isSafeInteger(requestedMaxRepeatBuys) || requestedMaxRepeatBuys < 1) {
    throw new Error('Template max_repeat_buys must be a positive integer');
  }
  const maxRepeatBuys = allowRepeatBuy ? requestedMaxRepeatBuys : 1;
  const slippage = Number(value.slippage ?? 10);
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 100) {
    throw new Error('Template slippage must be between 0 and 100');
  }
  const schemaVersion = Number(value.schema_version);
  if (schemaVersion !== TEMPLATE_SCHEMA_VERSION) {
    throw new Error(`Template schema_version must be ${TEMPLATE_SCHEMA_VERSION}`);
  }
  const directSourceActorHandles = normalizeHandleList(
    value.direct_source_actor_handles,
    'direct_source_actor_handles'
  );
  const relationActorHandles = normalizeHandleList(
    value.relation_actor_handles,
    'relation_actor_handles'
  );
  const directSourceRuleEnabled = normalizeRuleEnabled(
    value.direct_source_rule_enabled,
    directSourceActorHandles.length > 0,
    'direct_source_rule_enabled'
  );
  const relationRuleEnabled = normalizeRuleEnabled(
    value.relation_rule_enabled,
    relationActorHandles.length > 0,
    'relation_rule_enabled'
  );
  if (directSourceRuleEnabled && directSourceActorHandles.length === 0) {
    throw new Error('Enabled template direct-source rule requires at least one actor handle');
  }
  if (relationRuleEnabled && relationActorHandles.length === 0) {
    throw new Error('Enabled template relation rule requires at least one actor handle');
  }
  if (!directSourceRuleEnabled && !relationRuleEnabled) {
    throw new Error('Template must enable at least one X trigger rule');
  }
  const relationTargetPolicy = String(
    value.relation_target_policy || 'all_selected_project_identities'
  ).trim().toLowerCase();
  if (!RELATION_TARGET_POLICIES.has(relationTargetPolicy)) {
    throw new Error(`Unsupported template relation target policy: ${relationTargetPolicy}`);
  }
  return {
    schema_version: schemaVersion,
    budget_per_trade: budgetPerTrade,
    total_budget: totalBudget,
    slippage,
    allow_repeat_buy: allowRepeatBuy,
    max_repeat_buys: maxRepeatBuys,
    exit_strategy: normalizeExitStrategy(value.exit_strategy, value),
    relation_event_types: normalizeEventTypes(
      value.relation_event_types,
      RELATION_EVENT_TYPES,
      'Relation'
    ),
    direct_source_event_types: normalizeEventTypes(
      value.direct_source_event_types ?? ['tweet'],
      DIRECT_SOURCE_EVENT_TYPES,
      'Direct source'
    ),
    direct_source_rule_enabled: directSourceRuleEnabled,
    direct_source_actor_handles: directSourceActorHandles,
    relation_rule_enabled: relationRuleEnabled,
    relation_actor_handles: relationActorHandles,
    relation_target_policy: relationTargetPolicy
  };
}

function normalizeTemplateInput(data, existing = {}) {
  const chainId = String(data.chain_id ?? existing.chain_id ?? '').trim().toLowerCase();
  const name = String(data.name ?? existing.name ?? '').trim().slice(0, 80);
  if (!CHAIN_IDS.has(chainId)) throw new Error(`Unsupported template chain: ${chainId}`);
  if (!name) throw new Error('Template name is required');
  return {
    name,
    chain_id: chainId,
    template_snapshot: normalizeTemplateSnapshot(
      data.template_snapshot === undefined ? existing.template_snapshot : data.template_snapshot
    ),
    is_default: data.is_default === undefined ? Boolean(existing.is_default) : Boolean(data.is_default)
  };
}

async function inTransaction(action) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listTemplates(chainId) {
  const params = [];
  const where = chainId ? 'WHERE chain_id = $1' : '';
  if (chainId) params.push(String(chainId).toLowerCase());
  const result = await db.query(
    `SELECT * FROM whitelist_templates ${where}
     ORDER BY is_default DESC, updated_at DESC, id DESC`,
    params
  );
  return result.rows;
}

async function createTemplate(data) {
  const input = normalizeTemplateInput(data);
  return inTransaction(async (client) => {
    if (input.is_default) {
      await client.query(
        'UPDATE whitelist_templates SET is_default = false, updated_at = NOW() WHERE chain_id = $1',
        [input.chain_id]
      );
    }
    const result = await client.query(
      `INSERT INTO whitelist_templates
        (name, chain_id, template_snapshot, is_default)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.name, input.chain_id, input.template_snapshot, input.is_default]
    );
    return result.rows[0];
  });
}

async function updateTemplate(id, data) {
  return inTransaction(async (client) => {
    const currentResult = await client.query(
      'SELECT * FROM whitelist_templates WHERE id = $1 FOR UPDATE',
      [id]
    );
    const current = currentResult.rows[0];
    if (!current) throw new Error('Whitelist template not found');
    const input = normalizeTemplateInput(data, current);
    if (input.is_default) {
      await client.query(
        'UPDATE whitelist_templates SET is_default = false, updated_at = NOW() WHERE chain_id = $1 AND id <> $2',
        [input.chain_id, id]
      );
    }
    const result = await client.query(
      `UPDATE whitelist_templates
       SET name = $1, chain_id = $2, template_snapshot = $3,
           version = version + 1, is_default = $4, updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [input.name, input.chain_id, input.template_snapshot, input.is_default, id]
    );
    return result.rows[0];
  });
}

async function deleteTemplate(id) {
  const result = await db.query('DELETE FROM whitelist_templates WHERE id = $1 RETURNING id', [id]);
  return Boolean(result.rows[0]);
}

module.exports = {
  createTemplate,
  deleteTemplate,
  listTemplates,
  normalizeTemplateInput,
  normalizeTemplateSnapshot,
  updateTemplate
};
