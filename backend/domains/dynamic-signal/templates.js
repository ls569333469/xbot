const db = require('../../lib/db');
const policyService = require('./policy-service');
const { templateRouteInputs } = require('./preset-route-schema');

const TEMPLATE_FIELDS = [
  'allowed_chain_ids',
  'allowed_event_types',
  'allowed_term_types',
  'approved_aliases',
  'preset_asset_routes',
  'chain_budgets',
  'daily_new_token_limit',
  'per_token_buy_limit',
  'slippage',
  'exit_strategy',
  'resolver_options'
];

function pickTemplateConfig(value) {
  return Object.fromEntries(TEMPLATE_FIELDS.map((field) => [
    field,
    field === 'preset_asset_routes' ? templateRouteInputs(value[field]) : value[field]
  ]));
}

function normalizeTemplateConfig(value = {}) {
  const normalized = policyService.normalizePolicyInput({
    ...value,
    mode: 'record',
    enabled: true
  }, {});
  return pickTemplateConfig(normalized);
}

function normalizeName(value, current = '') {
  const name = String(value ?? current).normalize('NFKC').trim();
  if (!name || name.length > 80) {
    const error = new Error('Dynamic policy template name must contain 1-80 characters');
    error.code = 'DYNAMIC_POLICY_TEMPLATE_INVALID';
    throw error;
  }
  return name;
}

function normalizeInput(input = {}, current = {}) {
  return {
    name: normalizeName(input.name, current.name),
    config: normalizeTemplateConfig(input.config === undefined ? current.config : input.config)
  };
}

async function listTemplates(executor = db) {
  const result = await executor.query(
    `SELECT id, name, config, version, created_at, updated_at
     FROM dynamic_policy_templates
     ORDER BY updated_at DESC, id DESC`
  );
  return result.rows;
}

async function createTemplate(input, executor = db) {
  const normalized = normalizeInput(input);
  const result = await executor.query(
    `INSERT INTO dynamic_policy_templates (name, config)
     VALUES ($1, $2) RETURNING id, name, config, version, created_at, updated_at`,
    [normalized.name, JSON.stringify(normalized.config)]
  );
  return result.rows[0];
}

async function updateTemplate(id, input, executor = db) {
  const currentResult = await executor.query(
    'SELECT id, name, config FROM dynamic_policy_templates WHERE id = $1 FOR UPDATE',
    [Number(id)]
  );
  const current = currentResult.rows[0];
  if (!current) {
    const error = new Error('Dynamic policy template not found');
    error.code = 'DYNAMIC_POLICY_TEMPLATE_NOT_FOUND';
    throw error;
  }
  const normalized = normalizeInput(input, current);
  const result = await executor.query(
    `UPDATE dynamic_policy_templates
     SET name = $1, config = $2, version = version + 1, updated_at = NOW()
     WHERE id = $3
     RETURNING id, name, config, version, created_at, updated_at`,
    [normalized.name, JSON.stringify(normalized.config), Number(id)]
  );
  return result.rows[0];
}

async function updateTemplateTransactional(id, input, pool = db.pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const template = await updateTemplate(id, input, client);
    await client.query('COMMIT');
    return template;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function deleteTemplate(id, executor = db) {
  const result = await executor.query(
    'DELETE FROM dynamic_policy_templates WHERE id = $1 RETURNING id',
    [Number(id)]
  );
  return Boolean(result.rows[0]);
}

module.exports = {
  TEMPLATE_FIELDS,
  createTemplate,
  deleteTemplate,
  listTemplates,
  normalizeTemplateConfig,
  normalizeInput,
  updateTemplate,
  updateTemplateTransactional
};
