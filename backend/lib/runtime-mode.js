const { legacyPaperEnabled } = require('./legacy-features');

const VALID_TRADING_MODES = new Set(['signal', 'paper', 'live']);

function getTradingMode(env = process.env) {
  const mode = String(env.TRADING_MODE || 'signal').trim().toLowerCase();
  if (!VALID_TRADING_MODES.has(mode)) {
    const error = new Error(`Unsupported TRADING_MODE: ${mode}`);
    error.code = 'INVALID_TRADING_MODE';
    throw error;
  }
  if (mode === 'paper' && !legacyPaperEnabled(env)) {
    const error = new Error('Paper trading is isolated from production; enable XBOT_LEGACY_PAPER_ENABLED explicitly');
    error.code = 'LEGACY_PAPER_DISABLED';
    throw error;
  }
  return mode;
}

function assertLiveMode(engineState, env = process.env) {
  if (getTradingMode(env) !== 'live') {
    const error = new Error('Real trading is disabled outside live mode');
    error.code = 'LIVE_MODE_REQUIRED';
    throw error;
  }
  if (!engineState.getArmed()) {
    const error = new Error('Real trading engine is locked');
    error.code = 'ENGINE_LOCKED';
    throw error;
  }
}

function assertLiveExitMode(env = process.env) {
  if (getTradingMode(env) !== 'live') {
    const error = new Error('Real trading is disabled outside live mode');
    error.code = 'LIVE_MODE_REQUIRED';
    throw error;
  }
  if (String(env.LIVE_TRADING_ENABLED || 'false').trim().toLowerCase() !== 'true') {
    const error = new Error('Live trading is disabled by configuration');
    error.code = 'LIVE_DISABLED';
    throw error;
  }
}

module.exports = {
  VALID_TRADING_MODES,
  getTradingMode,
  assertLiveExitMode,
  assertLiveMode
};
