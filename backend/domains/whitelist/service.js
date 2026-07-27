const db = require('../../lib/db');
const queries = require('./queries');
const {
  normalizeProjectAccounts,
  normalizeRelationInputs,
  normalizeSourceInputs,
  retainRelevantProjectAccounts,
  syncWhitelistProjectAccounts,
  syncWhitelistRelations,
  syncWhitelistSourceRules
} = require('./relations');
const { enqueueWatchSyncForHandles } = require('../x-monitor/6551/watch-sync-outbox');
const {
  enqueueWhitelistActivation,
  retryWhitelistActivation
} = require('./activation-outbox');
const { validateTokenAddress } = require('../trade/chain-adapters');
const {
  legacyPercentages,
  normalizeExitStrategy
} = require('../trade/exit-strategy-compiler');

function budgetError(message, code = 'WHITELIST_BUDGET_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeContractAddress(chainId, contractAddress) {
  const value = String(contractAddress || '').trim();
  return ['bsc', 'base', 'eth', 'robinhood'].includes(String(chainId).toLowerCase())
    ? value.toLowerCase()
    : value;
}

function validateBudgetValues(data, existing = {}) {
  const chainId = String(data.chain_id ?? existing.chain_id ?? '').trim().toLowerCase();
  const budgetPerTrade = Number(data.budget_per_trade ?? existing.budget_per_trade);
  const totalBudget = Number(data.total_budget ?? existing.total_budget);
  const slippage = Number(data.slippage ?? existing.slippage ?? 10);
  const allowRepeatBuy = data.allow_repeat_buy ?? existing.allow_repeat_buy ?? false;
  const requestedMaxRepeatBuys = Number(data.max_repeat_buys ?? existing.max_repeat_buys ?? 1);
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
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 100) {
    throw budgetError('slippage must be between 0 and 100');
  }
  if (typeof allowRepeatBuy !== 'boolean') {
    throw budgetError('allow_repeat_buy must be a boolean');
  }
  if (!Number.isSafeInteger(requestedMaxRepeatBuys) || requestedMaxRepeatBuys < 1) {
    throw budgetError('max_repeat_buys must be a positive integer');
  }

  return {
    chain_id: chainId,
    budget_per_trade: budgetPerTrade,
    total_budget: totalBudget,
    slippage,
    allow_repeat_buy: allowRepeatBuy,
    max_repeat_buys: allowRepeatBuy ? requestedMaxRepeatBuys : 1
  };
}

function prepareStrategy(data, existing = null) {
  const requested = data.exit_strategy === undefined ? existing?.exit_strategy : data.exit_strategy;
  const strategy = normalizeExitStrategy(requested, data.exit_strategy === undefined ? existing || data : data);
  const legacy = legacyPercentages(strategy);
  const changed = !existing || JSON.stringify(strategy) !== JSON.stringify(existing.exit_strategy);
  return {
    exit_strategy: strategy,
    exit_strategy_version: existing
      ? Number(existing.exit_strategy_version || 1) + (changed ? 1 : 0)
      : 1,
    ...legacy
  };
}

function triggerHandles(relations = [], sources = []) {
  return [
    ...relations.map((relation) => relation.actor_handle),
    ...sources.map((source) => source.actor_handle)
  ];
}

function configurableSources(values) {
  const sources = normalizeSourceInputs(values);
  const unsupported = sources.find((source) => source.source_kind !== 'ecosystem');
  if (unsupported) {
    throw new Error('Fixed-CA whitelists only accept ecosystem direct sources');
  }
  return sources;
}

function activePersistedSources(values) {
  return normalizeSourceInputs((Array.isArray(values) ? values : []).filter((source) => (
    source.enabled !== false && source.source_kind !== 'project'
  )));
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

async function previewWatchImpact(data) {
  const relations = normalizeRelationInputs(data.relations);
  const sources = configurableSources(data.direct_sources);
  const handles = [...new Set(triggerHandles(relations, sources))].sort();
  if (handles.length === 0) {
    return { unique_handles: 0, reused_watches: 0, new_watches: 0, handles: [] };
  }
  const result = await db.query(
    `SELECT username, managed, sync_status
     FROM x_provider_watches
     WHERE provider = '6551' AND username = ANY($1::text[])`,
    [handles]
  );
  const existing = new Map(result.rows.map((row) => [row.username, row]));
  return {
    unique_handles: handles.length,
    reused_watches: handles.filter((handle) => existing.has(handle)).length,
    new_watches: handles.filter((handle) => !existing.has(handle)).length,
    handles: handles.map((handle) => ({
      handle,
      watch_status: existing.get(handle)?.sync_status || 'new'
    }))
  };
}

async function addWhitelist(data) {
  if (!data.contract_address || !data.chain_id || !data.budget_per_trade || !data.total_budget) {
    throw new Error('Missing required fields: contract_address, chain_id, budget_per_trade, total_budget');
  }
  const relations = normalizeRelationInputs(data.relations);
  const sources = configurableSources(data.direct_sources);
  if (relations.length === 0 && sources.length === 0) {
    throw new Error('At least one direct source or actor-to-project X relation is required');
  }
  const budgets = validateBudgetValues(data);
  const strategy = prepareStrategy(data);
  const contractAddress = validateTokenAddress(budgets.chain_id, data.contract_address);

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
      const previousSources = activePersistedSources(existing.direct_sources || []);
      const mergedRelations = normalizeRelationInputs([...previousRelations, ...relations]);
      const mergedSources = normalizeSourceInputs([...previousSources, ...sources]);
      const projectAccounts = normalizeProjectAccounts(
        [...(existing.project_accounts || []), ...(data.project_accounts || [])],
        mergedRelations,
        mergedSources
      );
      await syncWhitelistRelations(existing.id, mergedRelations, client);
      await syncWhitelistSourceRules(existing.id, mergedSources, client);
      await syncWhitelistProjectAccounts(existing.id, projectAccounts, client);
      await enqueueWatchSyncForHandles(triggerHandles(mergedRelations, mergedSources), client);
      if (mergedRelations.length !== previousRelations.length
          || mergedSources.length !== previousSources.length) {
        await enqueueWhitelistActivation(existing.id, client);
      }
      return {
        whitelistId: existing.id,
        mergedIntoExisting: true,
        addedRelations: mergedRelations.length - previousRelations.length,
        addedSources: mergedSources.length - previousSources.length
      };
    }

    const whitelist = await queries.create({
      ...data,
      ...budgets,
      ...strategy,
      contract_address: contractAddress,
      project_x_handles: []
    }, client);
    await syncWhitelistRelations(whitelist.id, relations, client);
    await syncWhitelistSourceRules(whitelist.id, sources, client);
    await syncWhitelistProjectAccounts(
      whitelist.id,
      normalizeProjectAccounts(data.project_accounts, relations, sources),
      client
    );
    await enqueueWatchSyncForHandles(triggerHandles(relations, sources), client);
    await enqueueWhitelistActivation(whitelist.id, client, { increment: false });
    return {
      whitelistId: whitelist.id,
      mergedIntoExisting: false,
      addedRelations: relations.length,
      addedSources: sources.length
    };
  });
  return {
    item: await queries.getById(result.whitelistId),
    mergedIntoExisting: result.mergedIntoExisting,
    addedRelations: result.addedRelations,
    addedSources: result.addedSources
  };
}

