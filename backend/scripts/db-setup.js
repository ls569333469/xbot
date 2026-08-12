require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const databaseName = process.env.DB_NAME || 'xbot';
const quotedDatabaseName = `"${databaseName.replace(/"/g, '""')}"`;

const credentials = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || '',
};

async function setup() {
  console.log(`开始连接 Default Postgres 检查并创建数据库 ${databaseName}...`);
  
  // 1. 连接到 postgres 默认库
  const client = new Client({ ...credentials, database: 'postgres' });
  try {
    await client.connect();
    
    const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (res.rows.length === 0) {
      console.log(`检测到 ${databaseName} 数据库不存在，正在创建...`);
      await client.query(`CREATE DATABASE ${quotedDatabaseName}`);
      console.log(`数据库 ${databaseName} 创建成功！`);
    } else {
      console.log(`数据库 ${databaseName} 已存在。`);
    }
  } catch (err) {
    console.error('连接 postgres 默认库失败:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }

  const { runMigrations } = require('../lib/migrations');
  let applied;
  try {
    applied = await runMigrations();
  } catch (error) {
    if (error.code === 'MIGRATION_BASELINE_REQUIRED') {
      console.error('P27 迁移基线尚未显式导入，数据库初始化已安全停止。');
    }
    throw error;
  }
  console.log(`数据库迁移完成：${applied.length > 0 ? applied.join(', ') : '无待执行迁移'}`);

  // Seed 只允许写入完全空的配置表，避免覆盖生产设置。
  const xbotClient = new Client({ ...credentials, database: databaseName });
  try {
    await xbotClient.connect();
    const configCount = await xbotClient.query('SELECT COUNT(*)::int AS count FROM config');
    if (Number(configCount.rows[0].count) === 0) {
      const seedSqlPath = path.join(__dirname, '../db/seed.sql');
      await xbotClient.query(fs.readFileSync(seedSqlPath, 'utf8'));
      console.log('空配置库已写入默认运行配置。');
    } else {
      console.log('检测到现有配置，跳过 Seed。');
    }
    console.log('数据库初始化完成。');
  } catch (err) {
    console.error('初始化 xbot 库数据失败:', err.message);
    process.exit(1);
  } finally {
    await xbotClient.end();
  }

  const db = require('../lib/db');
  await db.pool.end();
}

setup();
