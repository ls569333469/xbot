// D:\AI_Projects\xbot\backend\lib\x-client.js
const logger = require('./logger');
const { normalizeXHandle, normalizeXHandles } = require('./x-handles');
const providerUsage = require('./provider-usage');
const { X6551Client } = require('./x-client-6551');

class IntervalLimiter {
  constructor(minIntervalMs = 6000, options = {}) {
    this.minIntervalMs = Math.max(0, Number(minIntervalMs || 0));
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nextAt = 0;
    this.queue = Promise.resolve();
  }

  async wait() {
    const turn = this.queue.then(async () => {
      const delay = Math.max(0, this.nextAt - this.now());
      if (delay > 0) await this.sleep(delay);
      this.nextAt = this.now() + this.minIntervalMs;
    });
    this.queue = turn.catch(() => {});
    await turn;
  }
}

let twitterApiLimiter;
let twitterApiLimiterInterval;

function sharedTwitterApiLimiter(minIntervalMs) {
  if (!twitterApiLimiter || twitterApiLimiterInterval !== minIntervalMs) {
    twitterApiLimiter = new IntervalLimiter(minIntervalMs);
    twitterApiLimiterInterval = minIntervalMs;
  }
  return twitterApiLimiter;
}

function calculateFollowingsCredits(returnedCount) {
  const count = Math.max(0, Number(returnedCount || 0));
  if (count >= 200) return count;
  if (count >= 100) return count * 2;
  return Math.max(60, count * 3);
}

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
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`SocialData API error (${res.status}): ${errText || res.statusText}`);
    }

    return res.json();
  }

  async getUserTimeline(handle, sinceId) {
    const normalizedHandle = normalizeXHandle(handle);
    logger.info('x-client', `Fetching timeline for @${normalizedHandle} via SocialData...`);
    
    // Construct query using standard Twitter search operators.
    // E.g. "from:elonmusk since_id:12345"
    let query = `from:${normalizedHandle}`;
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

      let activityType = 'tweet';
      if (t.retweeted_status) activityType = 'retweet';
      else if (t.quoted_status) activityType = 'quote';
      else if (t.in_reply_to_status_id_str || t.in_reply_to_screen_name) activityType = 'reply';

      return {
        id: t.id_str || String(t.id),
        text: t.full_text || t.text || '',
        created_at: t.tweet_created_at || t.created_at,
        activity_type: activityType,
        target_handles: normalizeXHandles(targetHandles),
        raw_json: t
      };
    });
  }

  async getUserFollowing(handleOrUserId) {
    let userId = String(handleOrUserId || '').trim();
    if (!/^\d+$/.test(userId)) {
      const profile = await this.getUserProfile(userId);
      userId = profile.id;
    }

    logger.info('x-client', `Fetching follows list for user ${userId} via SocialData...`);

    const users = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const data = await this.request(`/user/${userId}/following`, cursor ? { cursor } : {});
      const pageUsers = Array.isArray(data) ? data : (data.users || []);
      users.push(...pageUsers);

      const nextCursor = Array.isArray(data) ? null : data.next_cursor;
      if (!nextCursor || nextCursor === cursor || pageUsers.length < 50) break;
      cursor = nextCursor;
    }

    return users.map(u => ({
      id: u.id_str || String(u.id),
      handle: normalizeXHandle(u.screen_name || u.username),
      name: u.name || ''
    }));
  }

  async getUserProfile(handle) {
    const normalizedHandle = normalizeXHandle(handle);
    logger.info('x-client', `Fetching profile info for @${normalizedHandle} via SocialData...`);
    const u = await this.request(`/user/${normalizedHandle}`);
    return {
      id: u.id_str || String(u.id),
      handle: normalizeXHandle(u.screen_name || u.username),
      name: u.name || '',
      followers_count: u.followers_count || 0,
      following_count: u.friends_count || 0
    };
  }
}

