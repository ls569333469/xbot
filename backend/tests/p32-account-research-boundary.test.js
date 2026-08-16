const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const backendRoot = path.resolve(__dirname, '..');
const frontendRoot = path.resolve(__dirname, '../../frontend');

function source(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
}

test('P32 account research remains a historical read-only REST and domain path', () => {
  const server = source('server.js');
  const api = fs.readFileSync(path.join(frontendRoot, 'src/lib/api.ts'), 'utf8');
  assert.match(server, /app\.use\('\/api\/account-research'/);
  assert.doesNotMatch(server, /domains\/actor-screening|\/api\/actor-screening/);
  assert.match(api, /accountResearch:/);
  assert.doesNotMatch(api, /accountResearch:\s*\{[\s\S]*?\b(?:create|retry):/);
  assert.doesNotMatch(api, /actorScreening|\/api\/actor-screening/);
});

test('P32 account research is read-only and cannot reach execution providers or Engine state', () => {
  const files = [
    'domains/account-research/grok-research.js',
    'domains/account-research/repository.js',
    'domains/account-research/routes.js',
    'domains/account-research/service.js'
  ];
  const combined = files.map(source).join('\n');
  assert.doesNotMatch(combined, /engine-state|liveExecution|tradeIntent|createSignal/i);
  assert.doesNotMatch(combined, /getQuote|swap|submitOrder|queryOrder|getTokenInfo|getTokenSecurity|getTokenPoolInfo/);
  assert.doesNotMatch(source('domains/account-research/repository.js'), /\b(?:INSERT|UPDATE|DELETE)\b/i);
  for (const removed of [
    'follow-performance-research.js', 'performance-research.js', 'return-metrics.js', 'worker.js'
  ]) {
    assert.equal(fs.existsSync(path.join(backendRoot, 'domains/account-research', removed)), false);
  }
});

test('P33 page uses its own local REST APIs and never calls external providers directly', () => {
  const panel = fs.readFileSync(
    path.join(frontendRoot, 'src/pages/kol/AccountResearchPanel.tsx'),
    'utf8'
  );
  assert.doesNotMatch(panel, /api\.accountResearch\./);
  assert.match(panel, /api\.kolPerformance\.get/);
  assert.match(panel, /api\.kolPerformance\.list/);
  assert.match(panel, /api\.kolResearch\.listProfileRuns/);
  assert.match(panel, /api\.kolResearch\.getProfileRun/);
  assert.doesNotMatch(panel, /fetch\(|x_search|web_search|gmgn-http|x-client-6551/);
});

test('P32 legacy table names are isolated to repository and historical schema assets', () => {
  const runtimeFiles = [
    'domains/account-research/grok-research.js',
    'domains/account-research/routes.js',
    'domains/account-research/service.js'
  ];
  for (const file of runtimeFiles) {
    assert.doesNotMatch(source(file), /x_actor_screening_/);
  }
  assert.match(source('domains/account-research/repository.js'), /x_actor_screening_runs/);
});
