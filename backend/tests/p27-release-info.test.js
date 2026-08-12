const assert = require('node:assert/strict');
const test = require('node:test');
const { releaseInfo } = require('../lib/release-info');

test('P27 health separates the running release from the migration baseline', async () => {
  const previous = process.env.XBOT_RELEASE_SHA;
  try {
    delete process.env.XBOT_RELEASE_SHA;
    const executor = {
      query: async () => ({ rows: [{
        release_sha: 'a'.repeat(40),
        manifest_digest: 'b'.repeat(64),
        migration_count: 44,
        first_migration: '000_initial_schema.sql',
        last_migration: '043_p26_local_rpc_provenance.sql'
      }] })
    };
    const localInfo = await releaseInfo('execution', executor);
    assert.equal(localInfo.process_role, 'execution');
    assert.equal(localInfo.contract_version, 'p27.v1');
    assert.equal(localInfo.event_contract_version, 'p27.events.v1');
    assert.equal(localInfo.release_sha, null);
    assert.equal(localInfo.migration_manifest.release_sha, 'a'.repeat(40));

    process.env.XBOT_RELEASE_SHA = 'c'.repeat(40);
    const releaseInfoResult = await releaseInfo('execution', executor);
    assert.equal(releaseInfoResult.release_sha, 'c'.repeat(40));
    assert.equal(releaseInfoResult.migration_manifest.release_sha, 'a'.repeat(40));
    assert.equal(JSON.stringify(releaseInfoResult).includes('PRIVATE_KEY'), false);
  } finally {
    if (previous === undefined) delete process.env.XBOT_RELEASE_SHA;
    else process.env.XBOT_RELEASE_SHA = previous;
  }
});