class TwitterApiIoXClient {
  constructor(apiKey, options = {}) {
    if (!apiKey) throw new Error('TWITTERAPI_IO_API_KEY is required');
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl || 'https://api.twitterapi.io';
    this.fetchImpl = options.fetchImpl || fetch;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = Number(options.timeoutMs || process.env.TWITTERAPI_IO_TIMEOUT_MS || 15000);
    this.maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
    this.dailyCreditLimit = Number(
      options.dailyCreditLimit || process.env.TWITTERAPI_IO_DAILY_CREDIT_LIMIT || 50000
    );
    const minIntervalMs = Number(
      options.minIntervalMs ?? process.env.TWITTERAPI_IO_MIN_INTERVAL_MS ?? 6000
    );
    this.limiter = options.limiter || sharedTwitterApiLimiter(minIntervalMs);
    this.usage = options.usage || providerUsage;
  }

  async request(method, endpoint, options = {}) {
    const estimatedCredits = Number(options.estimatedCredits || 15);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.limiter.wait();
      const reservation = await this.usage.reserveUsage(
        'twitterapi',
        endpoint,
        estimatedCredits,
        this.dailyCreditLimit
      );
      const startedAt = Date.now();
      let finalized = false;
      try {
        const url = new URL(`${this.baseUrl}${endpoint}`);
        Object.entries(options.params || {}).forEach(([key, value]) => {
          if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        });

        const response = await this.fetchImpl(url, {
          method,
          headers: {
            'X-API-Key': this.apiKey,
            'Accept': 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {})
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        const text = await response.text();
        let data;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          const error = new Error(`TwitterAPI.io returned invalid JSON (${response.status})`);
          error.code = 'TWITTERAPI_INVALID_JSON';
          error.status = response.status;
          error.retryable = response.status >= 500;
          throw error;
        }

        const actualCredits = options.creditCalculator
          ? options.creditCalculator(data)
          : estimatedCredits;
        await this.usage.finalizeUsage(
          reservation,
          actualCredits,
          Date.now() - startedAt,
          !response.ok
        );
        finalized = true;

        if (response.ok && data.status !== 'error') return data;

        const error = new Error(
          `TwitterAPI.io error (${response.status}): ${data.message || data.msg || response.statusText}`
        );
        if (response.status === 401) error.code = 'TWITTERAPI_UNAUTHORIZED';
        else if (response.status === 403) error.code = 'TWITTERAPI_FORBIDDEN';
        else if (response.status === 429) error.code = 'TWITTERAPI_RATE_LIMITED';
        else if (response.status >= 500) error.code = 'TWITTERAPI_UNAVAILABLE';
        else error.code = 'TWITTERAPI_REQUEST_FAILED';
        error.status = response.status;
        error.retryable = response.status === 429 || response.status >= 500;
        const retryAfter = Number(response.headers.get('retry-after') || 0);
        error.retryAfterMs = retryAfter > 0 ? retryAfter * 1000 : null;
        throw error;
      } catch (error) {
        if (!finalized) {
          await this.usage.finalizeUsage(
            reservation,
            estimatedCredits,
            Date.now() - startedAt,
            true
          ).catch((usageError) => {
            logger.error('x-client', `Failed to finalize provider usage: ${usageError.message}`);
          });
        }

        if (!error.code && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          error.code = 'TWITTERAPI_TIMEOUT';
          error.retryable = true;
        } else if (!error.code && error instanceof TypeError) {
          error.code = 'TWITTERAPI_NETWORK_ERROR';
          error.retryable = true;
        }

        if (error.retryable && attempt < this.maxAttempts) {
          const backoffMs = error.retryAfterMs
            || Math.min(10000, 1000 * (2 ** (attempt - 1)));
          await this.sleep(backoffMs);
          continue;
        }
        throw error;
      }
    }
    throw new Error('TwitterAPI.io request exhausted all retry attempts');
  }

