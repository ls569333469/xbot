const queries = require('./queries');
const { createXClient } = require('../../lib/x-client');
const { normalizeXHandle } = require('../../lib/x-handles');

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

  const xHandle = normalizeXHandle(data.x_handle);
  const profile = await createXClient().getUserProfile(xHandle);
  return await queries.create({
    ...data,
    x_user_id: profile.id,
    x_handle: profile.handle || xHandle,
    display_name: data.display_name || profile.name || xHandle
  });
}

async function updateKol(id, data) {
  const normalized = { ...data };
  if (data.x_handle !== undefined) {
    const xHandle = normalizeXHandle(data.x_handle);
    const profile = await createXClient().getUserProfile(xHandle);
    normalized.x_user_id = profile.id;
    normalized.x_handle = profile.handle || xHandle;
    if (!data.display_name) normalized.display_name = profile.name || xHandle;
  }
  return await queries.update(id, normalized);
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
