const assert = require('node:assert/strict');
const test = require('node:test');
const { TradeFailureEvidenceService } = require('../domains/trade/trade-failure-evidence-service');

function evidenceDb(options = {}) {
  return {
    async query(sql) {
      if (/AS elapsed/.test(sql)) return { rows: [{ elapsed: true }] };
      if (/COUNT\(\*\).*provider_terminal/s.test(sql)) {
        return { rows: [{ count: options.providerObservations ?? 2 }] };
      }
      return { rows: [] };
    }
  };
}

function baseAttempt() {
  return {
    id: 10,
    intent_id: 20,
    order_id: 30,
    snapshot_version: 1,
    side: 'buy',
    chain: 'base',
    wallet_address: '0x1111111111111111111111111111111111111111',
    input_token: '0x0000000000000000000000000000000000000000',
    output_token: '0x2222222222222222222222222222222222222222',
    input_amount_raw: '1000',
    status: 'confirming',
    config_snapshot_json: { chain_config: { failureEvidenceWindowMs: 5000 } },
    pre_submit_snapshot_json: {
      chain_state: {
        kind: 'evm', latestNonce: 7, pendingNonce: 7, nativeBalanceRaw: '1000000'
      },
      token: { amountRaw: '100', decimals: 18 },
      activity_cursor: []
    }
  };
}

test('P24 pre-submit evidence uses local chain state and never warms GMGN', async () => {
  let providerCalls = 0;
  const service = new TradeFailureEvidenceService({
    gmgnHttp: {
      async getWalletTokenBalance() { providerCalls += 1; throw new Error('must not run'); },
      async getWalletActivity() { providerCalls += 1; throw new Error('must not run'); }
    },
    stateProvider: {
      async capture() {
        return { kind: 'evm', latestNonce: 2, pendingNonce: 2, nativeBalanceRaw: '1000000' };
      }
    }
  });
  const snapshot = await service.capturePreSubmitSnapshot(baseAttempt(), {
    tokenDecimals: 18,
    quote: { outputAmountRaw: '25' },
    gas: null
  });
  assert.equal(providerCalls, 0);
  assert.equal(snapshot.chain_state.latestNonce, 2);
  assert.equal(snapshot.token.amountRaw, null);
  assert.deepEqual(snapshot.activity_cursor, []);
  assert.equal(snapshot.native_usd_price, null);
});

test('no-hash EVM failure remains uncertain when address history is unavailable', async () => {
  let scheduled = 0;
  let uncertain = 0;
  let quarantined = 0;
  const service = new TradeFailureEvidenceService({
    db: evidenceDb(),
    gmgnHttp: {
      async getWalletTokenBalance() { return { balance_raw: '100' }; },
      async getWalletActivity() { return []; }
    },
    stateProvider: {
      async capture() {
        return { kind: 'evm', latestNonce: 7, pendingNonce: 7, nativeBalanceRaw: '1000000' };
      },
      async scan() { return { available: false, transactions: [] }; }
    },
    intentRepository: {
      async scheduleAfterDefinitiveFailure() { scheduled += 1; },
      async markUncertain() { uncertain += 1; }
    },
    walletLane: {
      async quarantine() {
        quarantined += 1;
        return { owner_attempt_id: 10 };
      }
    }
  });
  const result = await service.verifyFailedOrder(baseAttempt(), {
    status: 'failed', providerStatus: 'failed', errorCode: 'ROUTE_FAILED', txHash: null
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reasonCode, 'NO_HASH_FAILURE_NOT_PROVEN');
  assert.equal(scheduled, 0);
  assert.equal(uncertain, 1);
  assert.equal(quarantined, 2);
});

test('no-hash evidence can schedule only after the wallet was isolated and all balances stay stable', async () => {
  let scheduledFailure = null;
  const quarantineReasons = [];
  const service = new TradeFailureEvidenceService({
    db: evidenceDb(),
    gmgnHttp: {
      async getWalletTokenBalance() { return { balance_raw: '100' }; },
      async getWalletActivity() { return []; }
    },
    stateProvider: {
      async capture() {
        return { kind: 'evm', latestNonce: 7, pendingNonce: 7, nativeBalanceRaw: '1000000' };
      },
      async scan() { return { available: true, transactions: [] }; }
    },
    intentRepository: {
      async scheduleAfterDefinitiveFailure(_attemptId, failure) {
        scheduledFailure = failure;
        return { status: 'retry_scheduled', intentId: 20 };
      },
      async markUncertain() { throw new Error('unexpected uncertain state'); }
    },
    walletLane: {
      async quarantine(_attempt, reason) {
        quarantineReasons.push(reason);
        return { owner_attempt_id: 10 };
      }
    }
  });
  const result = await service.verifyFailedOrder(baseAttempt(), {
    status: 'failed', providerStatus: 'failed', errorCode: 'ROUTE_FAILED', txHash: null
  });
  assert.equal(result.status, 'retry_scheduled');
  assert.equal(quarantineReasons[0], 'NO_HASH_FAILURE_EVIDENCE_PENDING');
  assert.equal(scheduledFailure.failureClass, 'NO_HASH_PROVEN_NO_FILL');
});

test('failed receipt with no target token transfer can schedule definitive-failure handling', async () => {
  let scheduledFailure = null;
  let savedReceipt = 0;
  const service = new TradeFailureEvidenceService({
    db: evidenceDb(),
    receiptService: {
      async verify() {
        return {
          status: 'failed',
          confirmations: 2,
          blockRef: '100',
          transfers: [],
          raw: { receipt: { gasUsed: '21000', effectiveGasPrice: '1000000000' } }
        };
      }
    },
    repository: { async saveChainReceipt() { savedReceipt += 1; } },
    intentRepository: {
      async scheduleAfterDefinitiveFailure(_attemptId, failure) {
        scheduledFailure = failure;
        return { status: 'retry_scheduled', intentId: 20 };
      }
    },
    walletLane: { async quarantine() {} }
  });
  const result = await service.verifyFailedOrder(baseAttempt(), {
    status: 'failed',
    providerStatus: 'failed',
    errorCode: 'CHAIN_REVERTED',
    txHash: '0xabc',
    report: { inputAmountRaw: '1000' }
  });
  assert.equal(result.status, 'retry_scheduled');
  assert.equal(savedReceipt, 1);
  assert.equal(scheduledFailure.failureClass, 'CHAIN_RECEIPT_FAILED_NO_FILL');
  assert.equal(scheduledFailure.actualFeeNative, 0.000021);
});
