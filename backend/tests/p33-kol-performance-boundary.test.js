const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const backendRoot = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(backendRoot, file), 'utf8');

test('P33 migration is additive and leaves live transaction tables untouched', () => {
  const migration = source('db/migrations/050_p33_kol_performance_analysis.sql');
  for (const table of ['kol_performance_runs', 'kol_performance_events', 'kol_performance_assets', 'kol_price_replay_cache', 'kol_profile_runs']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  }
  assert.doesNotMatch(migration, /ALTER TABLE\s+(?:trade_signals|trade_intents|trade_attempts|trade_orders|positions)\b/i);
  assert.doesNotMatch(migration, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:trade_signals|trade_intents|trade_attempts|trade_orders|positions)\b/i);
  assert.match(migration, /UNIQUE\s*\(run_id,\s*chain_id,\s*contract_address_key\)/i);
  const repository = source('domains/kol-performance/repository.js');
  assert.match(repository, /SELECT DISTINCT ON \(event\.chain_id, event\.contract_address_key\)/);
  assert.match(repository, /ORDER BY event\.chain_id, event\.contract_address_key, event\.source_occurred_at ASC/);
});

test('P33 runtime is read-only research with K-line access only, never execution calls', () => {
  const files = [
    'domains/kol-performance/kline-utils.js', 'domains/kol-performance/post-ca-research.js',
    'domains/kol-performance/price-replay.js',
    'domains/kol-performance/repository.js', 'domains/kol-performance/routes.js',
    'domains/kol-performance/service.js', 'domains/kol-performance/source-loaders.js',
    'domains/kol-performance/worker.js'
  ];
  const combined = files.map(source).join('\n');
  assert.match(source('domains/kol-performance/price-replay.js'), /fetchKline/);
  assert.match(source('domains/kol-performance/price-replay.js'), /KOL_PERFORMANCE_GMGN_GLOBAL_INTERVAL_MS/);
  assert.match(source('domains/kol-performance/price-replay.js'), /KOL_PERFORMANCE_GMGN_CA_INTERVAL_MS/);
  assert.doesNotMatch(combined, /getQuote|quoteOrder|swap\(|submitOrder|queryOrder|getTokenInfo|getTokenSecurity|getTokenPoolInfo/i);
  assert.doesNotMatch(combined, /engine-state|liveExecution|tradeIntent|createSignal/i);
  assert.doesNotMatch(combined, /account-research\/(?:performance-research|follow-performance-research|return-metrics|worker)/);
});

test('P33 routes are mounted separately and P32 writes are retired', () => {
  const server = source('server.js');
  const legacyRoutes = source('domains/account-research/routes.js');
  assert.match(server, /app\.use\('\/api\/kol-performance'/);
  assert.match(server, /app\.use\('\/api\/kol-research'/);
  assert.match(legacyRoutes, /ACCOUNT_RESEARCH_LEGACY_READ_ONLY/);
});
