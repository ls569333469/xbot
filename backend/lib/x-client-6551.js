const providerUsage = require('./provider-usage');
const { normalizeXHandle } = require('./x-handles');

const FLAG_KEYS = Object.freeze([
  'newTweetBol',
  'newFlwBol',
  'newUnFlwBol',
  'newTweetReplyBol',
  'newTweetQuoteBol',
  'newRetweetBol',
  'updateNameBol',
  'updateDescBol',
  'updateAvatarBol',
  'updateBannerBol',
  'newCaBol',
  'tweetToppingBol'
]);

function collectObjects(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjects(item, output));
    return output;
  }
  output.push(value);
  Object.values(value).forEach((item) => collectObjects(item, output));
  return output;
}

function largestObjectArray(payload) {
  const arrays = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
        arrays.push(value);
      }
      value.forEach(visit);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(payload);
  return arrays.sort((left, right) => right.length - left.length)[0] || [];
}

function normalizeWatchFlags(value = {}) {
  return Object.fromEntries(FLAG_KEYS.map((key) => [key, value[key] === true]));
}

function preserveWatchUsername(value) {
  return String(value || '').trim().replace(/^@+/, '');
}

function normalizeWatch(value) {
  const providerUsername = preserveWatchUsername(
    value?.username ?? value?.twAccount ?? value?.screenName ?? value?.account
  );
  const username = normalizeXHandle(providerUsername);
  if (!username) return null;
  return { username, providerUsername, flags: normalizeWatchFlags(value), raw: value };
}

function firstObjectWith(payload, keys) {
  return collectObjects(payload).find((item) => keys.some((key) => item[key] !== undefined));
}

function normalizeUserProfile(payload, expectedHandle = '') {
  const user = firstObjectWith(payload, [
    'userId', 'userIdStr', 'twId', 'screenName', 'screen_name', 'rest_id'
  ]);
  if (!user) {
    const error = new Error('6551 user response is missing a profile object');
    error.code = 'X6551_SCHEMA_ERROR';
    throw error;
  }
  const legacy = user.legacy && typeof user.legacy === 'object' ? user.legacy : {};
  const profileUrls = profileWebsiteUrls(user, legacy);
  const providerHandle = normalizeXHandle(
    user.screenName ?? user.screen_name ?? user.twAccount ?? user.username
    ?? legacy.screen_name ?? ''
  );
  const normalizedExpected = normalizeXHandle(expectedHandle);
  if (normalizedExpected && providerHandle && providerHandle !== normalizedExpected) {
    const error = new Error('6551 returned a different X account than requested');
    error.code = 'X6551_PROFILE_MISMATCH';
    throw error;
  }

  // The provider may omit a numeric ID on the handle endpoint. Callers that
  // need identity binding can re-query by the event's stable numeric ID.
  const userId = String(
    user.userId ?? user.userIdStr ?? user.twId ?? user.rest_id ?? user.id ?? providerHandle
  ).trim();
  if (!userId || ['undefined', 'null'].includes(userId.toLowerCase())) {
    const error = new Error('6551 user response is missing a valid user ID');
    error.code = 'X6551_SCHEMA_ERROR';
    throw error;
  }
  return {
    id: userId,
    handle: providerHandle || normalizedExpected,
    name: user.name ?? user.twUserName ?? legacy.name ?? '',
    followers_count: Number(
      user.followersCount ?? user.followerCount ?? legacy.followers_count ?? 0
    ),
    following_count: Number(
      user.friendsCount ?? user.followingCount ?? legacy.friends_count ?? 0
    ),
    description: String(user.description ?? user.bio ?? legacy.description ?? ''),
    created_at: user.createdAt ?? user.created_at ?? legacy.created_at ?? null,
    website_urls: profileUrls,
    pinned_tweet_id: String(
      user.pinnedTweetId ?? user.pinned_tweet_id ?? legacy.pinned_tweet_ids_str?.[0] ?? ''
    ).trim() || null
  };
}

