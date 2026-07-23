const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

async function restartAll(reason) {
  if (stopping || restarting) return;
  restarting = true;
  log(`Restarting all roles (${reason})`);
  const current = [...children.values()];
  await Promise.all(current.map(stopChild));
  children.clear();
  if (!stopping) ROLES.forEach(spawnRole);
  restarting = false;
}

function scheduleAllRestart(reason) {
  if (stopping) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartAll(reason);
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
  if (current.mtimeMs !== previous.mtimeMs) scheduleAllRestart('.env changed');
});
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

