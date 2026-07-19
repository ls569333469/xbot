// D:\AI_Projects\xbot\backend\scripts\test-close.js
const { Client } = require('pg');

const credentials = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || 'pm123456',
  database: 'xbot'
};

async function test() {
  const client = new Client(credentials);
  try {
    await client.connect();
    const res = await client.query("SELECT id FROM positions WHERE status = 'open' LIMIT 1");
    if (res.rows.length === 0) {
      console.log('No active open positions to close.');
      return;
    }
    const positionId = res.rows[0].id;
    console.log(`Found active position ID: ${positionId}, sending close request...`);

    const closeRes = await fetch(`http://localhost:3011/api/trade/positions/${positionId}/close`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer xbot_admin_2026',
        'Content-Type': 'application/json'
      }
    });
    const data = await closeRes.json();
    console.log('--- Manual Close API Response ---');
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Test failed:', err.message);
  } finally {
    await client.end();
  }
}
test();
