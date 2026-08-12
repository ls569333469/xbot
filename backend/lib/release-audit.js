const FORBIDDEN_RELEASE_PATH = /(^|\/)(?:\.env(?:\.|$)|[^/]+\.(?:pem|key|p12|pfx|log|dump|sqlite|sqlite3|db|bak)$|dist(?:\/|$))/i;
const SECRET_PATTERNS = Object.freeze([
  { code: 'GMGN_API_KEY', pattern: /gmgn_[a-f0-9]{32}/i },
  { code: 'XAI_API_KEY', pattern: /xai-[a-z0-9_-]{20,}/i },
  { code: 'GENERIC_API_KEY', pattern: /sk-[a-z0-9_-]{20,}/i },
  {
    code: 'PRIVATE_KEY_PEM',
    pattern: /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----[\s\S]{80,}?-----END \1-----/
  }
]);

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function allowlistPatternRegex(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          expression += '(?:.*/)?';
        } else {
          expression += '.*';
        }
      } else {
        expression += '[^/]*';
      }
      continue;
    }
    expression += character.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&');
  }
  return new RegExp(`${expression}$`);
}

function parseReleaseAllowlist(value) {
  const rules = [];
  const seen = new Set();
  for (const [index, sourceLine] of String(value || '').split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const excluded = line.startsWith('!');
    const pattern = normalizePath(excluded ? line.slice(1) : line);
    const invalid = !pattern
      || pattern.startsWith('/')
      || /^[a-z]:/i.test(pattern)
      || pattern.split('/').includes('..')
      || /[?\[\]{}]/.test(pattern);
    if (invalid) {
      const error = new Error(`Invalid release allowlist rule on line ${index + 1}`);
      error.code = 'INVALID_RELEASE_ALLOWLIST_RULE';
      throw error;
    }
    if (seen.has(line)) {
      const error = new Error(`Duplicate release allowlist rule on line ${index + 1}`);
      error.code = 'DUPLICATE_RELEASE_ALLOWLIST_RULE';
      throw error;
    }
    seen.add(line);
    rules.push({ excluded, pattern, regex: allowlistPatternRegex(pattern) });
  }
  if (!rules.some((rule) => !rule.excluded)) {
    const error = new Error('Release allowlist must contain at least one include rule');
    error.code = 'EMPTY_RELEASE_ALLOWLIST';
    throw error;
  }
  return rules;
}

function releaseCandidates(files, rules) {
  const includeRules = rules.filter((rule) => !rule.excluded);
  const excludeRules = rules.filter((rule) => rule.excluded);
  return [...new Set(files.map(normalizePath))]
    .filter((file) => includeRules.some((rule) => rule.regex.test(file)))
    .filter((file) => !excludeRules.some((rule) => rule.regex.test(file)))
    .sort();
}

function forbiddenReleasePath(value) {
  const file = normalizePath(value);
  if (/(^|\/)\.env\.example$/i.test(file)) return false;
  return FORBIDDEN_RELEASE_PATH.test(file);
}

function contentAuditExcluded(value) {
  const file = normalizePath(value);
  return file.startsWith('docs/external/') || /(^|\/)\.env\.example$/i.test(file);
}

function secretCodes(value) {
  const text = String(value || '');
  return SECRET_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.code);
}

module.exports = {
  SECRET_PATTERNS,
  allowlistPatternRegex,
  contentAuditExcluded,
  forbiddenReleasePath,
  normalizePath,
  parseReleaseAllowlist,
  releaseCandidates,
  secretCodes
};
