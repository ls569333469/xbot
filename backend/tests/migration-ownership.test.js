const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const backendRoot = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(backendRoot, 'server.js'), 'utf8');
const supervisorSource = fs.readFileSync(path.join(backendRoot, 'scripts', 'supervisor.js'), 'utf8');

test('production supervisor owns the migration phase before business roles', () => {
  assert.match(supervisorSource, /runMigrationsBeforeRoles/);
  assert.match(supervisorSource, /run-migrations\.js/);
  assert.match(supervisorSource, /if \(runMigrationsBeforeRoles\(\)\) \{/);
  assert.match(supervisorSource, /ROLES\.forEach\(spawnRole\)/);
});

test('role-specific server processes skip migration by default', () => {
  assert.match(serverSource, /processRole === 'all'/);
  assert.match(serverSource, /XBOT_RUN_MIGRATIONS/);
  assert.match(serverSource, /Migration phase owned by supervisor/);
});
