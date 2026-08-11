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
  const profile = normalizeProfile(env.GMGN_CREDENTIAL_PROFILE);
  const prefix = profile === 'test' ? 'GMGN_TEST_' : 'GMGN_';
  return {
    profile,
    apiKey: String(env[`${prefix}API_KEY`] || '').trim(),
    privateKey: String(env[`${prefix}PRIVATE_KEY`] || '').replace(/\\n/g, '\n').trim()
  };
}

function credentialKeys(profile) {
  return normalizeProfile(profile) === 'test'
    ? ['GMGN_TEST_API_KEY', 'GMGN_TEST_PRIVATE_KEY']
    : ['GMGN_API_KEY', 'GMGN_PRIVATE_KEY'];
}

module.exports = { PROFILES, credentialKeys, getGmgnCredentials, normalizeProfile };
