// D:\AI_Projects\xbot\backend\scripts\audit-db-schema.js
const { Client } = require('pg');
require('dotenv').config();

const credentials = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || 'pm123456',
  database: 'xbot'
};

async function audit() {
  console.log('=== Database Schema Audit Starting ===');
  const client = new Client(credentials);
  try {
    await client.connect();
    
    // 1. Audit positions table
    console.log('\n[1] Auditing "positions" table columns:');
    const posRes = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'positions'
      ORDER BY ordinal_position
    `);
    const posCols = posRes.rows.map(r => r.column_name);
    console.log('Found columns:', posCols.join(', '));
    
    const requiredPosCols = ['id', 'sim_peaks', 'sell_tx_hash', 'buy_tx_hash', 'status', 'pnl', 'pnl_pct'];
    const missingPos = requiredPosCols.filter(c => !posCols.includes(c));
    if (missingPos.length === 0) {
      console.log('✓ All critical columns present in "positions" table!');
    } else {
      console.error('✗ Missing critical columns in "positions":', missingPos);
    }
    
    // Check type of sim_peaks
    const simPeaksCol = posRes.rows.find(r => r.column_name === 'sim_peaks');
    if (simPeaksCol) {
      console.log(`- Column "sim_peaks" data type: ${simPeaksCol.data_type} (Expected: jsonb)`);
    }

    // 2. Audit budget_tracking table
    console.log('\n[2] Auditing "budget_tracking" table columns and unique indexes:');
    const budgetRes = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'budget_tracking'
    `);
    const budgetCols = budgetRes.rows.map(r => r.column_name);
    console.log('Found columns:', budgetCols.join(', '));
    if (budgetCols.includes('period_key')) {
      console.log('✓ Column "period_key" is present!');
    } else {
      console.error('✗ Column "period_key" is missing from "budget_tracking"!');
    }

    // Check unique constraints on budget_tracking
    const indexRes = await client.query(`
      SELECT
        t.relname as table_name,
        i.relname as index_name,
        a.attname as column_name
      FROM
        pg_class t,
        pg_class i,
        pg_index ix,
        pg_attribute a
      WHERE
        t.oid = ix.indrelid
        AND i.oid = ix.indexrelid
        AND a.attrelid = t.oid
        AND a.attnum = ANY(ix.indkey)
        AND t.relname = 'budget_tracking'
        AND ix.indisunique = true
    `);
    console.log('Unique indexes found on "budget_tracking":');
    const indexMap = {};
    indexRes.rows.forEach(r => {
      if (!indexMap[r.index_name]) indexMap[r.index_name] = [];
      indexMap[r.index_name].push(r.column_name);
    });
    console.log(JSON.stringify(indexMap, null, 2));
    
    let hasProperUnique = false;
    Object.values(indexMap).forEach((cols) => {
      if (cols.includes('chain_id') && cols.includes('period_type') && cols.includes('period_key')) {
        hasProperUnique = true;
      }
    });
    if (hasProperUnique) {
      console.log('✓ Found matching UNIQUE constraint (chain_id, period_type, period_key) for dynamic upserts!');
    } else {
      console.error('✗ NO matching UNIQUE constraint found on (chain_id, period_type, period_key)!');
    }

  } catch (err) {
    console.error('Audit script failed:', err.message);
  } finally {
    await client.end();
    console.log('\n=== Database Schema Audit Finished ===');
  }
}
audit();
