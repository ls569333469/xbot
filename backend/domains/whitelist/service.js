const db = require('../../lib/db');
const queries = require('./queries');
const configService = require('../config/service');
const { normalizeRelationInputs, syncWhitelistRelations } = require('./relations');

function budgetError(message, code = 'WHITELIST_BUDGET_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeContractAddress(chainId, contractAddress) {
  const value = String(contractAddress || '').trim();
  return ['bsc', 'base', 'eth'].includes(String(chainId).toLowerCase())
    ? value.toLowerCase()
    : value;
}

function validateBudgetValues(data, chainConfigs = {}, existing = {}) {
  const chainId = String(data.chain_id ?? existing.chain_id ?? '').trim().toLowerCase();
  const budgetPerTrade = Number(data.budget_per_trade ?? existing.budget_per_trade);
  const totalBudget = Number(data.total_budget ?? existing.total_budget);
  if (!chainId) throw budgetError('chain_id is required');
  if (!Number.isFinite(budgetPerTrade) || budgetPerTrade <= 0) {
    throw budgetError('budget_per_trade must be a positive number');
  }
  if (!Number.isFinite(totalBudget) || totalBudget <= 0) {
    throw budgetError('total_budget must be a positive number');
  }
  if (budgetPerTrade > totalBudget) {
    throw budgetError('budget_per_trade cannot exceed total_budget');
  }

  const maxPerTrade = Number(chainConfigs[chainId]?.maxPerTrade);
  if (Number.isFinite(maxPerTrade) && maxPerTrade > 0 && budgetPerTrade > maxPerTrade) {
    const symbol = chainConfigs[chainId]?.nativeSymbol || chainId.toUpperCase();
    throw budgetError(
      `budget_per_trade exceeds the ${chainId} live limit of ${maxPerTrade} ${symbol}`,
      'WHITELIST_TRADE_AMOUNT_EXCEEDS_CHAIN_LIMIT'
    );
  }
  return { chain_id: chainId, budget_per_trade: budgetPerTrade, total_budget: totalBudget };
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

async function getWhitelists(filters) {
  return await queries.getAll(filters);
}

async function getWhitelist(id) {
  return await queries.getById(id);
}

async function addWhitelist(data) {
  if (!data.contract_address || !data.chain_id || !data.budget_per_trade || !data.total_budget) {
    throw new Error('Missing required fields: contract_address, chain_id, budget_per_trade, total_budget');
  }
  const relations = normalizeRelationInputs(data.relations);
  if (relations.length === 0) {
    throw new Error('At least one actor-to-project X relation is required');
  }
  const chainConfigs = await configService.get('chain_configs') || {};
  const budgets = validateBudgetValues(data, chainConfigs);
  const contractAddress = normalizeContractAddress(budgets.chain_id, data.contract_address);

  const result = await inTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [budgets.chain_id, contractAddress]
    );
    const existing = await queries.getActiveByContract(
      contractAddress,
      budgets.chain_id,
      client,
      { forUpdate: true }
    );
    if (existing) {
      const previousRelations = normalizeRelationInputs(existing.relations || []);
      const mergedRelations = normalizeRelationInputs([...previousRelations, ...relations]);
      await syncWhitelistRelations(existing.id, mergedRelations, client);
      return {
        whitelistId: existing.id,
        mergedIntoExisting: true,
        addedRelations: mergedRelations.length - previousRelations.length
      };
    }

    const whitelist = await queries.create({
      ...data,
      ...budgets,
      contract_address: contractAddress,
      project_x_handles: [...new Set(relations.map((relation) => relation.target_x_handle))]
    }, client);
    await syncWhitelistRelations(whitelist.id, relations, client);
    return {
      whitelistId: whitelist.id,
      mergedIntoExisting: false,
      addedRelations: relations.length
    };
  });
  return {
    item: await queries.getById(result.whitelistId),
    mergedIntoExisting: result.mergedIntoExisting,
    addedRelations: result.addedRelations
  };
}

async function updateWhitelist(id, data) {
  const relations = data.relations === undefined ? null : normalizeRelationInputs(data.relations);
  if (relations && relations.length === 0) {
    throw new Error('At least one actor-to-project X relation is required');
  }
  const chainConfigs = await configService.get('chain_configs') || {};

  await inTransaction(async (client) => {
    const current = await queries.getById(id, client);
    if (!current) throw new Error('Whitelist not found');
    const budgets = validateBudgetValues(data, chainConfigs, current);
    const whitelist = await queries.update(id, {
      ...data,
      ...budgets,
      project_x_handles: relations
        ? [...new Set(relations.map((relation) => relation.target_x_handle))]
        : undefined
    }, client);
    if (relations) await syncWhitelistRelations(id, relations, client);
  });
  return queries.getById(id);
}

async function changeStatus(id, status) {
  const validStatuses = ['active', 'paused', 'exhausted', 'expired'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  return await queries.updateStatus(id, status);
}

async function deleteWhitelist(id) {
  return await queries.remove(id);
}

module.exports = {
  getWhitelists,
  getWhitelist,
  addWhitelist,
  updateWhitelist,
  changeStatus,
  deleteWhitelist,
  normalizeContractAddress,
  validateBudgetValues
};
