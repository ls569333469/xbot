// D:\AI_Projects\xbot\backend\scripts\test-socialdata.js
require('dotenv').config();
const { createXClient } = require('../lib/x-client');

async function test() {
  console.log('=== SocialData API Integration Test Starting ===');
  
  // Set provider to socialdata to force testing the real client!
  process.env.X_DATA_PROVIDER = 'socialdata';
  
  const apiKey = process.env.SOCIALDATA_API_KEY;
  if (!apiKey) {
    console.error('✗ Test failed: SOCIALDATA_API_KEY is not configured in backend/.env!');
    process.exit(1);
  }

  console.log(`Using SOCIALDATA_API_KEY: ${apiKey.slice(0, 8)}...`);

  const xClient = createXClient();

  try {
    // 1. Fetch user profile for elonmusk
    console.log('\n[1] Fetching user profile for "elonmusk"...');
    const profile = await xClient.getUserProfile('elonmusk');
    console.log('Profile successfully retrieved:', JSON.stringify(profile, null, 2));

    // 2. Fetch timeline tweets
    console.log('\n[2] Fetching timeline tweets for "elonmusk" (limit 2)...');
    const tweets = await xClient.getUserTimeline('elonmusk');
    console.log(`Successfully retrieved ${tweets.length} tweets.`);
    
    // Log the first tweet normalized output
    if (tweets.length > 0) {
      console.log('First normalized tweet sample:', JSON.stringify({
        id: tweets[0].id,
        text: tweets[0].text,
        created_at: tweets[0].created_at,
        target_handles: tweets[0].target_handles
      }, null, 2));
    }

  } catch (err) {
    console.error('✗ SocialData API test failed:', err.message);
  }

  console.log('\n=== SocialData API Integration Test Finished ===');
}

test().catch(err => console.error(err));
