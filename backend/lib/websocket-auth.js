const crypto = require('crypto');

const AUTH_PROTOCOL = 'xbot-auth';

function offeredProtocols(req) {
  return String(req?.headers?.['sec-websocket-protocol'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function decodeToken(value) {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function getPresentedToken(req) {
  const protocols = offeredProtocols(req);
  const authIndex = protocols.indexOf(AUTH_PROTOCOL);
  if (authIndex < 0 || authIndex + 1 >= protocols.length) return '';
  return decodeToken(protocols[authIndex + 1]);
}

function tokensEqual(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected || ''));
  const actualBuffer = Buffer.from(String(actual || ''));
  return expectedBuffer.length > 0
    && expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function authorizeWebSocketRequest(req, expectedToken) {
  return tokensEqual(expectedToken, getPresentedToken(req));
}

function selectWebSocketProtocol(protocols) {
  return protocols.has(AUTH_PROTOCOL) ? AUTH_PROTOCOL : false;
}

module.exports = {
  AUTH_PROTOCOL,
  authorizeWebSocketRequest,
  getPresentedToken,
  selectWebSocketProtocol
};
