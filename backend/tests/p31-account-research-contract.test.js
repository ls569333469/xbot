const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendRoot = path.resolve(__dirname, '../../frontend');
const panelPath = path.join(frontendRoot, 'src/pages/kol/AccountResearchPanel.tsx');
const typesPath = path.join(frontendRoot, 'src/lib/types.ts');

test('P31 loads details for every selected screening run and retains terminal results', () => {
  const source = fs.readFileSync(panelPath, 'utf8');
  assert.match(source, /api\.actorScreening\.get\(selectedRunId\)/);
  assert.match(source, /if \(\['pending', 'running'\]\.includes\(response\.data\.status\)\) \{[\s\S]*?setTimeout/);
  assert.doesNotMatch(source, /setSelectedRunDetail\(null\)[\s\S]{0,200}void refresh\(\)/);
  assert.match(source, /selectedRunSummary\?\.completed_count/);
  assert.match(source, /selectedRunSummary\?\.recommended_count/);
});

test('P31 exposes account-level screening failures instead of rendering an empty result', () => {
  const panel = fs.readFileSync(panelPath, 'utf8');
  const types = fs.readFileSync(typesPath, 'utf8');
  assert.match(panel, /result\.status === 'failed'/);
  assert.match(panel, /result\.error_code/);
  assert.match(panel, /result\.last_error/);
  assert.match(panel, /研究批次详情加载失败/);
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
  assert.match(workspace, /投研会在本次交易请求完成后自动继续/);
});
