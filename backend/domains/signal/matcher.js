const db = require('../../lib/db');
const signalQueries = require('./queries');
const { normalizeXHandles } = require('../../lib/x-handles');

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
  const relevant = handleSet.size > 0
    ? relations.filter((relation) => handleSet.has(normalizeXHandles([relation.target_x_handle])[0]))
    : relations;
  return relevant.map((relation) => Number(relation.id)).filter(Number.isFinite);
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
    const match = classifyActivityMatch(activity, whitelist);
    if (!match) continue;
    const chainId = String(whitelist.chain_id || '').trim().toLowerCase();
    const contractAddress = normalizeContractAddress(chainId, whitelist.contract_address);
    const groupKey = `${chainId}:${contractAddress}`;
    const group = groups.get(groupKey) || {
      whitelist,
      matches: [],
      matchedProjectHandles: new Set(),
      matchedWhitelistIds: new Set(),
      matchedRelationIds: new Set()
    };
    group.matches.push(match);
    group.matchedWhitelistIds.add(Number(whitelist.id));
    const matchedHandles = findMatchingProjectHandles(activity, whitelist.project_x_handles);
    matchedHandles.forEach((handle) => group.matchedProjectHandles.add(handle));
    findMatchingRelationIds(activity, whitelist, matchedHandles)
      .forEach((id) => group.matchedRelationIds.add(id));
    groups.set(groupKey, group);
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
            array_agg(DISTINCT relation.target_x_handle ORDER BY relation.target_x_handle)
              AS project_x_handles,
            json_agg(json_build_object(
              'id', relation.id,
              'kol_id', relation.kol_id,
              'target_x_handle', relation.target_x_handle
            ) ORDER BY relation.id) AS relations
     FROM ca_whitelist AS whitelist
     JOIN x_signal_relations AS relation
       ON relation.whitelist_id = whitelist.id AND relation.enabled = true
     JOIN x_kol_accounts AS actor
       ON actor.id = relation.kol_id AND actor.enabled = true
     WHERE whitelist.status = 'active' AND relation.kol_id = $1
     GROUP BY whitelist.id`,
    [activity.kol_id]
  );
  const whitelists = whitelistsRes.rows;

  let matches = 0;
  const signals = [];
  for (const group of groupActivityMatches(activity, whitelists)) {
    const match = representativeMatch(group);
    const signal = await signalQueries.createSignal({
        activity_id: activity.id,
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
        follow_once: activity.activity_type === 'follow'
      }, executor, options);
    if (signal) {
      matches++;
      signals.push(signal);
    }
  }

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
  matchActivity
};
