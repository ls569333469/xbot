const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('P36.1 category model keeps ecosystem and custom-label queries mutually exclusive', () => {
  const model = read('frontend/src/pages/kol/kol-category.ts');

  assert.match(model, /'sol'[\s\S]*'bsc'[\s\S]*'base'[\s\S]*'eth'[\s\S]*'robinhood'[\s\S]*'cross_chain'[\s\S]*'unclassified'/);
  assert.match(model, /value\.startsWith\('ecosystem:'\)\) return \{ tag:/);
  assert.match(model, /value\.startsWith\('custom:'\)\) return \{ label_id:/);
  assert.doesNotMatch(model, /return \{[^}]*tag:[^}]*label_id:/);
});

test('P36.1 KOL page uses one category state and ignores stale list responses', () => {
  const page = read('frontend/src/pages/KolPage.tsx');

  assert.match(page, /useState<KolCategoryKey>\('all'\)/);
  assert.match(page, /const requestId = \+\+listRequestSequence\.current/);
  assert.match(page, /if \(requestId !== listRequestSequence\.current\) return/);
  assert.match(page, /const params = categoryQuery\(activeCategoryKey\)/);
  assert.doesNotMatch(page, /useState<[^>]*>\('all'\);\s*const \[labelId/);
  assert.doesNotMatch(page, /params\.tag[\s\S]{0,160}params\.label_id/);
});

test('P36.1 fixed strategy filters enabled candidates without changing selection callbacks', () => {
  const rules = read('frontend/src/pages/whitelist/AccountRulesStep.tsx');
  const workspace = read('frontend/src/pages/whitelist/WhitelistWorkspace.tsx');

  assert.match(rules, /sortAccounts\(accounts\.filter\(\(item\) => item\.enabled !== false\), chainId\)/);
  assert.match(rules, /<KolCategoryBar[^>]*onChange=\{setActiveCategoryKey\}/);
  assert.match(rules, /onSelectedHandlesChange\(\s*selectedSet\.has/);
  assert.match(rules, /onSelectedHandlesChange\(\[\.\.\.new Set\(\[/);
  assert.match(rules, /onSelectedHandlesChange=\{replaceEcosystemSources\}/);
  assert.match(rules, /onSelectedHandlesChange=\{replaceRelationActors\}/);
  assert.match(workspace, /onDirectActorHandlesChange=\{\(direct_source_actor_handles\) => setForm/);
  assert.match(workspace, /onRelationActorHandlesChange=\{\(relation_actor_handles\) => setForm/);
});

test('P36.1 category UI remains a read-only frontend selector boundary', () => {
  const component = read('frontend/src/pages/kol/KolCategoryBar.tsx');
  const model = read('frontend/src/pages/kol/kol-category.ts');
  const css = read('frontend/src/index.css');
  const combined = `${component}\n${model}`;

  assert.match(component, /DIRECT_CUSTOM_LABEL_LIMIT = 8/);
  assert.match(component, /更多/);
  assert.match(css, /\.kol-category-bar/);
  assert.doesNotMatch(combined, /\bapi\.|fetch\(|gmgn|engine|outbox|watch/i);
});
