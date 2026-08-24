const db = require('../../lib/db');

const MAX_GROK_REQUESTS = 2;
const MAX_SEARCH_TOOL_CALLS = 8;
const MAX_EVIDENCE_LENGTH = 20000;
const SECOND_REQUEST_REASONS = new Set(['format_repair', 'targeted_followup']);

function budgetError() {
  const error = new Error('Grok request budget is exhausted for this research report');
  error.code = 'XAI_GROK_REQUEST_BUDGET_EXHAUSTED';
  error.status = 409;
  return error;
}

function searchToolBudgetError() {
  const error = new Error('Public search tool budget is exhausted for this research report');
  error.code = 'XAI_SEARCH_TOOL_BUDGET_EXHAUSTED';
  error.status = 409;
  return error;
}

function normalizeEvidence(value) {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, MAX_EVIDENCE_LENGTH);
}

function normalizeCitations(values) {
  return Array.isArray(values) ? values.slice(0, 30) : [];
}

async function ensureCheckpoint(report, options = {}) {
  const executor = options.executor || db;
  const result = await executor.query(
    `INSERT INTO token_research_xai_checkpoints
      (report_id, prompt_version, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (report_id) DO UPDATE SET
       prompt_version = EXCLUDED.prompt_version,
       search_status = CASE
         WHEN token_research_xai_checkpoints.prompt_version <> EXCLUDED.prompt_version
           THEN 'pending'
         ELSE token_research_xai_checkpoints.search_status
       END,
       evidence_text = CASE
         WHEN token_research_xai_checkpoints.prompt_version <> EXCLUDED.prompt_version
           THEN NULL
         ELSE token_research_xai_checkpoints.evidence_text
       END,
       citations = CASE
         WHEN token_research_xai_checkpoints.prompt_version <> EXCLUDED.prompt_version
           THEN '[]'::jsonb
         ELSE token_research_xai_checkpoints.citations
       END,
       search_usage = CASE
         WHEN token_research_xai_checkpoints.prompt_version <> EXCLUDED.prompt_version
           THEN NULL
         ELSE token_research_xai_checkpoints.search_usage
       END,
       search_tool_calls = CASE
         WHEN token_research_xai_checkpoints.prompt_version <> EXCLUDED.prompt_version
           THEN 0
         ELSE token_research_xai_checkpoints.search_tool_calls
       END,
       grok_request_attempts = CASE
         WHEN token_research_xai_checkpoints.prompt_version <> EXCLUDED.prompt_version
           THEN 0
         ELSE token_research_xai_checkpoints.grok_request_attempts
       END,
       second_request_reason = CASE
         WHEN token_research_xai_checkpoints.prompt_version <> EXCLUDED.prompt_version
           THEN NULL
         ELSE token_research_xai_checkpoints.second_request_reason
       END,
       last_error_code = CASE
         WHEN token_research_xai_checkpoints.prompt_version <> EXCLUDED.prompt_version
           THEN NULL
         ELSE token_research_xai_checkpoints.last_error_code
       END,
       expires_at = EXCLUDED.expires_at,
       updated_at = CASE
         WHEN token_research_xai_checkpoints.prompt_version <> EXCLUDED.prompt_version
           THEN NOW()
         ELSE token_research_xai_checkpoints.updated_at
       END
     RETURNING *`,
    [report.id, report.prompt_version, report.expires_at]
  );
  return result.rows[0];
}

async function getCheckpoint(reportId, options = {}) {
  const executor = options.executor || db;
  const result = await executor.query(
    'SELECT * FROM token_research_xai_checkpoints WHERE report_id = $1',
    [reportId]
  );
  return result.rows[0] || null;
}

