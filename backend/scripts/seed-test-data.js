// D:\AI_Projects\xbot\backend\scripts\seed-test-data.js
require('dotenv').config();
const { Client } = require('pg');

const credentials = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || 'pm123456',
  database: 'xbot'
};

async function seed() {
  const client = new Client(credentials);
  try {
    await client.connect();
    console.log('连接数据库 xbot 插入测试数据...');

    // 1. 清空旧测试数据以保持干净
    await client.query('DELETE FROM positions');
    await client.query('DELETE FROM trade_signals');
    await client.query('DELETE FROM x_activities');
    await client.query('DELETE FROM ca_whitelist');
    await client.query('DELETE FROM x_kol_accounts');
    
    // 2. 插入测试 KOL 账号
    const kolRes = await client.query(
      `INSERT INTO x_kol_accounts (x_user_id, x_handle, display_name, chain_ids, weight, enabled)
       VALUES ('44196397', 'elonmusk', 'Elon Musk', ARRAY['sol'], 10, true)
       RETURNING id`
    );
    const kolId = kolRes.rows[0].id;
    console.log(`已插入 KOL: @elonmusk (ID: ${kolId})`);

    // 3. 插入测试白名单 CA
    const wlRes = await client.query(
      `INSERT INTO ca_whitelist (
        contract_address, chain_id, symbol, project_name, project_x_handles,
        budget_per_trade, total_budget, auto_tp_pct, auto_sl_pct, status
       ) VALUES (
        'FRBe123456789012345678901234567890123456', 'sol', 'PEPE', 'Pepe Coin', ARRAY['pepecoin'],
        0.5, 5.0, 15.0, 10.0, 'active'
       ) RETURNING id`
    );
    const wlId = wlRes.rows[0].id;
    console.log(`已插入白名单 CA: FRBe...456 ($PEPE) (ID: ${wlId})`);

    // 4. 插入一条未处理的推特活动（马斯克提及 @pepecoin，触发 Handle 匹配）
    await client.query(
      `INSERT INTO x_activities (
        kol_id, kol_handle, activity_type, tweet_id, tweet_text, target_x_handle, processed
       ) VALUES (
        $1, 'elonmusk', 'tweet', '1809000000000000000', 'Excited about the future of @pepecoin!', 'pepecoin', false
       )`,
      [kolId]
    );
    console.log('已插入测试活动：KOL @elonmusk 发推提及 @pepecoin (processed = false)');
    
    console.log('🎉 测试数据植入成功！5秒内 signal-matcher 定时任务将自动匹配该信号并开仓。');
  } catch (err) {
    console.error('测试数据植入失败:', err.message);
  } finally {
    await client.end();
  }
}

seed();
