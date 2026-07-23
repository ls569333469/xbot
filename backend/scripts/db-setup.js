// D:\AI_Projects\xbot\backend\scripts\db-setup.js
require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const credentials = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || '',
};

async function setup() {
  console.log('开始连接 Default Postgres 检查并创建数据库 xbot...');
  
  // 1. 连接到 postgres 默认库
  const client = new Client({ ...credentials, database: 'postgres' });
  try {
    await client.connect();
    
    // 检查 xbot 库是否存在
    const res = await client.query("SELECT 1 FROM pg_database WHERE datname = 'xbot'");
    if (res.rows.length === 0) {
      console.log('检测到 xbot 数据库不存在，正在创建...');
      await client.query('CREATE DATABASE xbot');
      console.log('数据库 xbot 创建成功！');
    } else {
      console.log('数据库 xbot 已存在。');
    }
  } catch (err) {
    console.error('连接 postgres 默认库失败:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }

  // 2. 连接到 xbot 库导入表结构和数据
  console.log('连接 xbot 数据库导入表结构...');
  const xbotClient = new Client({ ...credentials, database: 'xbot' });
  try {
    await xbotClient.connect();

    // 读取 init.sql 并执行
    const initSqlPath = path.join(__dirname, '../db/init.sql');
    console.log(`正在读取并导入: ${initSqlPath}`);
    const initSql = fs.readFileSync(initSqlPath, 'utf8');
    await xbotClient.query(initSql);
    console.log('表结构及索引 init.sql 导入成功！');

    // 读取 seed.sql 并执行
    const seedSqlPath = path.join(__dirname, '../db/seed.sql');
    console.log(`正在读取并导入: ${seedSqlPath}`);
    const seedSql = fs.readFileSync(seedSqlPath, 'utf8');
    await xbotClient.query(seedSql);
    console.log('种子配置数据 seed.sql 导入成功！');

    console.log('🎉 数据库初始化全部完成！');
  } catch (err) {
    console.error('初始化 xbot 库数据失败:', err.message);
    process.exit(1);
  } finally {
    await xbotClient.end();
  }

  // Fresh databases and existing databases use the same ordered migration runner.
  const { runMigrations } = require('../lib/migrations');
  const applied = await runMigrations();
  console.log(`数据库迁移完成：${applied.length > 0 ? applied.join(', ') : '无待执行迁移'}`);
  const db = require('../lib/db');
  await db.pool.end();
}

setup();
