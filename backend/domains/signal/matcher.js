const db = require('../../lib/db');
const signalQueries = require('./queries');
const { matchLaunchActivity } = require('./launch-matcher');
const { normalizeXHandles } = require('../../lib/x-handles');
const RELATION_EVENT_TYPES = ['retweet', 'quote', 'reply', 'follow'];
const DIRECT_SOURCE_EVENT_TYPES = ['tweet', 'retweet', 'quote', 'reply'];

function relationEventTypes(relation) {
  return Array.isArray(relation.event_types) && relation.event_types.length > 0
    ? relation.event_types
    : RELATION_EVENT_TYPES;
}

function sourceRuleEventTypes(rule) {
  return Array.isArray(rule.event_types) && rule.event_types.length > 0
    ? rule.event_types
    : DIRECT_SOURCE_EVENT_TYPES;
}

function findMatchingProjectHandle(activity, projectHandles) {
  return findMatchingProjectHandles(activity, projectHandles)[0] || null;
}

function findMatchingProjectHandles(activity, projectHandles) {
  const targetHandleSet = new Set(normalizeXHandles([
    ...(activity.target_x_handles || []),
    activity.target_x_handle
  ]));

  return normalizeXHandles(projectHandles || [])
    .filter((handle) => targetHandleSet.has(handle));
}

function findMatchingRelationIds(activity, whitelist, matchedHandles) {
  const handleSet = new Set(matchedHandles);
  const relations = Array.isArray(whitelist.relations) ? whitelist.relations : [];
  const activityType = String(activity.activity_type || '').trim().toLowerCase();
  const relevant = relations
    .filter((relation) => {
      return relationEventTypes(relation).includes(activityType);
    })
    .filter((relation) => handleSet.size === 0
      || handleSet.has(normalizeXHandles([relation.target_x_handle])[0]));
  return relevant.map((relation) => Number(relation.id)).filter(Number.isFinite);
}

function relationsForActivity(activity, whitelist) {
  const activityType = String(activity.activity_type || '').trim().toLowerCase();
  const targetHandleSet = new Set(normalizeXHandles([
    ...(activity.target_x_handles || []),
    activity.target_x_handle
  ]));
  const configuredRelations = Array.isArray(whitelist.relations) ? whitelist.relations : [];
  const relations = configuredRelations
    .filter((relation) => {
      return relationEventTypes(relation).includes(activityType);
    });
  const targetRelations = relations.filter((relation) => targetHandleSet.has(
    normalizeXHandles([relation.target_x_handle])[0]
  ));
  return { relations, targetRelations };
}

function matchingSourceRules(activity, whitelist) {
  const activityType = String(activity.activity_type || '').trim().toLowerCase();
  return (Array.isArray(whitelist.direct_sources) ? whitelist.direct_sources : [])
    .filter((rule) => sourceRuleEventTypes(rule).includes(activityType))
    .filter((rule) => rule.match_mode === 'ca_only')
    .filter((rule) => rule.source_kind === 'ecosystem')
    .filter(() => hasContractAddress(activity, whitelist));
}

function sourceRuleMatch(activity, whitelist) {
  if (hasContractAddress(activity, whitelist)) {
    return { signal_type: 'ca_mention', match_detail: whitelist.contract_address };
  }
  return null;
}

function hasContractAddress(activity, whitelist) {
  const expected = String(whitelist.contract_address || '');
  if (!expected) return false;

  return (activity.extracted_cas || []).some((candidate) => {
    const actual = String(candidate);
    return whitelist.chain_id === 'sol'
      ? actual === expected
      : actual.toLowerCase() === expected.toLowerCase();
  });
}

function hasSymbolKeyword(activity, symbol) {
  const keyword = String(symbol || '').trim();
  if (!keyword) return false;

  const extractedTickers = (activity.extracted_tickers || [])
    .map((ticker) => String(ticker).toUpperCase());
  if (extractedTickers.includes(keyword.toUpperCase())) return true;

  const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keywordPattern = new RegExp(
    `(^|[^A-Za-z0-9_])${escapedKeyword}(?=$|[^A-Za-z0-9_])`,
    'i'
  );
  return keywordPattern.test(activity.tweet_text || '');
}

