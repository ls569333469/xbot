const { collectObjects } = require('../../../lib/x-client-6551');
const { extractFromText, extractHandles } = require('../../../lib/signal-extractor');
const { normalizeXHandle, normalizeXHandles } = require('../../../lib/x-handles');

const TWEET_EVENT_TYPES = new Map([
  ['NEW_TWEET', 'tweet'],
  ['NEW_TWEET_REPLY', 'reply'],
  ['NEW_TWEET_QUOTE', 'quote'],
  ['NEW_RETWEET', 'retweet'],
  ['CA', 'tweet']
]);

function parseContent(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return { text: value };
  }
}

function firstValue(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      if (object?.[key] !== undefined && object[key] !== null && object[key] !== '') {
        return object[key];
      }
    }
  }
  return null;
}

function handlesFromMentions(content) {
  const mentions = [];
  for (const object of collectObjects(content)) {
    if (!Array.isArray(object.mentions)) continue;
    for (const mention of object.mentions) {
      if (typeof mention === 'string') mentions.push(mention);
      else mentions.push(mention?.username ?? mention?.screenName ?? mention?.twAccount);
    }
  }
  return normalizeXHandles(mentions);
}

function handlesFromNamedStatus(payload, statusKeys) {
  const handles = [];
  for (const object of collectObjects(payload)) {
    for (const key of statusKeys) {
      const status = object?.[key];
      if (!status || typeof status !== 'object') continue;
      const statusObjects = collectObjects(status);
      const handle = firstValue(statusObjects, [
        'userScreenName', 'screenName', 'twAccount', 'username', 'userName'
      ]);
      if (handle) handles.push(handle);
    }
  }
  return normalizeXHandles(handles);
}

function hasNamedStatus(payload, statusKeys) {
  return collectObjects(payload).some((object) => statusKeys.some((key) => {
    const status = object?.[key];
    return status && typeof status === 'object';
  }));
}

function leadingReplyHandle(text) {
  const match = String(text || '').match(/^\s*@([A-Za-z0-9_]{1,15})\b/);
  return normalizeXHandle(match?.[1]);
}

function extractInteractionTargets(activityType, content, enrichment) {
  const direct = [];
  const objects = collectObjects(content);
  if (activityType === 'reply') {
    direct.push(firstValue(objects, [
      'inReplyToScreenName', 'inReplyToUsername', 'replyToScreenName', 'replyToUsername'
    ]));
    direct.push(...handlesFromNamedStatus([content, enrichment], ['replyStatus', 'repliedStatus']));
  } else if (activityType === 'quote') {
    direct.push(...handlesFromNamedStatus([content, enrichment], ['quotedStatus', 'quoteStatus']));
  } else if (activityType === 'retweet') {
    direct.push(...handlesFromNamedStatus([content, enrichment], ['retweetedStatus', 'retweetStatus']));
  }
  return normalizeXHandles(direct);
}

