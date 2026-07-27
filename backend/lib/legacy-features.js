function flagEnabled(name, env = process.env) {
  return String(env[name] || 'false').trim().toLowerCase() === 'true';
}

function legacyXProvidersEnabled(env = process.env) {
  return flagEnabled('XBOT_LEGACY_X_PROVIDERS_ENABLED', env);
}

function legacyPaperEnabled(env = process.env) {
  return flagEnabled('XBOT_LEGACY_PAPER_ENABLED', env);
}

function legacyShadowEnabled(env = process.env) {
  return flagEnabled('XBOT_LEGACY_SHADOW_ENABLED', env);
}

module.exports = {
  flagEnabled,
  legacyPaperEnabled,
  legacyShadowEnabled,
  legacyXProvidersEnabled
};
