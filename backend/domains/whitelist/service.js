const queries = require('./queries');

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
  return await queries.create(data);
}

async function updateWhitelist(id, data) {
  return await queries.update(id, data);
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

module.exports = { getWhitelists, getWhitelist, addWhitelist, updateWhitelist, changeStatus, deleteWhitelist };
