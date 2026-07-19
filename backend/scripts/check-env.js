// D:\AI_Projects\xbot\backend\scripts\check-env.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
require('dotenv').config();

const ROOT_DIR = path.resolve(__dirname, '../..');

async function checkDb() {
  const credentials = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'pm_user',
    password: process.env.DB_PASSWORD || 'pm123456',
    database: process.env.DB_NAME || 'xbot'
  };

  const client = new Client(credentials);
  try {
    await client.connect();
    console.log('[check-env] ✓ Database connection successful.');
  } catch (err) {
    console.error(`[check-env] ✗ Database connection failed: ${err.message}`);
    throw err;
  } finally {
    await client.end();
  }
}

function checkKeys() {
  const privPath = path.join(ROOT_DIR, 'private_key.pem');
  const pubPath = path.join(ROOT_DIR, 'public_key.pem');

  if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
    console.log('[check-env] 🔑 Missing Ed25519 keypair. Generating new keypair...');
    try {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
        publicKeyEncoding: { format: 'pem', type: 'spki' }
      });

      fs.writeFileSync(privPath, privateKey);
      fs.writeFileSync(pubPath, publicKey);
      console.log('[check-env] ✓ Keypair successfully generated and saved.');
    } catch (err) {
      console.error(`[check-env] ✗ Failed to generate keypair: ${err.message}`);
      throw err;
    }
  } else {
    console.log('[check-env] ✓ Ed25519 keypair files exist.');
  }
}

function checkVars() {
  const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  const warnings = ['WALLET_SOL', 'WALLET_EVM', 'ADMIN_TOKEN', 'X_DATA_PROVIDER'];

  const missingReq = required.filter(v => !process.env[v]);
  if (missingReq.length > 0) {
    throw new Error(`Missing required .env variables: ${missingReq.join(', ')}`);
  }

  warnings.forEach(v => {
    if (!process.env[v]) {
      console.warn(`[check-env] [WARN] Environment variable "${v}" is not configured. Some systems might degrade.`);
    }
  });
}

async function run() {
  console.log('=== [check-env] Starting Startup Checks ===');
  try {
    checkVars();
    checkKeys();
    await checkDb();
    console.log('=== [check-env] All Pre-startup Checks Passed ===\n');
  } catch (err) {
    console.error('\n=== [check-env] Pre-startup Checks FAILED! ===');
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = run;
