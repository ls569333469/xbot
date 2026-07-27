const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const envSettings = require('../domains/system/env-settings');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const ENV_PATH = path.join(ROOT, '.env');
const ROLES = ['ingestion', 'execution'];
const RESTART_DELAY_MS = 1_000;
const children = new Map();
const expectedStops = new Set();
let stopping = false;
let restarting = false;
let restartTimer = null;
let pendingRestartRoles = new Set();
let lastEnvValues = envSettings.readEnv();

function log(message) {
  process.stdout.write(`[supervisor] ${message}\n`);
}

function spawnRole(role) {
  if (stopping) return null;
  const child = spawn(process.execPath, [SERVER, `--role=${role}`], {
    cwd: ROOT,
    env: { ...process.env, XBOT_PROCESS_ROLE: role },
    stdio: 'inherit',
    windowsHide: true
  });
  children.set(role, child);
  log(`Started ${role} process (pid=${child.pid})`);
  child.on('exit', (code, signal) => {
    if (children.get(role) === child) children.delete(role);
    const expected = expectedStops.delete(child.pid);
    log(`${role} process exited (code=${code ?? '-'}, signal=${signal || '-'})`);
    if (!stopping && !restarting && !expected) scheduleRoleRestart(role);
  });
  child.on('error', (error) => log(`${role} process error: ${error.message}`));
  return child;
}

function scheduleRoleRestart(role) {
  setTimeout(() => {
    if (!stopping && !restarting && !children.has(role)) spawnRole(role);
  }, RESTART_DELAY_MS).unref?.();
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  expectedStops.add(child.pid);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 8_000);
    timeout.unref?.();
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function restartRoles(roles, reason) {
  if (stopping || restarting) return;
  restarting = true;
  const targets = [...new Set(roles)].filter((role) => ROLES.includes(role));
  log(`Restarting roles ${targets.join(', ')} (${reason})`);
  const current = targets.map((role) => children.get(role)).filter(Boolean);
  await Promise.all(current.map(stopChild));
  targets.forEach((role) => children.delete(role));
  if (!stopping) targets.forEach(spawnRole);
  restarting = false;
}

function scheduleRestart(roles, reason) {
  if (stopping) return;
  roles.forEach((role) => pendingRestartRoles.add(role));
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    const targets = [...pendingRestartRoles];
    pendingRestartRoles = new Set();
    if (targets.length > 0) void restartRoles(targets, reason);
  }, 500);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  fs.unwatchFile(ENV_PATH);
  if (restartTimer) clearTimeout(restartTimer);
  log(`Received ${signal}; stopping child processes`);
  await Promise.all([...children.values()].map(stopChild));
  process.exit(0);
}

ROLES.forEach(spawnRole);
fs.watchFile(ENV_PATH, { interval: 500 }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs) return;
  const nextValues = envSettings.readEnv();
  const changedKeys = [...new Set([...Object.keys(lastEnvValues), ...Object.keys(nextValues)])]
    .filter((key) => (lastEnvValues[key] || '') !== (nextValues[key] || ''));
  lastEnvValues = nextValues;
  changedKeys.forEach((key) => {
    if (nextValues[key] === undefined) delete process.env[key];
    else process.env[key] = nextValues[key];
  });
  const impact = envSettings.impactForKeys(changedKeys);
  if (impact.restart_required) scheduleRestart(impact.restart_roles, `.env changed: ${impact.impact_scope}`);
  else log(`Applied hot configuration (${impact.impact_scope})`);
});
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
