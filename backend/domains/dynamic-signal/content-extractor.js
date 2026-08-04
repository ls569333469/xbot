const { normalizeXHandle } = require('../../lib/x-handles');

const EVM_CA_PATTERN = /(?<![0-9A-Fa-f])0x[0-9A-Fa-f]{40}(?![0-9A-Fa-f])/g;
const SOL_CA_PATTERN = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const TAG_PATTERN = /(?<![A-Za-z0-9_])([$#])([A-Za-z][A-Za-z0-9_]{0,31})(?![A-Za-z0-9_])/g;
const HANDLE_PATTERN = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

function normalizeSymbol(value) {
  return String(value || '').normalize('NFKC').trim().toUpperCase();
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function normalizeApprovedNameMatchKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{Z}\s]+/gu, '');
}

function approvedNameMatchText(value) {
  const text = String(value || '');
  const spans = [];
  let normalized = '';
  let offset = 0;
  for (const character of text) {
    const start = offset;
    offset += character.length;
    const folded = normalizeApprovedNameMatchKey(character);
    for (const foldedCharacter of folded) {
      normalized += foldedCharacter;
      spans.push({ start, end: offset });
    }
  }
  return { normalized, spans };
}

function isAsciiWordCharacter(value) {
  return /^[A-Za-z0-9_]$/.test(value || '');
}

function approvedNameBoundaryMatches(text, matchKey, start) {
  const before = start > 0 ? text[start - 1] : '';
  const after = text[start + matchKey.length] || '';
  return !(isAsciiWordCharacter(matchKey[0]) && isAsciiWordCharacter(before))
    && !(isAsciiWordCharacter(matchKey.at(-1)) && isAsciiWordCharacter(after));
}

function trimUrl(value) {
  return String(value || '').replace(/[),.;!?\]}]+$/g, '');
}

function collectMatches(pattern, text, mapper) {
  const matches = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    matches.push(mapper(match));
    if (match[0] === '') pattern.lastIndex += 1;
  }
  return matches;
}