async function updateWhitelist(id, data) {
  const relations = data.relations === undefined ? null : normalizeRelationInputs(data.relations);
  const requestedSources = data.direct_sources === undefined
    ? null
    : configurableSources((data.direct_sources || []).filter((source) => (
      source.source_kind === 'ecosystem'
    )));
  await inTransaction(async (client) => {
    const current = await queries.getById(id, client);
    if (!current) throw new Error('Whitelist not found');
    const finalRelations = relations || normalizeRelationInputs(current.relations || []);
    const persistedSources = activePersistedSources(current.direct_sources || []);
    const launchSources = persistedSources.filter((source) => source.source_kind === 'launch');
    const finalSources = requestedSources === null
      ? persistedSources
      : normalizeSourceInputs([...launchSources, ...requestedSources]);
    if (finalRelations.length === 0 && finalSources.length === 0) {
      throw new Error('At least one direct source or actor-to-project X relation is required');
    }
    const budgets = validateBudgetValues(data, current);
    const strategy = prepareStrategy(data, current);
    await queries.update(id, {
      ...data,
      ...budgets,
      ...strategy,
      project_x_handles: undefined
    }, client);
    if (relations) await syncWhitelistRelations(id, relations, client);
    if (requestedSources !== null) await syncWhitelistSourceRules(id, finalSources, client);
    await syncWhitelistProjectAccounts(
      id,
      normalizeProjectAccounts(
        data.project_accounts === undefined
          ? retainRelevantProjectAccounts(current.project_accounts, finalRelations, finalSources)
          : data.project_accounts,
        finalRelations,
        finalSources
      ),
      client
    );
    const actorHandles = [
      ...triggerHandles(current.relations || [], current.direct_sources || []),
      ...triggerHandles(finalRelations, finalSources)
    ];
    await enqueueWatchSyncForHandles(actorHandles, client);
    const activationKeys = [
      'budget_per_trade', 'total_budget', 'slippage', 'allow_repeat_buy',
      'max_repeat_buys', 'exit_strategy', 'expires_at'
    ];
    const activationRelevant = relations !== null || requestedSources !== null
      || activationKeys.some((key) => data[key] !== undefined);
    if (activationRelevant && current.status === 'active') {
      await enqueueWhitelistActivation(id, client);
    }
  });
  return queries.getById(id);
}

async function changeStatus(id, status) {
  const validStatuses = ['active', 'paused', 'exhausted', 'expired'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  return inTransaction(async (client) => {
    const current = await queries.getById(id, client);
    if (!current) throw new Error('Whitelist not found');
    const item = await queries.updateStatus(id, status, client);
    await enqueueWatchSyncForHandles(
      triggerHandles(current.relations || [], current.direct_sources || []),
      client
    );
    if (status === 'active') await enqueueWhitelistActivation(id, client);
    return item;
  });
}

async function retryActivation(id) {
  return inTransaction(async (client) => {
    const current = await queries.getById(id, client);
    if (!current) throw new Error('Whitelist not found');
    if (current.status !== 'active') {
      const error = new Error('Only active whitelists can be synchronized');
      error.code = 'WHITELIST_NOT_ACTIVE';
      throw error;
    }
    await retryWhitelistActivation(id, client);
    return queries.getById(id, client);
  });
}

async function deleteWhitelist(id) {
  return inTransaction(async (client) => {
    const current = await queries.getById(id, client);
    if (!current) return true;
    if (current.status === 'archived') return true;
    await queries.archive(id, client);
    await enqueueWatchSyncForHandles(
      triggerHandles(current.relations || [], current.direct_sources || []),
      client
    );
    return true;
  });
}

module.exports = {
  getWhitelists,
  getWhitelist,
  previewWatchImpact,
  addWhitelist,
  updateWhitelist,
  changeStatus,
  deleteWhitelist,
  retryActivation,
  normalizeContractAddress,
  prepareStrategy,
  triggerHandles,
  validateBudgetValues
};
