const INTENT_RULE_REVISION = 'p35-asset-identity-v2';

const PATTERNS = Object.freeze({
  security: [
    /\b(?:hack(?:ed)?|exploit(?:ed)?|compromised|security incident|vulnerability)\b/i,
    /(?:被盗|黑客|攻击|漏洞|账号异常|安全事件)/u
  ],
  negative: [
    /\b(?:avoid|scam|rug|warning|beware|do not buy|don't buy|not buying)\b/i,
    /(?:不要买|别买|骗局|警告|远离|高风险|疑似假币)/u
  ],
  sell: [
    /\b(?:sell|selling|sold|exit|exited|close|closed|take profit|taking profit)\b/i,
    /(?:卖出|已卖|清仓|出货|止盈|退出|平仓)/u
  ],
  historical: [
    /\b(?:yesterday|last week|last month|previously|historical|history|looking back|review)\b/i,
    /(?:昨天|前天|上周|上个月|此前|曾经|当时|历史|回顾)/u
  ],
  comparison: [
    /\b(?:vs\.?|versus|compare|comparison|top tokens?|watchlist|shortlist)\b/i,
    /(?:对比|比较|排行榜|观察列表|候选列表|盘点)/u
  ],
  buy: [
    /\b(?:buy|buying|ape|aping|long|adding|accumulating)\b/i,
    /(?:买入|正在买|加仓|建仓|冲了|上车)/u
  ],
  launch: [
    /\b(?:launching|launched|launch now|live now|contract is|ca is)\b/i,
    /(?:正式发布|已经上线|现已上线|发币|开盘|合约地址)/u
  ]
});

function matchedCodes(text, patterns, code) {
  return patterns.some((pattern) => pattern.test(text)) ? [code] : [];
}

function assetIdentity(term) {
  if (term.assetKey) return term.assetKey;
  if (term.type === 'ca') return `ca:${term.normalized}`;
  if (['cashtag', 'hashtag'].includes(term.type)) return `symbol:${term.normalized}`;
  if (term.type === 'approved_name') {
    return `name:${term.assetFamilyId || term.matchKey || term.normalized}`;
  }
  return null;
}

function uniqueAuthorAssets(extraction) {
  const identities = new Map();
  for (const term of extraction?.authorOwnedTerms || []) {
    const identity = assetIdentity(term);
    if (identity && !identities.has(identity)) identities.set(identity, term);
  }
  return [...identities.values()];
}

function isFullCaSolo(_text, assetTerms) {
  return assetTerms.length === 1 && assetTerms[0].type === 'ca';
}

function decision(intentClass, reasonCodes, extraction) {
  const canProceedToResolution = [
    'buy_direct', 'launch_direct', 'full_ca_solo', 'approved_term_direct'
  ]
    .includes(intentClass);
  return {
    intentClass,
    reasonCodes,
    ruleRevision: INTENT_RULE_REVISION,
    canProceedToResolution,
    canAuthorizeLive: false,
    authorOwnedTerms: extraction?.authorOwnedTerms || [],
    quotedTerms: extraction?.quotedTerms || []
  };
}

function classifyIntent(extraction = {}) {
  const text = String(extraction.actorText || '').normalize('NFKC');
  const eventType = String(extraction.eventType || '').toLowerCase();
  const assets = uniqueAuthorAssets(extraction);
  const contextAssets = (extraction.quotedTerms || []).filter((term) => assetIdentity(term));

  if (eventType === 'retweet') {
    return decision('quoted_only', ['RETWEET_NOT_AUTHOR_OWNED'], extraction);
  }
  const security = matchedCodes(text, PATTERNS.security, 'SECURITY_EVENT_LANGUAGE');
  if (security.length > 0) return decision('security_incident', security, extraction);
  const negative = matchedCodes(text, PATTERNS.negative, 'NEGATIVE_OR_WARNING_LANGUAGE');
  if (negative.length > 0) return decision('negative_or_warning', negative, extraction);
  const sell = matchedCodes(text, PATTERNS.sell, 'SELL_OR_EXIT_LANGUAGE');
  if (sell.length > 0) return decision('sell_or_exit', sell, extraction);
  const historical = matchedCodes(text, PATTERNS.historical, 'HISTORICAL_CONTEXT');
  if (historical.length > 0) return decision('historical_review', historical, extraction);
  const comparison = matchedCodes(text, PATTERNS.comparison, 'COMPARISON_OR_LIST_CONTEXT');
  if (comparison.length > 0) return decision('comparison_or_list', comparison, extraction);
  if (assets.length > 1) {
    return decision('multi_asset_ambiguous', ['MULTIPLE_AUTHOR_ASSETS'], extraction);
  }
  if (assets.length === 0 && contextAssets.length > 0) {
    return decision('quoted_only', ['ASSET_ONLY_IN_CONTEXT'], extraction);
  }

  const buy = matchedCodes(text, PATTERNS.buy, 'EXPLICIT_BUY_LANGUAGE');
  if (buy.length > 0 && assets.length === 1) return decision('buy_direct', buy, extraction);
  const launch = matchedCodes(text, PATTERNS.launch, 'EXPLICIT_LAUNCH_LANGUAGE');
  if (launch.length > 0 && assets.length === 1) return decision('launch_direct', launch, extraction);
  if (isFullCaSolo(text, assets)) {
    return decision('full_ca_solo', ['SOLE_AUTHOR_CA'], extraction);
  }
  if (assets.length === 1 && (assets[0].type === 'approved_name'
      || assets[0].localPresetRouteAlias === true)) {
    return decision('approved_term_direct', ['APPROVED_TERM_MATCH'], extraction);
  }
  if (assets.length === 1) {
    return decision('neutral_reference', ['ASSET_WITHOUT_CURRENT_ACTION'], extraction);
  }
  return decision('unknown', ['NO_ACTIONABLE_ASSET_INTENT'], extraction);
}

module.exports = {
  INTENT_RULE_REVISION,
  PATTERNS,
  classifyIntent,
  isFullCaSolo,
  uniqueAuthorAssets
};
