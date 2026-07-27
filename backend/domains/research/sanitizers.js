const net = require('net');
const { normalizeXHandle } = require('../../lib/x-handles');

function safeText(value, maxLength = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isPrivateHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!value || value === 'localhost' || value.endsWith('.local')) return true;
  if (value === '::' || value === '::1') return true;
  if (net.isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    return parts[0] === 0
      || parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
      || parts[0] >= 224;
  }
  if (net.isIP(value) !== 6) return false;
  if (value.startsWith('::ffff:')) return isPrivateHostname(value.slice(7));
  return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80');
}

function safeUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol) || isPrivateHostname(parsed.hostname)) return null;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().slice(0, 500);
  } catch {
    return null;
  }
}

function safeHandle(value) {
  const handle = normalizeXHandle(value);
  return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

function firstValue(source, paths) {
  for (const path of paths) {
    let current = source;
    for (const part of path.split('.')) current = current?.[part];
    if (current !== undefined && current !== null && current !== '') return current;
  }
  return null;
}

function sanitizeTokenMetadata(chain, address, raw) {
  const links = raw?.link || raw?.links || raw?.socials || {};
  const twitter = firstValue({ raw, links }, [
    'raw.twitter_username',
    'raw.twitter',
    'raw.x_handle',
    'links.twitter_username',
    'links.twitter',
    'links.x'
  ]);
  const twitterHandle = safeHandle(
    typeof twitter === 'string' ? twitter.replace(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i, '').split(/[/?#]/)[0] : ''
  );
  const decimals = Number(firstValue(raw, ['decimals']));
  return {
    chain,
    address,
    name: safeText(firstValue(raw, ['name', 'token_name']), 100),
    symbol: safeText(firstValue(raw, ['symbol', 'token_symbol']), 24).toUpperCase(),
    decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null,
    logo_url: safeUrl(firstValue(raw, ['logo', 'logo_url', 'image', 'icon'])),
    official_x_handle: twitterHandle,
    website_url: safeUrl(firstValue({ raw, links }, [
      'raw.website', 'raw.website_url', 'links.website', 'links.homepage'
    ])),
    source: 'gmgn',
    fetched_at: new Date().toISOString()
  };
}

function sanitizeCandidate(value, defaults = {}) {
  const handle = safeHandle(value?.handle ?? value?.username ?? value?.screen_name);
  if (!handle) return null;
  const confidence = ['verified', 'high', 'medium', 'low', 'unverified']
    .includes(String(value?.confidence || defaults.confidence || '').toLowerCase())
    ? String(value?.confidence || defaults.confidence).toLowerCase()
    : 'unverified';
  const evidence = (Array.isArray(value?.evidence) ? value.evidence : [])
    .slice(0, 8)
    .map((item) => ({
      label: safeText(item?.label ?? item?.title ?? item, 120),
      url: safeUrl(item?.url),
      tweet_id: safeText(item?.tweet_id, 40) || null,
      source: safeText(item?.source, 40) || null
    }))
    .filter((item) => item.label || item.url || item.tweet_id);
  return {
    handle,
    display_name: safeText(value?.display_name ?? value?.name, 100),
    role: safeText(value?.role ?? defaults.role ?? 'project', 60) || 'project',
    organization: safeText(value?.organization, 100),
    association: safeText(value?.association, 240),
    confidence,
    verified: value?.verified === true || confidence === 'verified',
    source: safeText(value?.source ?? defaults.source ?? 'research', 40),
    evidence
  };
}

module.exports = {
  firstValue,
  isPrivateHostname,
  safeHandle,
  safeText,
  safeUrl,
  sanitizeCandidate,
  sanitizeTokenMetadata
};
