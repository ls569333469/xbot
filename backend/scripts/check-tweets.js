// D:\AI_Projects\xbot\backend\scripts\check-tweets.js
require('dotenv').config();
const db = require('../lib/db');

async function check() {
  try {
    const res = await db.query('SELECT COUNT(*) FROM x_activities');
    console.log(`Total activities in database: ${res.rows[0].count}`);

    const latest = await db.query('SELECT id, kol_handle, activity_type, tweet_text, created_at FROM x_activities ORDER BY id DESC LIMIT 3');
    console.log('\nLatest 3 activities:');
    latest.rows.forEach(row => {
      console.log(`- [${row.created_at.toLocaleString()}] @${row.kol_handle} (${row.activity_type}): ${(row.tweet_text || '').slice(0, 80)}...`);
    });
  } catch (err) {
    console.error('Database query failed:', err.message);
  } finally {
    // db is pool, we can pool.end()
    await db.end();
  }
}

check();
