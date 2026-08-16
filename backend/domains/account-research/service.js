const db = require('../../lib/db');
const { createAccountResearchRepository } = require('./repository');

const RESEARCH_REVISION = 'p32-account-research-v1';

function parseRunId(id) {
  const value = Number(id);
  if (!Number.isSafeInteger(value) || value < 1) {
    const error = new Error('Account research run id must be a positive integer');
    error.code = 'ACCOUNT_RESEARCH_ID_INVALID';
    throw error;
  }
  return value;
}

function parseLimit(limit) {
  const value = Number(limit);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(100, value) : 50;
}

async function getRun(id, executor = db) {
  const runId = parseRunId(id);
  return createAccountResearchRepository(executor).getRun(runId, RESEARCH_REVISION);
}

async function listRuns(limit = 50, executor = db) {
  return createAccountResearchRepository(executor).listRuns(parseLimit(limit), RESEARCH_REVISION);
}

module.exports = { RESEARCH_REVISION, getRun, listRuns };
