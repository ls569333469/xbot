const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  contentAuditExcluded,
  forbiddenReleasePath,
  normalizePath,
  parseReleaseAllowlist,
  releaseCandidates,
  secretCodes
} = require('../lib/release-audit');

const repositoryRoot = path.resolve(__dirname, '../..');
const allowlistPath = path.join(repositoryRoot, 'deploy/release-allowlist.txt');

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...options
  }).trim();
}

function workspaceFiles() {
  return git(['ls-files', '--cached', '--others', '--exclude-standard'])
    .split(/\r?\n/).filter(Boolean).map(normalizePath)
    .filter((file) => fs.existsSync(path.join(repositoryRoot, file)));
}

function workspaceSecretFindings(files) {
  return files.flatMap((file) => {
    if (contentAuditExcluded(file)) return [];
    const target = path.join(repositoryRoot, file);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return [];
    const content = fs.readFileSync(target);
    if (content.includes(0)) return [];
    return secretCodes(content.toString('utf8')).map((code) => ({ scope: 'workspace', file, code }));
  });
}

function historicalSecretFindings() {
  const objects = git(['rev-list', '--objects', '--all']).split(/\r?\n/).filter(Boolean);
  const findings = [];
  for (const line of objects) {
    const [objectId, ...pathParts] = line.split(' ');
    const file = normalizePath(pathParts.join(' '));
    if (!file || contentAuditExcluded(file)) continue;
    try {
      const content = execFileSync('git', ['cat-file', '-p', objectId], {
        cwd: repositoryRoot,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true
      });
      if (content.includes(0)) continue;
      for (const code of secretCodes(content.toString('utf8'))) {
        findings.push({ object: objectId.slice(0, 12), file, code });
      }
    } catch (error) {
      if (error.status !== 128) throw error;
    }
  }
  return findings.sort((left, right) => `${left.file}:${left.object}`.localeCompare(`${right.file}:${right.object}`));
}

function main() {
  const files = workspaceFiles();
  let allowlistRules = [];
  const allowlistFailures = [];
  try {
    allowlistRules = parseReleaseAllowlist(fs.readFileSync(allowlistPath, 'utf8'));
  } catch (error) {
    allowlistFailures.push({ code: error.code || 'INVALID_RELEASE_ALLOWLIST', file: 'deploy/release-allowlist.txt' });
  }
  const candidates = allowlistFailures.length === 0 ? releaseCandidates(files, allowlistRules) : [];
  const unmatchedIncludes = allowlistRules
    .filter((rule) => !rule.excluded && !files.some((file) => rule.regex.test(file)))
    .map((rule) => ({ code: 'UNMATCHED_RELEASE_ALLOWLIST_RULE', file: rule.pattern }));
  const forbiddenPaths = files.filter(forbiddenReleasePath);
  const candidateForbiddenPaths = candidates.filter(forbiddenReleasePath);
  const workspaceSecrets = workspaceSecretFindings(files);
  const historicalSecrets = process.argv.includes('--skip-history') ? [] : historicalSecretFindings();
  const removedLiveRunnerPresent = candidates.includes('backend/scripts/run-p25-live-acceptance.js');
  const failures = [
    ...allowlistFailures,
    ...unmatchedIncludes,
    ...forbiddenPaths.map((file) => ({ code: 'FORBIDDEN_WORKSPACE_PATH', file })),
    ...candidateForbiddenPaths.map((file) => ({ code: 'FORBIDDEN_RELEASE_PATH', file })),
    ...workspaceSecrets,
    ...historicalSecrets.map((finding) => ({
      code: `HISTORICAL_${finding.code}`,
      file: finding.file,
      object: finding.object
    })),
    ...(removedLiveRunnerPresent
      ? [{ code: 'LIVE_ACCEPTANCE_RUNNER_IN_RELEASE', file: 'backend/scripts/run-p25-live-acceptance.js' }]
      : [])
  ];
  process.stdout.write(`${JSON.stringify({
    result: failures.length === 0 ? 'passed' : 'failed',
    workspace_files: files.length,
    release_candidate_count: candidates.length,
    release_candidates: candidates,
    history_scanned: !process.argv.includes('--skip-history'),
    failures
  }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { historicalSecretFindings, workspaceFiles, workspaceSecretFindings };