function classifyActivityMatch(activity, whitelist) {
  const matchedHandle = findMatchingProjectHandle(activity, whitelist.project_x_handles);
  if (matchedHandle) {
    return { signal_type: 'handle_match', match_detail: matchedHandle };
  }

  if (hasContractAddress(activity, whitelist)) {
    return { signal_type: 'ca_mention', match_detail: whitelist.contract_address };
  }

  if (hasSymbolKeyword(activity, whitelist.symbol)) {
    return { signal_type: 'ticker_mention', match_detail: String(whitelist.symbol).toUpperCase() };
  }

  return null;
}

function normalizeContractAddress(chainId, contractAddress) {
  const value = String(contractAddress || '').trim();
  return String(chainId || '').toLowerCase() === 'sol' ? value : value.toLowerCase();
}

function sourceBehaviorKey(activity) {
  if (activity.semantic_key) return String(activity.semantic_key);
  const actor = normalizeXHandles([activity.kol_handle])[0] || String(activity.kol_id);
  if (activity.tweet_id) return `tweet:${actor}:${activity.tweet_id}`;
  if (activity.activity_type === 'follow' || activity.activity_type === 'unfollow') {
    const target = normalizeXHandles([
      ...(activity.target_x_handles || []),
      activity.target_x_handle
    ])[0];
    if (target) return `${activity.activity_type}:${actor}:${target}`;
  }
  return `activity:${activity.id}`;
}

function canonicalSignalKey(activity, whitelist) {
  const chainId = String(whitelist.chain_id || '').trim().toLowerCase();
  const contractAddress = normalizeContractAddress(chainId, whitelist.contract_address);
  return `${sourceBehaviorKey(activity)}|kol:${activity.kol_id}|chain:${chainId}|ca:${contractAddress}`;
}

function groupActivityMatches(activity, whitelists) {
  const groups = new Map();
  for (const whitelist of whitelists) {
    const { relations, targetRelations } = relationsForActivity(activity, whitelist);
    const scopedRelations = activity.activity_type === 'tweet' ? relations : targetRelations;
    const chainId = String(whitelist.chain_id || '').trim().toLowerCase();
    const contractAddress = normalizeContractAddress(chainId, whitelist.contract_address);
    const groupKey = `${chainId}:${contractAddress}`;
    const ensureGroup = () => {
      const group = groups.get(groupKey) || {
        whitelist,
        matches: [],
        matchedProjectHandles: new Set(),
        matchedWhitelistIds: new Set(),
        matchedRelationIds: new Set(),
        matchedSourceRuleIds: new Set()
      };
      group.matchedWhitelistIds.add(Number(whitelist.id));
      groups.set(groupKey, group);
      return group;
    };

    if (scopedRelations.length > 0) {
      const scopedWhitelist = {
        ...whitelist,
        relations: scopedRelations,
        project_x_handles: scopedRelations.map((relation) => relation.target_x_handle)
      };
      const match = classifyActivityMatch(activity, scopedWhitelist);
      if (match) {
        const group = ensureGroup();
        group.matches.push(match);
        const matchedHandles = findMatchingProjectHandles(activity, scopedWhitelist.project_x_handles);
        matchedHandles.forEach((handle) => group.matchedProjectHandles.add(handle));
        findMatchingRelationIds(activity, scopedWhitelist, matchedHandles)
          .forEach((id) => group.matchedRelationIds.add(id));
      }
    }

    const sourceRules = matchingSourceRules(activity, whitelist);
    const directMatch = sourceRuleMatch(activity, whitelist);
    if (sourceRules.length > 0 && directMatch) {
      const group = ensureGroup();
      group.matches.push(directMatch);
      sourceRules.forEach((rule) => {
        const id = Number(rule.id);
        if (Number.isFinite(id)) group.matchedSourceRuleIds.add(id);
        const handle = normalizeXHandles([rule.actor_handle])[0];
        if (handle) group.matchedProjectHandles.add(handle);
      });
    }
  }
  return [...groups.values()];
}

function representativeMatch(group) {
  const priority = new Map([
    ['handle_match', 0],
    ['ca_mention', 1],
    ['ticker_mention', 2]
  ]);
  const match = [...group.matches].sort(
    (left, right) => priority.get(left.signal_type) - priority.get(right.signal_type)
  )[0];
  if (match.signal_type === 'handle_match') {
    return {
      signal_type: match.signal_type,
      match_detail: [...group.matchedProjectHandles].sort().join(',')
    };
  }
  return match;
}

