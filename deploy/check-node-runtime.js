'use strict';

const expectedNode = { major: 24, minor: 11 };
const expectedNpm = { major: 11, minor: 6 };

function parseVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : null;
}

function matches(version, expected) {
  return Boolean(version)
    && version.major === expected.major
    && version.minor === expected.minor;
}

const nodeVersion = parseVersion(process.version);
const npmVersion = parseVersion(process.env.npm_config_user_agent?.match(/npm\/([^\s]+)/)?.[1]);
const errors = [];

if (!matches(nodeVersion, expectedNode)) {
  errors.push(`Node ${process.version} is unsupported; expected 24.11.x`);
}

if (process.env.npm_lifecycle_event === 'preinstall' && !matches(npmVersion, expectedNpm)) {
  errors.push(`npm ${npmVersion ? `${npmVersion.major}.${npmVersion.minor}.${npmVersion.patch}` : 'unknown'} is unsupported; expected 11.6.x`);
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(`Runtime verified: Node ${process.version}${npmVersion ? `, npm ${npmVersion.major}.${npmVersion.minor}.${npmVersion.patch}` : ''}\n`);
