const FLAG_KEYS = Object.freeze([
  'P20_CANDIDATE_INDEX_ENABLED',
  'P20_DYNAMIC_RESOLUTION_ENABLED',
  'P20_RECORD_ENABLED',
  'P20_PAPER_ENABLED',
  'P20_LIVE_ENABLED'
]);

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function p20FeatureState(env = process.env) {
  return Object.fromEntries(FLAG_KEYS.map((key) => [key, enabled(env[key])]));
}

function assertP20ReadOnly(env = process.env) {
  const state = p20FeatureState(env);
  const unsupported = [
    'P20_RECORD_ENABLED',
    'P20_PAPER_ENABLED',
    'P20_LIVE_ENABLED'
  ].filter((key) => state[key]);
  if (unsupported.length > 0) {
    const error = new Error(`P20.1 cannot enable runtime stages: ${unsupported.join(', ')}`);
    error.code = 'P20_STAGE_NOT_IMPLEMENTED';
    throw error;
  }
  return state;
}

module.exports = {
  FLAG_KEYS,
  assertP20ReadOnly,
  enabled,
  p20FeatureState
};
