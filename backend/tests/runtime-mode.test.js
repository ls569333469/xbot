const test = require('node:test');
const assert = require('node:assert/strict');
const { getTradingMode, assertLiveExitMode, assertLiveMode } = require('../lib/runtime-mode');

test('getTradingMode accepts only signal, paper, and live', () => {
  assert.equal(getTradingMode({ TRADING_MODE: 'signal' }), 'signal');
  assert.equal(getTradingMode({ TRADING_MODE: 'PAPER' }), 'paper');
  assert.equal(getTradingMode({ TRADING_MODE: 'live' }), 'live');
  assert.throws(() => getTradingMode({ TRADING_MODE: 'unknown' }), { code: 'INVALID_TRADING_MODE' });
});

test('assertLiveMode requires both live mode and armed state', () => {
  const locked = { getArmed: () => false };
  const armed = { getArmed: () => true };
  assert.throws(() => assertLiveMode(armed, { TRADING_MODE: 'paper' }), { code: 'LIVE_MODE_REQUIRED' });
  assert.throws(() => assertLiveMode(locked, { TRADING_MODE: 'live' }), { code: 'ENGINE_LOCKED' });
  assert.doesNotThrow(() => assertLiveMode(armed, { TRADING_MODE: 'live' }));
});

test('assertLiveExitMode allows risk-reducing exits without the new-order gate', () => {
  assert.doesNotThrow(() => assertLiveExitMode({
    TRADING_MODE: 'live',
    LIVE_TRADING_ENABLED: 'true'
  }));
  assert.throws(() => assertLiveExitMode({
    TRADING_MODE: 'paper',
    LIVE_TRADING_ENABLED: 'true'
  }), { code: 'LIVE_MODE_REQUIRED' });
  assert.throws(() => assertLiveExitMode({
    TRADING_MODE: 'live',
    LIVE_TRADING_ENABLED: 'false'
  }), { code: 'LIVE_DISABLED' });
});
