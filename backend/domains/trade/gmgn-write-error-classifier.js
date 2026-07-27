const UNCERTAIN_CODES = new Set([
  'ABORT_ERR',
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
  'GMGN_INVALID_JSON',
  'GMGN_ORDER_ID_MISSING',
  'GMGN_RESPONSE_INVALID',
  'GMGN_SUBMISSION_UNCERTAIN'
]);

const DEFINITIVE_REJECTION_STATUSES = new Set([
  400, 401, 402, 403, 404, 405, 406, 410, 411, 412, 413, 414, 415, 416, 417, 422
]);

function statusOf(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return Number.isInteger(status) ? status : null;
}

function classifyWriteError(error, options = {}) {
  const status = statusOf(error);
  const code = String(error?.code || 'GMGN_WRITE_FAILED');
  if (status === 429 || code.includes('RATE_LIMIT') || code === 'ERROR_RATE_LIMIT_BLOCKED') {
    return { kind: 'blocked', code, retryEligible: false, quarantine: false };
  }
  if (DEFINITIVE_REJECTION_STATUSES.has(status)) {
    return { kind: 'rejected', code, retryEligible: false, quarantine: false };
  }
  if (options.writeStarted && (
    status === null
    || (status >= 400 && status < 500)
    || status >= 500
    || UNCERTAIN_CODES.has(code)
    || /timeout|network|socket|json/i.test(String(error?.message || ''))
  )) {
    return { kind: 'uncertain', code, retryEligible: false, quarantine: true };
  }
  return { kind: 'rejected', code, retryEligible: false, quarantine: false };
}

function isDefinitiveWriteRejection(error) {
  return classifyWriteError(error, { writeStarted: true }).kind === 'rejected';
}

function classifyProviderOrder(normalizedOrder) {
  const status = String(normalizedOrder?.status || 'unknown').toLowerCase();
  if (['failed', 'expired'].includes(status)) {
    return { kind: 'failure_verifying', code: normalizedOrder?.errorCode || `GMGN_ORDER_${status.toUpperCase()}` };
  }
  if (status === 'confirmed') return { kind: 'chain_verifying', code: null };
  return { kind: 'awaiting_result', code: null };
}

module.exports = {
  DEFINITIVE_REJECTION_STATUSES,
  UNCERTAIN_CODES,
  classifyProviderOrder,
  classifyWriteError,
  isDefinitiveWriteRejection,
  statusOf
};
