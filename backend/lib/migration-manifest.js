const crypto = require('crypto');

const MANIFEST_VERSION = 'p27.migrations.v1';
const IMPORT_CONFIRMATION = 'IMPORT SIGNED MIGRATION BASELINE';

function normalizeEntry(entry) {
  const name = String(entry?.name || '').trim();
  const checksum = String(entry?.checksum_sha256 || '').trim().toLowerCase();
  if (!/^\d{3}_[A-Za-z0-9_]+\.sql$/.test(name)) {
    throw new Error(`Invalid migration manifest name: ${name || '<empty>'}`);
  }
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    throw new Error(`Invalid migration checksum: ${name}`);
  }
  return { name, checksum_sha256: checksum };
}

function canonicalPayload(manifest) {
  const migrations = (manifest?.migrations || []).map(normalizeEntry);
  const names = migrations.map((entry) => entry.name);
  if (migrations.length === 0 || new Set(names).size !== names.length) {
    throw new Error('Migration manifest must contain unique migration entries');
  }
  const sorted = [...migrations].sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(sorted) !== JSON.stringify(migrations)) {
    throw new Error('Migration manifest entries must be sorted by name');
  }
  const releaseSha = String(manifest?.release_sha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(releaseSha)) throw new Error('Invalid manifest release SHA');
  return {
    manifest_version: MANIFEST_VERSION,
    release_sha: releaseSha,
    migrations
  };
}

function manifestDigest(manifest) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalPayload(manifest)))
    .digest('hex');
}

function validateManifest(manifest, options = {}) {
  const payload = canonicalPayload(manifest);
  if (manifest.manifest_version !== MANIFEST_VERSION) {
    throw new Error(`Unsupported manifest version: ${manifest.manifest_version}`);
  }
  if (manifest.first_migration !== payload.migrations[0].name
      || manifest.last_migration !== payload.migrations.at(-1).name) {
    throw new Error('Migration manifest boundaries do not match its entries');
  }
  if (Number(manifest.migration_count) !== payload.migrations.length) {
    throw new Error('Migration manifest count does not match its entries');
  }
  const digest = manifestDigest(manifest);
  if (String(manifest.manifest_digest || '').toLowerCase() !== digest) {
    throw new Error('Migration manifest digest mismatch');
  }
  if (options.expectedReleaseSha && payload.release_sha !== options.expectedReleaseSha.toLowerCase()) {
    throw new Error('Migration manifest release SHA does not match the expected baseline');
  }
  return { ...payload, manifest_digest: digest };
}

module.exports = {
  IMPORT_CONFIRMATION,
  MANIFEST_VERSION,
  canonicalPayload,
  manifestDigest,
  validateManifest
};