async function getCheckpoints(reportIds, options = {}) {
  const ids = [...new Set((reportIds || []).filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();
  const executor = options.executor || db;
  const result = await executor.query(
    'SELECT * FROM token_research_xai_checkpoints WHERE report_id = ANY($1::bigint[])',
    [ids]
  );
  return new Map(result.rows.map((row) => [String(row.report_id), row]));
}

async function reserveRequest(reportId, phase, options = {}) {
  const executor = options.executor || db;
  const reason = options.reason || null;
  if (reason && !SECOND_REQUEST_REASONS.has(reason)) {
    throw new TypeError('Invalid second Grok request reason');
  }
  const result = await executor.query(
    `UPDATE token_research_xai_checkpoints
     SET grok_request_attempts = grok_request_attempts + 1,
         search_status = $2,
         second_request_reason = CASE
           WHEN grok_request_attempts = 1 THEN $3::text
           ELSE second_request_reason
         END,
         last_error_code = NULL,
         updated_at = NOW()
     WHERE report_id = $1
       AND grok_request_attempts < $4
       AND (grok_request_attempts = 0 OR $3::text IS NOT NULL)
     RETURNING *`,
    [reportId, phase, reason, MAX_GROK_REQUESTS]
  );
  if (!result.rows[0]) throw budgetError();
  return result.rows[0];
}

async function recordResponse(reportId, values = {}, options = {}) {
  const executor = options.executor || db;
  const searchToolCalls = Math.max(0, Math.floor(Number(values.search_tool_calls) || 0));
  const result = await executor.query(
    `UPDATE token_research_xai_checkpoints
     SET search_status = $2,
         evidence_text = COALESCE($3, evidence_text),
         citations = $4::jsonb,
         search_usage = $5::jsonb,
         search_tool_calls = LEAST($6, search_tool_calls + $7),
         last_error_code = $8,
         updated_at = NOW()
     WHERE report_id = $1
     RETURNING *`,
    [
      reportId,
      values.search_status || 'failed',
      normalizeEvidence(values.evidence_text),
      JSON.stringify(normalizeCitations(values.citations)),
      values.search_usage ? JSON.stringify(values.search_usage) : null,
      MAX_SEARCH_TOOL_CALLS,
      searchToolCalls,
      values.last_error_code || null
    ]
  );
  return result.rows[0] || null;
}

function socialSourceStatus(metadata = {}) {
  if (metadata.social_source_status) return metadata.social_source_status;
  return metadata.official_x_handle ? 'found' : 'missing';
}

function toSocialResolution(checkpoint, report = {}) {
  const metadata = report.provider_snapshot?.metadata || {};
  const snapshot = report.provider_snapshot?.xai || {};
  const resolvedOfficial = (report.candidates || []).find((candidate) => (
    candidate.role === 'official_project'
      && ['verified', 'high'].includes(candidate.confidence)
  ));
  const attempts = Number(checkpoint?.grok_request_attempts || 0);
  const searchCalls = Number(checkpoint?.search_tool_calls || 0);
  const checkpointStatus = checkpoint?.search_status || (snapshot.status === 'failed' ? 'failed' : 'pending');
  let status = checkpointStatus;
  if (checkpointStatus === 'completed') {
    status = metadata.official_x_handle
      ? 'gmgn_confirmed'
      : resolvedOfficial?.verified ? 'grok_verified' : 'grok_candidate';
  } else if (checkpointStatus === 'failed') {
    status = 'provider_failed';
  }
  const source = metadata.official_x_handle
    ? (resolvedOfficial?.source?.includes('xai') ? 'gmgn+grok' : 'gmgn')
    : resolvedOfficial ? 'grok' : null;
  return {
    status,
    gmgn_status: socialSourceStatus(metadata),
    official_handle: metadata.official_x_handle || resolvedOfficial?.handle || null,
    source,
    confidence: resolvedOfficial?.confidence || null,
    grok_request_attempts: attempts,
    grok_request_limit: MAX_GROK_REQUESTS,
    search_tool_calls: searchCalls,
    search_tool_call_limit: MAX_SEARCH_TOOL_CALLS,
    second_request_reason: checkpoint?.second_request_reason || null,
    last_error_code: checkpoint?.last_error_code || report.xai_error_code || null,
    retry_allowed: attempts < MAX_GROK_REQUESTS
      && searchCalls < MAX_SEARCH_TOOL_CALLS
      && !['gmgn_confirmed', 'grok_verified', 'grok_candidate'].includes(status)
  };
}

function withSocialResolution(report, checkpoint) {
  if (!report) return report;
  return { ...report, social_resolution: toSocialResolution(checkpoint, report) };
}

module.exports = {
  MAX_EVIDENCE_LENGTH,
  MAX_GROK_REQUESTS,
  MAX_SEARCH_TOOL_CALLS,
  budgetError,
  searchToolBudgetError,
  ensureCheckpoint,
  getCheckpoint,
  getCheckpoints,
  recordResponse,
  reserveRequest,
  socialSourceStatus,
  toSocialResolution,
  withSocialResolution
};
