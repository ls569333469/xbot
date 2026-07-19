// D:\AI_Projects\xbot\backend\lib\x-client.js
const logger = require('./logger');

class MockXClient {
  async getUserTimeline(handle, sinceId) {
    return [
      {
        id: `tweet_${Date.now()}_1`,
        text: `Just found a hidden gem! CA: 0x1234567890123456789012345678901234567890 #LFG`,
        created_at: new Date().toISOString()
      },
      {
        id: `tweet_${Date.now()}_2`,
        text: `Bullish on $DOGE today! Watch out for @ElonMusk updates.`,
        created_at: new Date().toISOString()
      },
      {
        id: `tweet_${Date.now()}_3`,
        text: `Solana season is here! Check this out: So11111111111111111111111111111111111111112`,
        created_at: new Date().toISOString()
      }
    ];
  }
  
  async getUserFollowing(handle) {
    return [
      { id: 'u_1', handle: 'elonmusk' },
      { id: 'u_2', handle: 'cz_binance' },
      { id: 'u_3', handle: 'vitalikbuterin' }
    ];
  }
  
  async getUserProfile(handle) {
    return {
      id: `u_${handle}`,
      handle: handle,
      name: `${handle} Display Name`,
      followers_count: 10000,
      following_count: 500
    };
  }
}

class SocialDataXClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.socialdata.tools/twitter';
  }

  async request(endpoint, params = {}) {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        url.searchParams.append(k, String(v));
      }
    });

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`SocialData API error (${res.status}): ${errText || res.statusText}`);
    }

    return res.json();
  }

  async getUserTimeline(handle, sinceId) {
    logger.info('x-client', `Fetching timeline for @${handle} via SocialData...`);
    
    // Construct query using standard Twitter search operators.
    // E.g. "from:elonmusk since_id:12345"
    let query = `from:${handle}`;
    if (sinceId) {
      query += ` since_id:${sinceId}`;
    }

    const params = { query, type: 'Latest' };
    const data = await this.request('/search', params);
    
    // SocialData returns { tweets: [...] } or direct array
    const tweets = data.tweets || data || [];
    
    return tweets.map(t => {
      const targetHandles = [];
      if (t.entities && t.entities.user_mentions) {
        t.entities.user_mentions.forEach(m => {
          if (m.screen_name) targetHandles.push(m.screen_name.toLowerCase());
        });
      }
      
      if (t.retweeted_status && t.retweeted_status.user && t.retweeted_status.user.screen_name) {
        targetHandles.push(t.retweeted_status.user.screen_name.toLowerCase());
      }
      
      if (t.quoted_status && t.quoted_status.user && t.quoted_status.user.screen_name) {
        targetHandles.push(t.quoted_status.user.screen_name.toLowerCase());
      }

      if (t.in_reply_to_screen_name) {
        targetHandles.push(t.in_reply_to_screen_name.toLowerCase());
      }

      return {
        id: t.id_str || String(t.id),
        text: t.full_text || t.text || '',
        created_at: t.created_at,
        target_handles: Array.from(new Set(targetHandles)),
        raw_json: t
      };
    });
  }

  async getUserFollowing(handle) {
    logger.info('x-client', `Fetching follows list for @${handle} via SocialData...`);
    const data = await this.request(`/user/${handle}/following`);
    
    const users = data.users || data || [];
    return users.map(u => ({
      id: u.id_str || String(u.id),
      handle: (u.screen_name || u.username || '').toLowerCase(),
      name: u.name || ''
    }));
  }

  async getUserProfile(handle) {
    logger.info('x-client', `Fetching profile info for @${handle} via SocialData...`);
    const u = await this.request(`/user/${handle}`);
    return {
      id: u.id_str || String(u.id),
      handle: (u.screen_name || u.username || '').toLowerCase(),
      name: u.name || '',
      followers_count: u.followers_count || 0,
      following_count: u.friends_count || 0
    };
  }
}

function createXClient() {
  const provider = process.env.X_DATA_PROVIDER || 'mock';
  if (provider === 'mock') {
    return new MockXClient();
  }
  if (provider === 'socialdata') {
    const apiKey = process.env.SOCIALDATA_API_KEY;
    if (!apiKey) {
      logger.warn('x-client', 'X_DATA_PROVIDER is socialdata but SOCIALDATA_API_KEY is not set. Falling back to Mock.');
      return new MockXClient();
    }
    return new SocialDataXClient(apiKey);
  }
  throw new Error(`Unsupported X_DATA_PROVIDER: ${provider}`);
}

module.exports = {
  createXClient
};
