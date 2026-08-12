const PROFILES = new Set(['primary', 'test']);

function normalizeProfile(value) {
  const profile = String(value === undefined ? (process.env.GMGN_CREDENTIAL_PROFILE || 'primary') : value)
    .trim().toLowerCase();
  if (!PROFILES.has(profile)) {
    const error = new Error(`GMGN_CREDENTIAL_PROFILE must be primary or test, received: ${profile}`);
    error.code = 'GMGN_CREDENTIAL_PROFILE_INVALID';
    throw error;
  }
  return profile;
}

function getGmgnCredentials(env = process.env) {
  const profile = normalizeProfile(env.GMGN_CREDENTIAL_PROFILE ?? 'primary');
  const prefix = profile === 'test' ? 'GMGN_TEST_' : 'GMGN_';
  return {
    profile,
    apiKey: String(env[`${prefix}API_KEY`] || '').trim(),
    privateKey: String(env[`${prefix}PRIVATE_KEY`] || '').replace(/\\n/g, '\n').trim()
  };
}

function assertCredentialProfileForEnvironment(env = process.env) {
  const profile = normalizeProfile(env.GMGN_CREDENTIAL_PROFILE ?? 'primary');
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv === 'production' && profile !== 'primary') {
    const error = new Error('Production requires GMGN_CREDENTIAL_PROFILE=primary');
    error.code = 'GMGN_TEST_PROFILE_FORBIDDEN_IN_PRODUCTION';
    throw error;
  }
  return profile;
}

function credentialKeys(profile) {
  return normalizeProfile(profile) === 'test'
    ? ['GMGN_TEST_API_KEY', 'GMGN_TEST_PRIVATE_KEY']
    : ['GMGN_API_KEY', 'GMGN_PRIVATE_KEY'];
}

module.exports = {
  PROFILES,
  assertCredentialProfileForEnvironment,
  credentialKeys,
  getGmgnCredentials,
  normalizeProfile
};
