const db = require('./db');
const { codeVersion } = require('./code-version');

async function releaseInfo(processRole, executor = db) {
  const manifest = await executor.query(
    `SELECT release_sha, manifest_digest, migration_count,
            first_migration, last_migration, created_at
     FROM release_migration_manifests ORDER BY id DESC LIMIT 1`
  ).then((result) => result.rows[0] || null).catch(() => null);
  return {
    code_version: codeVersion(),
    release_sha: String(process.env.XBOT_RELEASE_SHA || '').trim() || null,
    process_role: processRole,
    contract_version: 'p27.v1',
    event_contract_version: 'p27.events.v1',
    migration_manifest: manifest
  };
}

module.exports = { releaseInfo };