function profileWebsiteUrls(user, legacy = {}) {
  const urlEntities = [
    ...(Array.isArray(user?.entities?.url?.urls) ? user.entities.url.urls : []),
    ...(Array.isArray(user?.entities?.description?.urls) ? user.entities.description.urls : []),
    ...(Array.isArray(legacy?.entities?.url?.urls) ? legacy.entities.url.urls : []),
    ...(Array.isArray(legacy?.entities?.description?.urls) ? legacy.entities.description.urls : [])
  ];
  const values = [
    user?.url,
    user?.website,
    user?.websiteUrl,
    legacy?.url,
    ...urlEntities.flatMap((item) => [item?.expanded_url, item?.expandedUrl, item?.url])
  ];
  return [...new Set(values.filter((value) => {
    try { return new URL(String(value)).protocol === 'https:'; } catch { return false; }
  }).map(String))];
}

function normalizeTweets(payload) {
  const tweets = new Map();
  for (const item of collectObjects(payload)) {
    const id = String(item.twId ?? item.tweetId ?? item.id ?? '').trim();
    const text = String(item.text ?? item.fullText ?? item.content ?? '').trim();
    if (!id || !text) continue;
    tweets.set(id, {
      id,
      text,
      created_at: item.createdAt ?? item.created_at ?? null,
      user_handle: normalizeXHandle(
        item.userScreenName ?? item.screenName ?? item.twAccount ?? item.username ?? ''
      ),
      is_reply: Boolean(item.inReplyToStatusId ?? item.in_reply_to_status_id ?? item.isReply),
      is_retweet: Boolean(item.retweetedStatus ?? item.retweeted_status ?? item.isRetweet)
        || /^RT\s+@/i.test(text),
      is_quote: Boolean(item.quotedStatus ?? item.quoted_status ?? item.isQuote),
      pinned: Boolean(item.isPinned ?? item.pinned)
    });
  }
  return [...tweets.values()];
}

class X6551Client {
  constructor(token, options = {}) {
    if (!token) throw new Error('OPENNEWS_TOKEN is required');
    this.token = token;
    this.baseUrl = options.baseUrl || 'https://ai.6551.io/open';
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = Number(options.timeoutMs || process.env.X_6551_TIMEOUT_MS || 15000);
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.usage = options.usage || providerUsage;
  }

  async request(endpoint, body = {}, options = {}) {
    const maxAttempts = options.mutation ? 1 : Math.max(1, Number(options.maxAttempts || 3));
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const reservation = await this.usage.reserveUsage('6551', endpoint, 0, Number.MAX_SAFE_INTEGER);
      const startedAt = Date.now();
      let finalized = false;
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        const raw = await response.text();
        let payload;
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          const error = new Error(`6551 returned invalid JSON (${response.status})`);
          error.code = 'X6551_INVALID_JSON';
          error.status = response.status;
          error.retryable = response.status >= 500;
          throw error;
        }

        const actualCost = Number(payload.usage?.cost || 0);
        if (!response.ok || payload.success === false) {
          const error = new Error(
            payload.error || payload.message || payload.msg || `6551 request failed (${response.status})`
          );
          error.code = response.status === 401 || response.status === 403
            ? 'X6551_AUTH_ERROR'
            : response.status === 429
              ? 'X6551_RATE_LIMITED'
              : 'X6551_HTTP_ERROR';
          error.status = response.status;
          error.retryable = response.status === 429 || response.status >= 500;
          error.actualCost = actualCost;
          if (response.status === 429) {
            const retryAfter = response.headers?.get?.('retry-after');
            if (retryAfter) {
              const seconds = Number(retryAfter);
              const retryAt = Number.isFinite(seconds)
                ? Date.now() + seconds * 1000
                : new Date(retryAfter).getTime();
              if (Number.isFinite(retryAt)) error.retryAfterMs = Math.max(0, retryAt - Date.now());
            }
          }
          throw error;
        }