  async getUserFollowingPage(handle, options = {}) {
    const userName = normalizeXHandle(handle);
    const pageSize = Math.min(200, Math.max(20, Number(options.pageSize || 20)));
    const data = await this.request('GET', '/twitter/user/followings', {
      params: { userName, cursor: options.cursor || '', pageSize },
      estimatedCredits: pageSize * 3,
      creditCalculator: (payload) => calculateFollowingsCredits((payload.followings || []).length)
    });
    if (!Array.isArray(data.followings)) {
      const error = new Error('TwitterAPI.io followings response is missing followings[]');
      error.code = 'TWITTERAPI_SCHEMA_ERROR';
      throw error;
    }
    return {
      users: data.followings.map((user) => ({
        id: String(user.id || user.userId || user.userName),
        handle: normalizeXHandle(user.userName || user.screen_name || user.username),
        name: user.name || '',
        raw_json: user
      })).filter((user) => user.id && user.handle),
      hasNextPage: data.has_next_page === true,
      nextCursor: data.next_cursor || null
    };
  }

  async getUserFollowing(handle) {
    const users = [];
    let cursor = '';
    const maxPages = Math.max(1, Number(process.env.TWITTERAPI_IO_MAX_PAGES || 100));
    for (let page = 0; page < maxPages; page++) {
      const result = await this.getUserFollowingPage(handle, { cursor, pageSize: 200 });
      users.push(...result.users);
      if (!result.hasNextPage || !result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    return users;
  }

  async checkFollowRelationship(sourceHandle, targetHandle) {
    const data = await this.request('GET', '/twitter/user/check_follow_relationship', {
      params: {
        source_user_name: normalizeXHandle(sourceHandle),
        target_user_name: normalizeXHandle(targetHandle)
      },
      estimatedCredits: 100
    });
    if (typeof data.data?.following !== 'boolean') {
      const error = new Error('TwitterAPI.io follow relationship response is invalid');
      error.code = 'TWITTERAPI_SCHEMA_ERROR';
      throw error;
    }
    return data.data;
  }

  async getUserProfile(handle) {
    const data = await this.request('GET', '/twitter/user/info', {
      params: { userName: normalizeXHandle(handle) },
      estimatedCredits: 18
    });
    const user = data.data;
    if (!user?.id || !user?.userName) {
      const error = new Error('TwitterAPI.io user response is invalid');
      error.code = 'TWITTERAPI_SCHEMA_ERROR';
      throw error;
    }
    return {
      id: String(user.id),
      handle: normalizeXHandle(user.userName),
      name: user.name || '',
      followers_count: Number(user.followers || 0),
      following_count: Number(user.following || 0)
    };
  }

  async addUserToTweetMonitor(handle) {
    return this.request('POST', '/oapi/x_user_stream/add_user_to_monitor_tweet', {
      body: { x_user_name: normalizeXHandle(handle) },
      estimatedCredits: 15
    });
  }

  async getUserTimeline() {
    const error = new Error('Timeline polling is disabled for TwitterAPI.io; use Tweet Stream/Webhook');
    error.code = 'TWITTERAPI_TIMELINE_DISABLED';
    throw error;
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
      throw new Error('SOCIALDATA_API_KEY is required when X_DATA_PROVIDER=socialdata');
    }
    return new SocialDataXClient(apiKey);
  }
  if (provider === 'twitterapi') {
    return new TwitterApiIoXClient(process.env.TWITTERAPI_IO_API_KEY);
  }
  if (provider === '6551') {
    return new X6551Client(process.env.OPENNEWS_TOKEN);
  }
  throw new Error(`Unsupported X_DATA_PROVIDER: ${provider}`);
}

module.exports = {
  IntervalLimiter,
  MockXClient,
  SocialDataXClient,
  TwitterApiIoXClient,
  X6551Client,
  calculateFollowingsCredits,
  createXClient
};
