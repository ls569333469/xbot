// D:\AI_Projects\xbot\backend\scripts\test-tg-notifier.js
require('dotenv').config();
const notifier = require('../lib/notifier');

async function test() {
  console.log('=== Telegram Notifier Integration Test Starting ===');
  
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  
  if (!token || !chatId) {
    console.error('✗ Test failed: TG_BOT_TOKEN or TG_CHAT_ID is not configured in backend/.env!');
    process.exit(1);
  }

  console.log(`Using TG_BOT_TOKEN: ${token.slice(0, 8)}...`);
  console.log(`Using TG_CHAT_ID: ${chatId}`);

  // Test sending a trade executed card
  const mockPosition = {
    id: 999,
    contract_address: 'FRBe123456789012345678901234567890123456',
    chain_id: 'sol',
    symbol: 'PEPE_MOCK',
    amount_in: '0.50000000',
    entry_price: '0.088292',
    tp_pct: 100,
    sl_pct: 20
  };

  console.log('Sending mock trade execution card to Telegram...');
  await notifier.tradeExecuted(mockPosition);
  console.log('Test message sent request finished.');
  console.log('=== Telegram Notifier Integration Test Finished ===');
}

test().catch(err => console.error(err));