        finalized = true;
        await this.usage.finalizeUsage(reservation, actualCost, Date.now() - startedAt, false);
        return payload;
      } catch (error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
          error.code = 'X6551_TIMEOUT';
          error.retryable = true;
        } else if (!error.code && error instanceof TypeError) {
          error.code = 'X6551_NETWORK_ERROR';
          error.retryable = true;
        }

        if (!finalized) {
          await this.usage.finalizeUsage(
            reservation,
            Number(error.actualCost || 0),
            Date.now() - startedAt,
            true
          );
        }
        if (!error.retryable || attempt >= maxAttempts) throw error;
        const retryDelayMs = Number.isFinite(error.retryAfterMs)
          ? Math.min(120_000, Math.max(1_000, error.retryAfterMs))
          : Math.min(10_000, 1_000 * (2 ** (attempt - 1)));
        await this.sleep(retryDelayMs);
      }
    }
    throw new Error('6551 request exhausted all retry attempts');
  }

  async getUserProfile(handle) {
    const username = normalizeXHandle(handle);
    const payload = await this.request('twitter_user_info', { username });
    return normalizeUserProfile(payload, username);
  }

  async getUserProfileById(userId) {
    const value = String(userId || '').trim();
    if (!value) throw new Error('6551 user ID is required');
    return normalizeUserProfile(
      await this.request('twitter_user_by_id', { userId: value })
    );
  }

  async getTweetById(tweetId) {
    return this.request('twitter_tweet_by_id', { twId: String(tweetId) });
  }

  async getUserTweets(handle, options = {}, requestOptions = {}) {
    const payload = await this.request('twitter_user_tweets', {
      username: normalizeXHandle(handle),
      maxResults: Math.min(100, Math.max(1, Number(options.maxResults || 20))),
      product: options.product === 'Top' ? 'Top' : 'Latest',
      includeReplies: options.includeReplies === true,
      includeRetweets: options.includeRetweets === true
    }, requestOptions);
    return normalizeTweets(payload);
  }

  async searchTweets(filters = {}, requestOptions = {}) {
    const body = {
      maxResults: Math.min(100, Math.max(1, Number(filters.maxResults || 20))),
      product: filters.product === 'Latest' ? 'Latest' : 'Top'
    };
    for (const key of ['keywords', 'fromUser', 'toUser', 'mentionUser', 'hashtag']) {
      if (filters[key]) body[key] = key.endsWith('User')
        ? normalizeXHandle(filters[key])
        : String(filters[key]).trim();
    }
    for (const key of ['sinceDate', 'untilDate', 'lang']) {
      if (filters[key]) body[key] = String(filters[key]).trim();
    }
    for (const key of ['excludeReplies', 'excludeRetweets']) {
      if (filters[key] !== undefined) body[key] = filters[key] === true;
    }
    for (const key of ['minLikes', 'minRetweets', 'minReplies']) {
      if (filters[key] === undefined || filters[key] === null || filters[key] === '') continue;
      const value = Number(filters[key]);
      if (Number.isFinite(value) && value >= 0) body[key] = Math.floor(value);
    }
    const payload = await this.request('twitter_search', body, requestOptions);
    return normalizeTweets(payload);
  }

  async listWatches() {
    const payload = await this.request('twitter_watch', {});
    return largestObjectArray(payload).map(normalizeWatch).filter(Boolean);
  }

  async addWatch(username, flags) {
    return this.request('twitter_watch_add', {
      username: normalizeXHandle(username),
      ...normalizeWatchFlags(flags)
    }, { mutation: true });
  }

  async deleteWatch(username) {
    return this.request('twitter_watch_delete', {
      // The 6551 delete endpoint is case-sensitive even though Watch matching is not.
      username: preserveWatchUsername(username)
    }, { mutation: true });
  }
}

module.exports = {
  FLAG_KEYS,
  X6551Client,
  collectObjects,
  largestObjectArray,
  normalizeTweets,
  normalizeWatch,
  normalizeWatchFlags,
  profileWebsiteUrls,
  preserveWatchUsername
};
