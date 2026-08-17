const assert = require('node:assert/strict');
const test = require('node:test');
const { ExternalCloseService } = require('../domains/trade/external-close-service');

function position(overrides = {}) {
  return {
    id: 42,
    execution_mode: 'live',
    chain_id: 'bsc',
    contract_address: '0xToken',
    signal_id: 7,
    whitelist_id: 8,
    signal_trace_id: 'trace-1',
    lots: [{ wallet_address: '0xWallet', token_decimals: 18 }],
    ...overrides
  };
}

function service(overrides = {}) {
  const calls = [];
  const dependencies = {
    repository: {
      getPositionForClose: async () => position(),
      markPositionBalanceMismatch: async (...args) => calls.push(['mismatch', ...args]),
      releaseExternalCloseVerification: async (...args) => {
        calls.push(['release', ...args]);
        return { id: args[0] };
      }
    },
    closeService: {
      loadStrategyState: async () => [],
      cancelStrategies: async (...args) => calls.push(['cancel', ...args])
    },
    reconciler: {
      reconcilePositionBalance: async () => ({ positionId: 42, status: 'matched' }),
      reconcileStrategy: async () => ({ strategyGroupId: 5, status: 'chain_verifying', orderId: 9 })
    },
    chainResolver: (chain) => ({ id: chain }),
    ...overrides
  };
  return { instance: new ExternalCloseService(dependencies), calls, dependencies };
}

test('wallet synchronization leaves a fully held position unchanged', async () => {
  const { instance, calls } = service();
  const result = await instance.sync(42, 'tester');
  assert.equal(result.status, 'matched');
  assert.deepEqual(calls, []);
});

test('wallet synchronization attributes a triggered protection order before external activity', async () => {
  let balanceOptions;
  let reconciledStrategy;
  const triggered = {
    group: { id: 5, provider_order_id: 'strategy-5' },
    normalized: { status: 'triggered', closeTxHash: 'strategy-tx' },
    status: 'triggered'
  };
  const { instance } = service({
    closeService: {
      loadStrategyState: async () => [triggered],
      cancelStrategies: async () => assert.fail('triggered strategy must not be cancelled')
    },
    reconciler: {
      reconcilePositionBalance: async (_row, options) => {
        balanceOptions = options;
        const resolution = await options.resolveActiveStrategies({});
        return { positionId: 42, ...resolution.result };
      },
      reconcileStrategy: async (row, options) => {
        reconciledStrategy = { row, options };
        return { strategyGroupId: 5, status: 'chain_verifying', orderId: 9 };
      }
    }
  });
  const result = await instance.sync(42, 'tester');
  assert.equal(balanceOptions.operatorId, 'tester');
  assert.equal(result.status, 'protection_close_detected');
  assert.equal(reconciledStrategy.row.wallet_address, '0xWallet');
  assert.equal(reconciledStrategy.options.strategy, triggered.normalized);
});

test('wallet synchronization cancels a live protection strategy after claiming external sell evidence', async () => {
  const running = {
    group: { id: 6, provider_order_id: 'strategy-6' },
    normalized: { status: 'running' },
    status: 'running'
  };
  let balanceOptions;
  const { instance, calls } = service({
    closeService: {
      loadStrategyState: async () => [running],
      cancelStrategies: async (...args) => calls.push(['cancel', ...args])
    },
    reconciler: {
      reconcilePositionBalance: async (_row, options) => {
        balanceOptions = options;
        await options.resolveActiveStrategies({});
        return {
          positionId: 42,
          status: 'chain_verifying',
          attemptId: 77,
          orderId: 91,
          verificationHeld: true
        };
      },
      reconcileStrategy: async () => assert.fail('running strategy must not be claimed as triggered')
    }
  });
  const result = await instance.sync(42, 'tester');
  assert.equal(balanceOptions.operatorId, 'tester');
  assert.equal(balanceOptions.holdExternalVerification, true);
  assert.equal(result.strategyAction, 'cancelled');
  assert.equal(result.cancelledStrategyCount, 1);
  assert.equal(calls[0][0], 'cancel');
  assert.equal(calls[0][2].attemptId, 77);
  assert.deepEqual(calls[1], ['release', 91]);
});

test('wallet synchronization records an uncertain strategy cancellation for manual review', async () => {
  const error = Object.assign(new Error('cancel uncertain'), { code: 'STRATEGY_CANCEL_UNCERTAIN' });
  const running = {
    group: { id: 6, provider_order_id: 'strategy-6' },
    normalized: { status: 'running' },
    status: 'running'
  };
  const { instance, calls } = service({
    closeService: {
      loadStrategyState: async () => [running],
      cancelStrategies: async () => { throw error; }
    },
    reconciler: {
      reconcilePositionBalance: async (_row, options) => {
        await options.resolveActiveStrategies({});
        return {
          positionId: 42,
          status: 'chain_verifying',
          attemptId: 77,
          orderId: 91,
          verificationHeld: true
        };
      },
      reconcileStrategy: async () => null
    }
  });
  await assert.rejects(instance.sync(42, 'tester'), (caught) => caught === error);
  assert.equal(calls[0][0], 'mismatch');
  assert.equal(calls[0][2].reason, 'EXTERNAL_CLOSE_STRATEGY_CANCEL_UNCERTAIN');
  assert.equal(calls.some((call) => call[0] === 'release'), false);
});
