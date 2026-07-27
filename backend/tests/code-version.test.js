const assert = require('node:assert/strict');
const test = require('node:test');
const { codeVersion, detectWorkspaceVersion } = require('../lib/code-version');

test('workspace code version is stable and content-addressed without explicit release version', () => {
  const previous = process.env.XBOT_CODE_VERSION;
  try {
    delete process.env.XBOT_CODE_VERSION;
    const first = codeVersion();
    assert.equal(first, detectWorkspaceVersion());
    assert.match(first, /^workspace-[a-f0-9]{24}$/);
    assert.notEqual(first, 'local-worktree');
  } finally {
    if (previous === undefined) delete process.env.XBOT_CODE_VERSION;
    else process.env.XBOT_CODE_VERSION = previous;
  }
});

test('explicit release version keeps the workspace content fingerprint', () => {
  const previous = process.env.XBOT_CODE_VERSION;
  try {
    process.env.XBOT_CODE_VERSION = 'release-p14.1';
    assert.equal(codeVersion(), `release-p14.1+${detectWorkspaceVersion()}`);
  } finally {
    if (previous === undefined) delete process.env.XBOT_CODE_VERSION;
    else process.env.XBOT_CODE_VERSION = previous;
  }
});