function normalizeTweetEvent(event, options = {}) {
  const eventType = String(event.eventType || '').toUpperCase();
  let activityType = TWEET_EVENT_TYPES.get(eventType);
  if (!activityType) return [];

  const content = parseContent(event.content) || {};
  if (eventType === 'CA') {
    if (content.isReply === true || hasNamedStatus(content, ['replyStatus', 'repliedStatus'])) {
      activityType = 'reply';
    } else if (content.isQuote === true || hasNamedStatus(content, ['quotedStatus', 'quoteStatus'])) {
      activityType = 'quote';
    } else if (hasNamedStatus(content, ['retweetedStatus', 'retweetStatus'])) {
      activityType = 'retweet';
    }
  }
  const objects = collectObjects(content);
  const actorHandle = normalizeXHandle(
    firstValue(objects, ['userScreenName', 'screenName', 'twAccount', 'username']) || event.twAccount
  );
  const tweetId = String(firstValue(objects, ['id', 'idStr', 'id_str', 'tweetId']) || '');
  const text = String(firstValue(objects, ['text', 'fullText', 'full_text']) || '');
  const sourceCreatedAt = firstValue(objects, ['createdAt', 'tweetCreatedAt', 'created_at']) || event.createdAt;
  if (!actorHandle || !tweetId || !sourceCreatedAt) {
    const error = new Error('6551 tweet event is missing actor, tweet ID, or provider timestamp');
    error.code = 'X6551_EVENT_SCHEMA_ERROR';
    throw error;
  }

  const interactionTargets = extractInteractionTargets(activityType, content, options.enrichment);
  if (activityType === 'reply' && interactionTargets.length === 0) {
    const leadingHandle = leadingReplyHandle(text);
    if (leadingHandle) interactionTargets.push(leadingHandle);
  }
  const targetHandles = normalizeXHandles([
    ...handlesFromMentions(content),
    ...extractHandles(text),
    ...interactionTargets
  ]).filter((handle) => handle !== actorHandle);
  const extracted = extractFromText(text);
  if (event.ca) extracted.cas.push(String(event.ca));

  return [{
    kind: 'activity',
    actorHandle,
    actorUserId: String(firstValue(objects, ['userIdStr', 'userId', 'twId']) || actorHandle),
    activityType,
    tweetId,
    tweetText: text,
    targetHandles,
    extractedCas: [...new Set(extracted.cas)],
    extractedTickers: extracted.tickers,
    sourceCreatedAt,
    semanticKey: `tweet:${actorHandle}:${tweetId}`,
    needsEnrichment: ['reply', 'quote', 'retweet'].includes(activityType)
      && interactionTargets.length === 0,
    raw: event
  }];
}

function normalizeFollowerEvent(event) {
  const eventType = String(event.eventType || '').toUpperCase();
  if (!['NEW_FOLLOWER', 'NEW_UNFOLLOWER'].includes(eventType)) return [];
  const actorHandle = normalizeXHandle(event.twAccount);
  const content = parseContent(event.content);
  const followedAccounts = Array.isArray(content) ? content : [content];
  const sourceCreatedAt = event.createdAt;
  if (!actorHandle || !sourceCreatedAt) {
    const error = new Error('6551 follow event is missing actor account or provider timestamp');
    error.code = 'X6551_EVENT_SCHEMA_ERROR';
    throw error;
  }

  return followedAccounts.filter(Boolean).map((followedAccount) => {
    const objects = collectObjects(followedAccount);
    const targetHandle = normalizeXHandle(
      firstValue(objects, ['twAccount', 'screenName', 'username', 'userScreenName'])
    );
    if (!targetHandle) {
      const error = new Error('6551 follow entry is missing the target account');
      error.code = 'X6551_EVENT_SCHEMA_ERROR';
      throw error;
    }
    const activityType = eventType === 'NEW_FOLLOWER' ? 'follow' : 'unfollow';
    const targetUserId = String(firstValue(objects, ['twId', 'userIdStr', 'userId', 'rest_id', 'id']) || '').trim();
    return {
      kind: 'activity',
      actorHandle,
      actorUserId: actorHandle,
      activityType,
      tweetId: null,
      tweetText: '',
      targetHandles: [targetHandle],
      targetUserId,
      extractedCas: [],
      extractedTickers: [],
      sourceCreatedAt,
      semanticKey: `${activityType}:${actorHandle}:${targetHandle}`,
      needsEnrichment: false,
      raw: { event, followedAccount }
    };
  });
}

function normalize6551Event(event, options = {}) {
  const eventType = String(event?.eventType || '').toUpperCase();
  if (TWEET_EVENT_TYPES.has(eventType)) return normalizeTweetEvent(event, options);
  if (['NEW_FOLLOWER', 'NEW_UNFOLLOWER'].includes(eventType)) return normalizeFollowerEvent(event);
  return [];
}

module.exports = {
  TWEET_EVENT_TYPES,
  extractInteractionTargets,
  leadingReplyHandle,
  normalize6551Event,
  normalizeFollowerEvent,
  normalizeTweetEvent,
  parseContent
};
