// D:\AI_Projects\xbot\backend\scripts\test-save-env.js
const http = require('http');
require('dotenv').config();

const port = process.env.BACKEND_PORT || 3011;
const token = process.env.ADMIN_TOKEN || 'xbot_admin_2026';

const payload = {
  BACKEND_PORT: '3011',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'xbot',
  DB_USER: 'pm_user',
  DB_PASSWORD: '********', // should retain the original password!
  GMGN_API_KEY: '',
  GMGN_PRIVATE_KEY: '********', // should retain the original private key!
  X_DATA_PROVIDER: 'mock',
  SOCIALDATA_API_KEY: '',
  WALLET_SOL: 'Sol1111111111111111111111111111111111111111', // new value!
  WALLET_EVM: '',
  ADMIN_TOKEN: '********' // should retain original admin token!
};

const reqData = JSON.stringify(payload);

const options = {
  hostname: 'localhost',
  port: port,
  path: '/api/system/env',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Content-Length': Buffer.byteLength(reqData)
  }
};

console.log('Sending POST /api/system/env request...');
const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log(`Response Status: ${res.statusCode}`);
    console.log(`Response Body: ${body}`);
  });
});

req.on('error', (err) => {
  console.error(`Request failed: ${err.message}`);
});

req.write(reqData);
req.end();
