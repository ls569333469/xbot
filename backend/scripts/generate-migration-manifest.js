const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { MANIFEST_VERSION, manifestDigest } = require('../lib/migration-manifest');

const workspaceRoot = path.resolve(__dirname, '../..');
const releaseSha = String(process.argv[2] || '').trim();
const lastMigration = String(process.argv[3] || '043_p26_local_rpc_provider_status.sql').trim();

if (!/^[0-9a-f]{7,64}$/i.test(releaseSha)) {
  throw new Error('Usage: node scripts/generate-migration-manifest.js <release-sha> [last-migration]');
}

function git(...args) {
  return execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8' }).trim();
}

const fullSha = git('rev-parse', `${releaseSha}^{commit}`).toLowerCase();
const names = git('ls-tree', '-r', '--name-only', fullSha, 'backend/db/migrations')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((name) => name.replace('backend/db/migrations/', ''))
  .filter((name) => name.endsWith('.sql') && name <= lastMigration)
  .sort();

const migrations = names.map((name) => {
  const content = execFileSync('git', ['show', `${fullSha}:backend/db/migrations/${name}`], {
    cwd: workspaceRoot
  });
  return {
    name,
    checksum_sha256: crypto.createHash('sha256').update(content).digest('hex')
  };
});

const manifest = {
  manifest_version: MANIFEST_VERSION,
  release_sha: fullSha,
  migration_count: migrations.length,
  first_migration: migrations[0]?.name || null,
  last_migration: migrations.at(-1)?.name || null,
  signed_by: 'xbot-release-baseline',
  migrations
};
manifest.manifest_digest = manifestDigest(manifest);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
