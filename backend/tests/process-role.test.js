const assert = require('node:assert/strict');
const test = require('node:test');
const { getProcessRole, roleCapabilities } = require('../lib/process-role');

test('production roles isolate 6551 ingestion from GMGN execution ownership', () => {
  assert.equal(getProcessRole({ args: ['--role=ingestion'], envRole: 'execution' }), 'ingestion');
  assert.deepEqual(roleCapabilities('ingestion'), {
    api: false,
    execution: false,
    ingestion: true
  });
  assert.deepEqual(roleCapabilities('execution'), {
    api: true,
    execution: true,
    ingestion: false
  });
});

test('unknown process roles fail closed', () => {
  assert.throws(
    () => getProcessRole({ args: [], envRole: 'worker' }),
    { code: 'PROCESS_ROLE_INVALID' }
  );
});
