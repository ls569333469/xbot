const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(BACKEND_ROOT, '..');
const HASH_TARGETS = [
  path.join('backend', 'server.js'),
  path.join('backend', 'package.json'),
  path.join('backend', 'package-lock.json'),
  path.join('backend', 'domains'),
  path.join('backend', 'jobs'),
  path.join('backend', 'lib'),
  path.join('backend', 'db', 'migrations'),
  path.join('frontend', 'package.json'),
  path.join('frontend', 'package-lock.json'),
  path.join('frontend', 'src')
];
const HASHED_EXTENSIONS = new Set(['.js', '.json', '.sql', '.ts', '.tsx', '.css', '.html']);

let detectedVersion = null;

function collectFiles(target, files) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (HASHED_EXTENSIONS.has(path.extname(target).toLowerCase())) files.push(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) collectFiles(child, files);
    else if (entry.isFile() && HASHED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(child);
    }
  }
}

function detectWorkspaceVersion() {
  if (detectedVersion) return detectedVersion;
  const files = [];
  for (const target of HASH_TARGETS) collectFiles(path.join(WORKSPACE_ROOT, target), files);
  files.sort((left, right) => left.localeCompare(right));
  const digest = crypto.createHash('sha256');
  for (const file of files) {
    const relative = path.relative(WORKSPACE_ROOT, file).replaceAll('\\', '/');
    digest.update(relative);
    digest.update('\0');
    digest.update(fs.readFileSync(file));
    digest.update('\0');
  }
  detectedVersion = `workspace-${digest.digest('hex').slice(0, 24)}`;
  return detectedVersion;
}

function codeVersion() {
  const workspaceVersion = detectWorkspaceVersion();
  const releaseVersion = String(process.env.XBOT_CODE_VERSION || '').trim();
  return releaseVersion ? `${releaseVersion}+${workspaceVersion}` : workspaceVersion;
}

module.exports = { codeVersion, detectWorkspaceVersion };
