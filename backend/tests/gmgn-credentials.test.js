const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertCredentialProfileForEnvironment,
  credentialKeys,
  getGmgnCredentials,
  normalizeProfile
} = require('../lib/gmgn-credentials');

test('GMGN credentials default to the primary profile', () => {
  assert.equal(normalizeProfile(undefined), 'primary');
  assert.deepEqual(credentialKeys('primary'), ['GMGN_API_KEY', 'GMGN_PRIVATE_KEY']);
  assert.deepEqual(getGmgnCredentials({
    GMGN_API_KEY: 'gmgn-primary',
    GMGN_PRIVATE_KEY: 'primary-private'
  }), {
    profile: 'primary', apiKey: 'gmgn-primary', privateKey: 'primary-private'
  });
});

test('production rejects the isolated GMGN test profile', () => {
  assert.equal(assertCredentialProfileForEnvironment({
    NODE_ENV: 'production', GMGN_CREDENTIAL_PROFILE: 'primary'
  }), 'primary');
  assert.equal(assertCredentialProfileForEnvironment({
    NODE_ENV: 'development', GMGN_CREDENTIAL_PROFILE: 'test'
  }), 'test');
  assert.throws(() => assertCredentialProfileForEnvironment({
    NODE_ENV: 'production', GMGN_CREDENTIAL_PROFILE: 'test'
  }), { code: 'GMGN_TEST_PROFILE_FORBIDDEN_IN_PRODUCTION' });
});

test('test profile is isolated from primary credentials', () => {
  assert.deepEqual(credentialKeys('test'), ['GMGN_TEST_API_KEY', 'GMGN_TEST_PRIVATE_KEY']);
  assert.deepEqual(getGmgnCredentials({
    GMGN_CREDENTIAL_PROFILE: 'test',
    GMGN_API_KEY: 'gmgn-primary',
    GMGN_PRIVATE_KEY: 'primary-private',
    GMGN_TEST_API_KEY: 'gmgn-test',
    GMGN_TEST_PRIVATE_KEY: 'test-private\\n'
  }), {
    profile: 'test', apiKey: 'gmgn-test', privateKey: 'test-private'
  });
});

test('invalid GMGN credential profile fails closed', () => {
  assert.throws(() => normalizeProfile('staging'), { code: 'GMGN_CREDENTIAL_PROFILE_INVALID' });
});
