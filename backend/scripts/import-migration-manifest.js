const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const db = require('../lib/db');
const { migrationFiles, MANIFEST_MIGRATION, MIGRATION_LOCK } = require('../lib/migrations');
const { IMPORT_CONFIRMATION, validateManifest } = require('../lib/migration-manifest');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

const manifestPath = path.resolve(argument('manifest') || path.join(
  __dirname, '../db/manifests/p26_80e9f5a_migrations.json'
));
const confirmedBy = argument('confirmed-by');
const confirmationNote = argument('confirmation-note');
const confirmation = argument('confirmation');

async function main() {
  if (confirmation !== IMPORT_CONFIRMATION) throw new Error('Explicit migration baseline confirmation is required');
  if (!confirmedBy || !confirmationNote) throw new Error('confirmed-by and confirmation-note are required');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const validated = validateManifest(manifest);
  const localFiles = new Map(migrationFiles().map((file) => [file.name, file]));
  for (const entry of validated.migrations) {
    if (localFiles.get(entry.name)?.checksum !== entry.checksum_sha256) {
      throw new Error(`Local migration does not match signed baseline: ${entry.name}`);
    }
  }
  const manifestMigration = localFiles.get(MANIFEST_MIGRATION);
  if (!manifestMigration) throw new Error(`Missing ${MANIFEST_MIGRATION}`);

  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK]);
    await client.query('BEGIN');
    const applied = await client.query(
      `SELECT name FROM schema_migrations
       WHERE name <= $1 ORDER BY name FOR UPDATE`,
      [validated.migrations.at(-1).name]
    );
    const appliedNames = applied.rows.map((row) => row.name);
    const expectedNames = validated.migrations.map((entry) => entry.name);
    if (JSON.stringify(appliedNames) !== JSON.stringify(expectedNames)) {
      throw new Error('Database migration rows do not exactly match the signed baseline');
    }
    const infrastructure = await client.query(
      'SELECT name FROM schema_migrations WHERE name = $1 FOR UPDATE', [MANIFEST_MIGRATION]
    );
    if (infrastructure.rows.length !== 1) throw new Error(`${MANIFEST_MIGRATION} must be applied first`);

    const inserted = await client.query(
      `INSERT INTO release_migration_manifests
        (release_sha, manifest_digest, migration_count, first_migration, last_migration,
         manifest_json, signed_by, confirmed_by, confirmation_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (release_sha) DO UPDATE SET
         manifest_digest = EXCLUDED.manifest_digest,
         migration_count = EXCLUDED.migration_count,
         first_migration = EXCLUDED.first_migration,
         last_migration = EXCLUDED.last_migration,
         manifest_json = EXCLUDED.manifest_json,
         signed_by = EXCLUDED.signed_by,
         confirmed_by = EXCLUDED.confirmed_by,
         confirmation_note = EXCLUDED.confirmation_note
       WHERE release_migration_manifests.manifest_digest = EXCLUDED.manifest_digest
       RETURNING id`,
      [validated.release_sha, validated.manifest_digest, validated.migrations.length,
        validated.migrations[0].name, validated.migrations.at(-1).name,
        JSON.stringify(manifest), String(manifest.signed_by || 'xbot-release-baseline'),
        confirmedBy.slice(0, 128), confirmationNote.slice(0, 500)]
    );
    if (inserted.rows.length !== 1) throw new Error('Conflicting manifest already exists for this release SHA');
    const manifestId = inserted.rows[0].id;
    for (const entry of validated.migrations) {
      await client.query(
        `UPDATE schema_migrations
         SET checksum_sha256 = $2, migration_manifest_id = $3, release_sha = $4
         WHERE name = $1`,
        [entry.name, entry.checksum_sha256, manifestId, validated.release_sha]
      );
    }
    await client.query(
      `UPDATE schema_migrations SET checksum_sha256 = $2, release_sha = $3
       WHERE name = $1`,
      [MANIFEST_MIGRATION, manifestMigration.checksum, validated.release_sha]
    );
    await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify({
      result: 'imported', release_sha: validated.release_sha,
      manifest_digest: validated.manifest_digest, migration_count: validated.migrations.length
    })}\n`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
