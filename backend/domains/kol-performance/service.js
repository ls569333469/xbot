const db = require('../../lib/db');
const { normalizeXHandle } = require('../../lib/x-handles');
const { normalizeMode } = require('./constants');
const { createKolPerformanceRepository } = require('./repository');

function parseId(value, label = 'Run') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error(`${label} id must be a positive integer`);
    error.code = 'KOL_PERFORMANCE_ID_INVALID';
    throw error;
  }
  return id;
}

function optionalIso(value, field) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    const error = new Error(`${field} must be an ISO timestamp`);
    error.code = 'KOL_PERFORMANCE_WINDOW_INVALID';
    throw error;
  }
  return new Date(timestamp).toISOString();
}

async function createPerformanceRun(input = {}, executor = db) {
  const mode = normalizeMode(input.mode);
  const actor_handle = normalizeXHandle(input.actor_handle || input.handle);
  const sample_started_at = optionalIso(input.sample_started_at, 'sample_started_at');
  const sample_ended_at = optionalIso(input.sample_ended_at, 'sample_ended_at');
  if (!mode || !actor_handle || (sample_started_at && sample_ended_at && sample_started_at > sample_ended_at)) {
    const error = new Error('A mode, one X handle, and a valid time window are required');
    error.code = 'KOL_PERFORMANCE_INPUT_INVALID';
    throw error;
  }
  const repository = createKolPerformanceRepository(executor);
  const active = await repository.findActiveRun(mode, actor_handle);
  if (active) return { ...active, deduplicated: true };
  return repository.insertRun({ mode, actor_handle, sample_started_at, sample_ended_at, as_of_at: new Date().toISOString() });
}

async function listPerformanceRuns(mode, requestedLimit, executor = db) {
  const normalized = normalizeMode(mode);
  if (!normalized) {
    const error = new Error('A valid KOL performance mode is required');
    error.code = 'KOL_PERFORMANCE_MODE_INVALID';
    throw error;
  }
  return createKolPerformanceRepository(executor).listRuns(normalized, requestedLimit);
}

async function getPerformanceRun(id, executor = db) {
  return createKolPerformanceRepository(executor).getRun(parseId(id));
}

async function retryPerformancePrices(id, executor = db) {
  return createKolPerformanceRepository(executor).retryPrices(parseId(id));
}

async function createProfileRun(input = {}, executor = db) {
  const actorHandle = normalizeXHandle(input.actor_handle || input.handle);
  if (!actorHandle) {
    const error = new Error('One X handle is required for an account profile');
    error.code = 'KOL_PROFILE_INPUT_INVALID';
    throw error;
  }
  const repository = createKolPerformanceRepository(executor);
  const active = await repository.findActiveProfile(actorHandle);
  if (active) return { ...active, deduplicated: true };
  return repository.insertProfileRun(actorHandle);
}

async function getProfileRun(id, executor = db) {
  return createKolPerformanceRepository(executor).getProfileRun(parseId(id, 'Profile run'));
}

async function listProfileRuns(requestedLimit, executor = db) {
  return createKolPerformanceRepository(executor).listProfileRuns(requestedLimit);
}

module.exports = {
  createPerformanceRun,
  createProfileRun,
  getPerformanceRun,
  getProfileRun,
  listPerformanceRuns,
  listProfileRuns,
  retryPerformancePrices
};
