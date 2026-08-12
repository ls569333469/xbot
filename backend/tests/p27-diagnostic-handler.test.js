const assert = require('node:assert/strict');
const test = require('node:test');
const { createDiagnosticHandler } = require('../domains/trade/diagnostic-handler');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function service(overrides = {}) {
  const calls = { diagnostic: 0 };
  return {
    calls,
    persistedEngineDesiredRunning: async () => false,
    diagnosticPreview: ({ chain, whitelistIds }) => ({
      chain, whitelist_ids: whitelistIds, preview_hash: 'preview-hash'
    }),
    runDiagnostic: async () => {
      calls.diagnostic += 1;
      return { ready: true };
    },
    ...overrides
  };
}

function handler(readinessService) {
  return createDiagnosticHandler({
    readinessService,
    sendError: (res, error) => res.status(409).json({ ok: false, code: error.code })
  });
}

test('diagnostic preview does not call GMGN diagnostic work', async () => {
  const readinessService = service();
  const res = response();
  await handler(readinessService)(
    { params: { chain: 'robinhood' }, body: { whitelist_ids: [21] } },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.requires_confirmation, true);
  assert.equal(readinessService.calls.diagnostic, 0);
});

test('diagnostic confirmation rejects a changed preview without provider calls', async () => {
  const readinessService = service();
  const res = response();
  await handler(readinessService)(
    { params: { chain: 'robinhood' }, body: {
      whitelist_ids: [21], confirmation: 'RUN READ ONLY DIAGNOSTIC', preview_hash: 'stale'
    } },
    res
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'DIAGNOSTIC_PREVIEW_CHANGED');
  assert.equal(readinessService.calls.diagnostic, 0);
});

test('diagnostic confirmation executes one explicitly scoped chain', async () => {
  const readinessService = service();
  const res = response();
  await handler(readinessService)(
    { params: { chain: 'robinhood' }, body: {
      whitelist_ids: [21], confirmation: 'RUN READ ONLY DIAGNOSTIC', preview_hash: 'preview-hash'
    } },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(readinessService.calls.diagnostic, 1);
  assert.equal(res.body.data.preview.chain, 'robinhood');
});

test('persisted live intent blocks diagnostics before preview and provider work', async () => {
  let previewCalls = 0;
  const readinessService = service({
    persistedEngineDesiredRunning: async () => true,
    diagnosticPreview: () => { previewCalls += 1; return {}; }
  });
  const res = response();
  await handler(readinessService)(
    { params: { chain: 'robinhood' }, body: { whitelist_ids: [21] } },
    res
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'GMGN_DIAGNOSTIC_BLOCKED_WHILE_LIVE');
  assert.equal(previewCalls, 0);
  assert.equal(readinessService.calls.diagnostic, 0);
});
