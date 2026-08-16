const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendRoot = path.resolve(__dirname, '../../frontend');
const panelPath = path.join(frontendRoot, 'src/pages/kol/AccountResearchPanel.tsx');
const typesPath = path.join(frontendRoot, 'src/lib/types.ts');

test('P33 loads details for every selected performance run and retains terminal results', () => {
  const source = fs.readFileSync(panelPath, 'utf8');
  assert.match(source, /api\.kolPerformance\.get\(selectedRunId\)/);
  assert.match(source, /\['pending', 'extracting', 'pricing'\]\.includes\(response\.data\.status\)[\s\S]*?setTimeout/);
  assert.match(source, /selectedRun\?\.metrics/);
  assert.match(source, /peak_multiple/);
});

test('P33 exposes separate replay and profile failures instead of rendering an empty result', () => {
  const panel = fs.readFileSync(panelPath, 'utf8');
  const types = fs.readFileSync(typesPath, 'utf8');
  assert.match(panel, /selectedRun\.last_error/);
  assert.match(panel, /profileRun\.status === 'failed'/);
  assert.match(panel, /price_retry/);
  assert.match(types, /last_error\?: string \| null/);
});

test('P31 restores fixed-CA research while preserving trade-priority admission', () => {
  const queue = fs.readFileSync(path.resolve(__dirname, '../domains/research/queue.js'), 'utf8');
  const workspace = fs.readFileSync(path.join(frontendRoot, 'src/pages/whitelist/ResearchWorkspace.tsx'), 'utf8');
  assert.doesNotMatch(queue, /if \(!engineAllowsResearch\(this\.engine\)\) return 0/);
  assert.doesNotMatch(queue, /if \(!await persistedEngineAllowsResearch\(\)\) return 0/);
  assert.match(queue, /liveMode \? LIVE_CONCURRENCY : DEFAULT_CONCURRENCY/);
  assert.match(queue, /TRADE_PROVIDER_LEASE_ACTIVE/);
  assert.match(queue, /TRADE_PROVIDER_QUEUE_ACTIVE/);
  assert.match(queue, /TRADE_CAPACITY_RESERVED/);
  assert.match(queue, /GMGN_COOLDOWN/);
  assert.match(workspace, /queueWaitLabel/);
  assert.match(workspace, /\u6295\u7814\u4f1a\u5728\u672c\u6b21\u4ea4\u6613\u8bf7\u6c42\u5b8c\u6210\u540e\u81ea\u52a8\u7ee7\u7eed/);
});
