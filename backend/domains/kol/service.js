const queries = require('./queries');

async function getKols() {
  return await queries.getAll();
}

async function getKol(id) {
  return await queries.getById(id);
}

async function addKol(data) {
  if (!data.x_handle) {
    throw new Error('x_handle is required');
  }
  return await queries.create(data);
}

async function updateKol(id, data) {
  return await queries.update(id, data);
}

async function toggleKol(id) {
  return await queries.toggle(id);
}

async function deleteKol(id) {
  return await queries.remove(id);
}

async function getKolActivities(id, limit) {
  return await queries.getActivities(id, limit);
}

module.exports = { getKols, getKol, addKol, updateKol, toggleKol, deleteKol, getKolActivities };