async function matchActivity(activity, executor = db, options = {}) {
  if (activity.activity_type === 'unfollow') return 0;
  const whitelistsRes = await executor.query(
    `SELECT whitelist.*,
            COALESCE((
              SELECT array_agg(DISTINCT account.handle ORDER BY account.handle)
              FROM whitelist_x_accounts AS account
              WHERE account.whitelist_id = whitelist.id
            ), whitelist.project_x_handles, '{}'::text[]) AS project_x_handles,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', relation.id,
                'kol_id', relation.kol_id,
                'target_x_handle', relation.target_x_handle,
                'event_types', relation.event_types
              ) ORDER BY relation.id)
              FROM x_signal_relations AS relation
              JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id
              WHERE relation.whitelist_id = whitelist.id
                AND relation.enabled = true AND actor.enabled = true
                AND relation.kol_id = $1
            ), '[]'::json) AS relations,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', rule.id,
                'actor_id', rule.actor_id,
                'actor_handle', actor.x_handle,
                'event_types', rule.event_types,
                'match_mode', rule.match_mode,
                'source_kind', rule.source_kind
              ) ORDER BY rule.id)
              FROM x_signal_source_rules AS rule
              JOIN x_kol_accounts AS actor ON actor.id = rule.actor_id
              WHERE rule.whitelist_id = whitelist.id
                AND rule.enabled = true AND actor.enabled = true
                AND rule.actor_id = $1
            ), '[]'::json) AS direct_sources
     FROM ca_whitelist AS whitelist
     WHERE whitelist.status = 'active'
       AND (whitelist.expires_at IS NULL OR whitelist.expires_at > NOW())
       AND (
         EXISTS(SELECT 1 FROM x_signal_relations AS relation
           JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id
           WHERE relation.whitelist_id = whitelist.id AND relation.kol_id = $1
             AND relation.enabled = true AND actor.enabled = true)
         OR EXISTS(SELECT 1 FROM x_signal_source_rules AS rule
           JOIN x_kol_accounts AS actor ON actor.id = rule.actor_id
           WHERE rule.whitelist_id = whitelist.id AND rule.actor_id = $1
             AND rule.enabled = true AND actor.enabled = true)
       )`,
    [activity.kol_id]
  );
  const whitelists = whitelistsRes.rows;

  let matches = 0;
  const signals = [];
  for (const group of groupActivityMatches(activity, whitelists)) {
    const match = representativeMatch(group);
    const signal = await signalQueries.createSignal({
        activity_id: activity.id,
        trace_id: activity.trace_id,
        whitelist_id: group.whitelist.id,
        kol_id: activity.kol_id,
        kol_handle: activity.kol_handle,
        ...match,
        canonical_key: canonicalSignalKey(activity, group.whitelist),
        contract_address: group.whitelist.contract_address,
        chain_id: group.whitelist.chain_id,
        matched_project_handles: [...group.matchedProjectHandles].sort(),
        matched_whitelist_ids: [...group.matchedWhitelistIds].sort((left, right) => left - right),
        matched_relation_ids: [...group.matchedRelationIds].sort((left, right) => left - right),
        matched_source_rule_ids: [...group.matchedSourceRuleIds].sort((left, right) => left - right),
        follow_once: activity.activity_type === 'follow',
        ...(group.whitelist.live_activation_state === 'live_ready' ? {} : {
          status: 'signal_only',
          reject_reason: 'WHITELIST_NOT_LIVE_READY'
        })
      }, executor, options);
    if (signal) {
      matches++;
      signals.push(signal);
    }
  }

  const launchSignals = await matchLaunchActivity(activity, executor, { existingSignals: signals });
  matches += launchSignals.length;
  signals.push(...launchSignals);

  return options.returnSignals ? { count: matches, signals } : matches;
}

module.exports = {
  classifyActivityMatch,
  canonicalSignalKey,
  findMatchingProjectHandle,
  findMatchingProjectHandles,
  findMatchingRelationIds,
  groupActivityMatches,
  hasContractAddress,
  hasSymbolKeyword,
  matchingSourceRules,
  matchActivity,
  relationsForActivity,
  sourceRuleMatch
};