function extractUrls(text) {
  return collectMatches(URL_PATTERN, text, (match) => {
    const value = trimUrl(match[0]);
    return {
      type: 'url',
      value,
      normalized: value.toLowerCase(),
      start: match.index,
      end: match.index + value.length,
      via: 'text'
    };
  }).filter((term) => {
    try {
      const parsed = new URL(term.value);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  });
}

function insideUrl(term, urls) {
  return urls.some((url) => term.start >= url.start && term.end <= url.end);
}

function termIdentityValue(term) {
  return term.type === 'approved_name'
    ? term.matchKey || normalizeApprovedNameMatchKey(term.normalized)
    : term.normalized;
}

function approvedAliasRecords(aliases) {
  return (Array.isArray(aliases) ? aliases : [])
    .map((alias) => typeof alias === 'string' ? { value: alias } : alias)
    .map((alias) => ({
      value: String(alias?.value || alias?.name || '').normalize('NFKC').trim(),
      normalized: normalizeName(alias?.normalized || alias?.value || alias?.name),
      matchKey: normalizeApprovedNameMatchKey(alias?.normalized || alias?.value || alias?.name),
      assetFamilyId: alias?.assetFamilyId ?? alias?.asset_family_id ?? null
    }))
    .filter((alias) => alias.value && alias.normalized && alias.matchKey);
}

function extractTextTerms(textValue, source, aliases = []) {
  const text = String(textValue || '').normalize('NFKC');
  const urls = extractUrls(text);
  const terms = [...urls];

  const evmTerms = collectMatches(EVM_CA_PATTERN, text, (match) => ({
    type: 'ca',
    value: match[0],
    normalized: match[0].toLowerCase(),
    addressType: 'evm',
    start: match.index,
    end: match.index + match[0].length
  }));
  terms.push(...evmTerms);
  terms.push(...collectMatches(SOL_CA_PATTERN, text, (match) => ({
    type: 'ca',
    value: match[0],
    normalized: match[0],
    addressType: 'sol',
    start: match.index,
    end: match.index + match[0].length
  })).filter((term) => {
    const overlapsEvm = evmTerms.some((evm) => term.start < evm.end && term.end > evm.start);
    const mixedCase = term.value !== term.value.toLowerCase()
      && term.value !== term.value.toUpperCase();
    return !overlapsEvm && mixedCase;
  }));
  terms.push(...collectMatches(TAG_PATTERN, text, (match) => ({
    type: match[1] === '$' ? 'cashtag' : 'hashtag',
    value: match[0],
    normalized: normalizeSymbol(match[2]),
    start: match.index,
    end: match.index + match[0].length,
    prefix: match[1]
  })));
  terms.push(...collectMatches(HANDLE_PATTERN, text, (match) => ({
    type: 'x_handle',
    value: match[0],
    normalized: normalizeXHandle(match[1]),
    start: match.index,
    end: match.index + match[0].length
  })));

  const approvedText = approvedNameMatchText(text);
  for (const alias of approvedAliasRecords(aliases)) {
    let offset = 0;
    while ((offset = approvedText.normalized.indexOf(alias.matchKey, offset)) !== -1) {
      if (!approvedNameBoundaryMatches(approvedText.normalized, alias.matchKey, offset)) {
        offset += Math.max(1, alias.matchKey.length);
        continue;
      }
      const start = approvedText.spans[offset]?.start ?? 0;
      const end = approvedText.spans[offset + alias.matchKey.length - 1]?.end ?? start;
      terms.push({
        type: 'approved_name',
        value: text.slice(start, end),
        normalized: alias.normalized,
        matchKey: alias.matchKey,
        assetFamilyId: alias.assetFamilyId,
        start,
        end,
        via: 'approved_alias'
      });
      offset += Math.max(1, alias.matchKey.length);
    }
  }

  return terms
    .map((term) => ({
      ...term,
      source,
      via: term.via || (insideUrl(term, urls) ? 'url' : 'text')
    }))
    .filter((term, index, all) => all.findIndex((candidate) => (
      candidate.type === term.type
      && termIdentityValue(candidate) === termIdentityValue(term)
      && candidate.source === term.source
      && candidate.start === term.start
    )) === index)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function extractContent(input = {}) {
  const eventType = String(input.eventType || input.event_type || 'tweet').toLowerCase();
  const actorText = String(input.actorText ?? input.text ?? '');
  const quotedText = String(input.quotedText ?? input.quoted_text ?? '');
  const replyText = String(input.replyText ?? input.reply_text ?? '');
  const retweetedText = String(input.retweetedText ?? input.retweeted_text ?? '');
  const aliases = input.approvedAliases || input.approved_aliases || [];

  const actorTerms = eventType === 'retweet'
    ? []
    : extractTextTerms(actorText, 'actor', aliases);
  const contextTerms = [
    ...extractTextTerms(quotedText, 'quoted', aliases),
    ...extractTextTerms(replyText, 'reply_context', aliases),
    ...extractTextTerms(retweetedText || (eventType === 'retweet' ? actorText : ''), 'retweeted', aliases)
  ];
  const observedTerms = [...actorTerms, ...contextTerms];

  return {
    eventType,
    actorText,
    context: { quotedText, replyText, retweetedText },
    observedTerms,
    authorOwnedTerms: actorTerms,
    quotedTerms: contextTerms,
    assetTerms: observedTerms.filter((term) => (
      ['ca', 'cashtag', 'hashtag', 'approved_name'].includes(term.type)
    )),
    urls: observedTerms.filter((term) => term.type === 'url'),
    handles: observedTerms.filter((term) => term.type === 'x_handle')
  };
}

module.exports = {
  EVM_CA_PATTERN,
  HANDLE_PATTERN,
  SOL_CA_PATTERN,
  TAG_PATTERN,
  extractContent,
  extractTextTerms,
  normalizeApprovedNameMatchKey,
  normalizeName,
  normalizeSymbol,
  termIdentityValue
};
