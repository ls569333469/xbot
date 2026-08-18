const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_LABELS_PER_KOL,
  normalizeLabelIds,
  normalizeLabelName
} = require('../domains/kol/label-service');
const { normalizeKolFields, updateKol } = require('../domains/kol/service');

test('P36 label normalization converges unicode, whitespace and case keys', () => {
  assert.deepEqual(normalizeLabelName('  ＡＩ   项目方  '), {
    name: 'AI 项目方',
    normalizedName: 'ai 项目方'
  });
  assert.throws(() => normalizeLabelName(''), { code: 'KOL_LABEL_INVALID' });
  assert.throws(() => normalizeLabelName('bad\u0000label'), { code: 'KOL_LABEL_INVALID' });
  assert.throws(() => normalizeLabelName('一'.repeat(25)), { code: 'KOL_LABEL_INVALID' });
});

test('P36 label IDs deduplicate and enforce the per-account limit', () => {
  assert.deepEqual(normalizeLabelIds(['7', 7, '9']), ['7', '9']);
  assert.throws(() => normalizeLabelIds(['0']), { code: 'KOL_LABEL_INVALID' });
  assert.throws(
    () => normalizeLabelIds(Array.from({ length: MAX_LABELS_PER_KOL + 1 }, (_, index) => String(index + 1))),
    { code: 'KOL_LABEL_LIMIT_EXCEEDED' }
  );
});

test('P36 keeps chain IDs as the strict ecosystem enum', () => {
  assert.throws(() => normalizeKolFields({ chain_ids: ['项目方'] }), /Unsupported ecosystem tag/);
  assert.deepEqual(normalizeKolFields({ chain_ids: ['BSC', 'bsc'] }).chain_ids, ['bsc']);
});

test('pure custom-label updates preserve verified identity in the service contract', async () => {
  let updated;
  let labels;
  const result = await updateKol('36', { custom_label_ids: ['8', '9'] }, {
    queries: {
      getById: async () => ({
        id: '36', x_handle: 'p36verified', x_user_id: '6551-user-36', profile_status: 'verified'
      }),
      update: async (id, data) => {
        updated = data;
        return { id, x_handle: 'p36verified', x_user_id: '6551-user-36', profile_status: 'verified' };
      }
    },
    labelService: {
      replaceAccountLabels: async (id, values) => { labels = { id, values }; }
    }
  });

  assert.equal(updated.identity_reset, false);
  assert.deepEqual(labels, { id: '36', values: ['8', '9'] });
  assert.equal(result.profile_status, 'verified');
  assert.equal(result.x_user_id, '6551-user-36');
});

test('fixed strategy selection deep-links to the existing workspace without trade imports', () => {
  const root = path.resolve(__dirname, '../..');
  const center = fs.readFileSync(path.join(root, 'frontend/src/pages/StrategyCenterPage.tsx'), 'utf8');
  const fixed = fs.readFileSync(path.join(root, 'frontend/src/pages/strategy/FixedStrategyWorkspacePage.tsx'), 'utf8');
  const whitelist = fs.readFileSync(path.join(root, 'frontend/src/pages/WhitelistPage.tsx'), 'utf8');

  assert.match(center, /strategies\/fixed\?whitelistId=\$\{encodeURIComponent\(selectedFixed\.id\)\}/);
  assert.match(fixed, /initialWhitelistId=\{searchParams\.get\('whitelistId'\)\}/);
  assert.match(whitelist, /api\.whitelist\.get\(id\)/);
  assert.match(whitelist, /handledInitialId/);
  assert.doesNotMatch(fixed, /domains\/trade|gmgn|execute/i);
});

test('P36 migration is additive and leaves trade tables untouched', () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, '../db/migrations/053_p36_kol_custom_labels.sql'),
    'utf8'
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS x_kol_labels/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS x_kol_account_labels/i);
  assert.match(migration, /REFERENCES x_kol_accounts\(id\) ON DELETE CASCADE/i);
  assert.doesNotMatch(migration, /ALTER TABLE (trade_signals|positions|trade_orders)/i);
});
