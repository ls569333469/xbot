const EVM_CA_REGEX = /0x[0-9a-fA-F]{40}/g;
const SOL_CA_REGEX = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const TICKER_REGEX = /\$([A-Z]{1,10})\b/g;
const HANDLE_REGEX = /@([a-zA-Z0-9_]{1,15})/g;

function extractFromText(text) {
  if (!text) return { cas: [], tickers: [] };
  
  const cas = [];
  const evmMatches = text.match(EVM_CA_REGEX) || [];
  cas.push(...evmMatches);
  
  const solMatches = text.match(SOL_CA_REGEX) || [];
  // Filter out all-uppercase or all-lowercase matches to reduce false positives
  const validSol = solMatches.filter(m => m !== m.toUpperCase() && m !== m.toLowerCase());
  cas.push(...validSol);
  
  const tickers = [];
  let match;
  while ((match = TICKER_REGEX.exec(text)) !== null) {
    tickers.push(match[1]);
  }
  
  return {
    cas: [...new Set(cas)],
    tickers: [...new Set(tickers)]
  };
}

function extractHandles(text) {
  if (!text) return [];
  const handles = [];
  let match;
  while ((match = HANDLE_REGEX.exec(text)) !== null) {
    handles.push(match[1]);
  }
  return [...new Set(handles)];
}

module.exports = {
  extractFromText,
  extractHandles
};
