const assert = require('node:assert/strict');
const test = require('node:test');
const {
  forbiddenReleasePath,
  parseReleaseAllowlist,
  releaseCandidates,
  secretCodes
} = require('../lib/release-audit');

test('P27 release path policy excludes secrets, logs, dumps, and build output', () => {
  for (const file of [
    'backend/.env', 'private_key.pem', 'frontend/vite.log',
    'database.dump', 'frontend/dist/index.html'
  ]) {
    assert.equal(forbiddenReleasePath(file), true, file);
  }
  assert.equal(forbiddenReleasePath('backend/db/migrations/046.sql'), false);
  assert.equal(forbiddenReleasePath('frontend/src/index.css'), false);
  assert.equal(forbiddenReleasePath('backend/.env.example'), false);
});

test('P27 content policy identifies credential material without returning values', () => {
  const gmgn = ['gmgn_', 'a'.repeat(32)].join('');
  const pem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(96)}\n-----END PRIVATE KEY-----`;
  assert.deepEqual(secretCodes(gmgn), ['GMGN_API_KEY']);
  assert.deepEqual(secretCodes(pem), ['PRIVATE_KEY_PEM']);
  assert.deepEqual(secretCodes('-----BEGIN PRIVATE KEY-----'), []);
  assert.deepEqual(secretCodes('GMGN_API_KEY=example'), []);
});

test('P27 release allowlist selects runtime assets and excludes tests and local files', () => {
  const rules = parseReleaseAllowlist(`
backend/server.js
backend/domains/**
frontend/src/**
!**/*.log
!backend/domains/private/**
  `);
  assert.deepEqual(releaseCandidates([
    'backend/server.js',
    'backend/domains/trade/routes.js',
    'backend/domains/private/key.js',
    'backend/tests/trade.test.js',
    'frontend/src/index.css',
    'frontend/src/vite.log'
  ], rules), [
    'backend/domains/trade/routes.js',
    'backend/server.js',
    'frontend/src/index.css'
  ]);
});

test('P27 release allowlist rejects unsafe, duplicate, and empty rules', () => {
  assert.throws(() => parseReleaseAllowlist('../backend/**'), { code: 'INVALID_RELEASE_ALLOWLIST_RULE' });
  assert.throws(() => parseReleaseAllowlist('backend/**\nbackend/**'), { code: 'DUPLICATE_RELEASE_ALLOWLIST_RULE' });
  assert.throws(() => parseReleaseAllowlist('# no includes\n!**/*.log'), { code: 'EMPTY_RELEASE_ALLOWLIST' });
});
