const assert = require('node:assert/strict');
const test = require('node:test');
const { TradeRetryOrchestrator } = require('../domains/trade/trade-retry-orchestrator');

test('retry claims stay fast while recovery maintenance is rate-limited', async () => {
  const calls = { claim: 0, staleWrite: 0, stalePreSubmit: 0, restore: 0, expire: 0 };
  const intentRepository = {
    async claimDueRetries() { calls.claim += 1; return []; },
    async recoverStalePreSubmitAttempts() { calls.stalePreSubmit += 1; return []; },
    async restoreAbandonedClaims() { calls.restore += 1; return []; },
    async expireScheduledRetries() { calls.expire += 1; return []; }
  };
  const walletLane = {
    async recoverStaleSubmissions() { calls.staleWrite += 1; return []; }
  };
  const orchestrator = new TradeRetryOrchestrator({
    db: {},
    intentRepository,
    walletLane,
    maintenanceIntervalMs: 60_000,
    logger: { warn() {}, error() {} }
  });

  await orchestrator.runOnce();
  await orchestrator.runOnce();

  assert.equal(calls.claim, 2);
  assert.equal(calls.staleWrite, 1);
  assert.equal(calls.stalePreSubmit, 1);
  assert.equal(calls.restore, 1);
  assert.equal(calls.expire, 1);
});
