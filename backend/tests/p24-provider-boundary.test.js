const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  resolvePaperEntryContext,
  resolvePaperExitPrice
} = require('../domains/trade/paper-engine');
const {
  TRADE_EXECUTION_STAGES,
  auditAllEvents,
  boundedHours,
  boundedLimit,
  classifyProviderEvent,
  getAuditSummary
} = require('../domains/trade/provider-audit-service');

const BACKEND = path.resolve(__dirname, '..');

function javascriptFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  });
}

test('P24 production business modules cannot import the low-level GMGN client', () => {
  const productionFiles = [
    ...javascriptFiles(path.join(BACKEND, 'domains')),
    ...javascriptFiles(path.join(BACKEND, 'jobs')),
    path.join(BACKEND, 'server.js')
  ];
  const violations = productionFiles.filter((file) => (
    fs.readFileSync(file, 'utf8').includes('gmgn-http')
  )).map((file) => path.relative(BACKEND, file));
  assert.deepEqual(violations, []);
});

test('P24 production server does not start warmup or launch-window workers', () => {
  const server = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
  for (const retired of [
    'gmgn-cache-warmup',
    'gmgn-candidate-cache-warmup',
    'dynamic-launch-window'
  ]) {
    assert.equal(server.includes(retired), false, `${retired} must stay outside production startup`);
    assert.equal(fs.existsSync(path.join(BACKEND, 'jobs', `${retired}.js`)), false);
  }
});

test('P24 close preparation does not add a GMGN gas read', () => {
  const closeService = fs.readFileSync(
    path.join(BACKEND, 'domains', 'trade', 'close-service.js'),
    'utf8'
  );
  assert.equal(closeService.includes('gmgnAccess.getGasPrice'), false);
});

test('P24 provider audit is bounded and reports only local request evidence', async () => {
  assert.equal(boundedHours('999'), 168);
  assert.equal(boundedLimit('-1'), 1);
  const queries = [];
  const result = await getAuditSummary({
    hours: 12,
    limit: 20,
    db: {
      async query(sql) {
        queries.push(sql);
        if (sql.includes('GROUP BY COALESCE')) return { rows: [{ stage: 'quote', count: 1, rate_limited: 0 }] };
        return { rows: [] };
      }
    }
  });
  assert.equal(result.window_hours, 12);
  assert.equal(result.trade_request_count, 1);
  assert.equal(result.healthy, true);
  assert.equal(queries.length, 5);
  assert.equal(queries.every((sql) => sql.includes('provider_rate_events')), true);
  assert.deepEqual(TRADE_EXECUTION_STAGES, [
    'security', 'gas', 'quote', 'token_info', 'swap', 'order_query'
  ]);
  assert.equal(queries[1].includes("IN ('security', 'gas', 'quote', 'token_info', 'swap', 'order_query')"), true);
  assert.equal(queries[2].includes("= 'swap'"), true);
  assert.equal(queries[3].includes("NOT IN ('security', 'gas', 'quote', 'token_info', 'swap', 'order_query')"), true);
});

test('P26 global audit separates background work and enforces Attempt-level swap identity', () => {
  const rows = [
    {
      source: 'p20_dynamic_swap', stage: 'swap', signal_id: 81, http_status: 200,
      context_json: { attempt_id: 91, execution_session_id: 'signal:81' }
    },
    {
      source: 'trade_close', stage: 'swap', signal_id: 81, http_status: 200,
      context_json: { attempt_id: 92, execution_session_id: 'attempt:92' }
    },
    {
      source: 'trade_reconciliation', stage: 'strategy_batch_query', http_status: 200,
      context_json: { execution_session_id: 'strategy-batch:abc' }
    },
    {
      source: 'research', stage: 'token_info', http_status: 200, context_json: {}
    }
  ];
  assert.deepEqual(rows.map(classifyProviderEvent), [
    'buy', 'close', 'strategy_sync', 'research'
  ]);
  const audit = auditAllEvents(rows, { allowedSignalIds: [81] });
  assert.equal(audit.audit_truncated, false);
  assert.deepEqual(audit.category_counts, {
    buy: 1, close: 1, strategy_sync: 1, research: 1
  });
  assert.equal(audit.unauthorized_buy_requests.length, 0);
  assert.equal(audit.invalid_swap_sessions.length, 0);

  const duplicate = auditAllEvents([rows[0], rows[0]], { allowedSignalIds: [81] });
  assert.deepEqual(duplicate.duplicate_swap_attempts, [{ key: 'buy:91', count: 2 }]);
  const wrongSession = auditAllEvents([{
    ...rows[1], context_json: { ...rows[1].context_json, execution_session_id: 'signal:81' }
  }], { allowedSignalIds: [81] });
  assert.equal(wrongSession.invalid_swap_sessions.length, 1);
  assert.equal(auditAllEvents([], { allowedSignalIds: [], truncated: true }).audit_truncated, true);
});

test('P24 reconciliation loop does not poll open-position balances or activity', () => {
  const source = fs.readFileSync(
    path.join(BACKEND, 'domains', 'trade', 'reconciliation-service.js'),
    'utf8'
  );
  const runOnceStart = source.indexOf('  async runOnce()');
  const startStart = source.indexOf('  start(options = {})');
  const runOnce = source.slice(runOnceStart, startStart);
  assert.equal(runOnce.includes('listDuePositionBalances'), false);
  assert.equal(runOnce.includes('getWalletActivity'), false);
});

test('P24 Paper pricing uses only a local snapshot or deterministic Paper defaults', () => {
  const context = resolvePaperEntryContext({}, {
    provider_verification_snapshot: {
      info: { price: { price: '0.25' } },
      native_price_usd: '3000'
    }
  });
  assert.deepEqual(context, {
    entryPriceUsd: 0.25,
    nativePriceUsd: 3000,
    source: 'local_snapshot'
  });
  assert.equal(resolvePaperExitPrice({ entry_price: '0.30' }), 0.30);
  assert.equal(resolvePaperExitPrice({ entry_price: '0.30' }, '0.40'), 0.40);
});
