// D:\AI_Projects\xbot\backend\scripts\check-positions.js
require('dotenv').config();
const { Client } = require('pg');

const credentials = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || 'pm123456',
  database: 'xbot'
};

async function check() {
  const client = new Client(credentials);
  try {
    await client.connect();
    const res = await client.query('SELECT id, symbol, entry_price, exit_price, pnl, pnl_pct, status, sim_peaks FROM positions');
    console.log('--- Database Positions ---');
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error('Error querying positions:', err.message);
  } finally {
    await client.end();
  }
}

check();
