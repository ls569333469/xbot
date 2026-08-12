const assert = require('node:assert/strict');
const test = require('node:test');
const {
  groupStrategyRows,
  TradeReconciler,
  pollingIntervalMs,
  receiptContainsTradedToken,
  receiptHasVerifiableNativeProceeds,
  receiptMatchesTradedAmount,
  receiptTradedAmountRaw,
  strategyBatchGroupBudget,
  strategyPollingIntervalMs,
  strategyMatchesConfirmedOrder
} = require('../domains/trade/reconciliation-service');

test('strategy synchronization batches one open/history query per chain and wallet', async () => {
  const calls = [];
  const reconciler = new TradeReconciler({
    gmgnHttp: {
      getStrategyOrders: async (chain, filters, request) => {
        calls.push({ chain, filters, request });
        return filters.type === 'open'
          ? { list: [{ order_id: 'strategy-open', status: 'open', strategy_status: 'running' }] }
          : { list: [{ order_id: 'strategy-history', status: 'closed', strategy_status: 'stopped' }] };
      }
    }
  });
  const rows = [
    { id: 1, chain_id: 'robinhood', wallet_address: '0xWallet', provider_order_id: 'strategy-open' },
    { id: 2, chain_id: 'robinhood', wallet_address: '0xWallet', provider_order_id: 'strategy-history' }
  ];
  const found = await reconciler.fetchStrategyBatch(rows);
  assert.equal(found.size, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.filters.type), ['open', 'history']);
  assert.equal(calls.every((call) => call.filters.base_token === undefined), true);
  assert.equal(calls.every((call) => (
    call.request.requestContext.context.category === 'protection_strategy_sync'
  )), true);
  assert.equal(groupStrategyRows([...rows, {
    ...rows[0], id: 3, wallet_address: '0xOther'
  }]).length, 2);
  assert.equal(strategyBatchGroupBudget('99'), 4);
  assert.equal(strategyBatchGroupBudget('invalid'), 1);
});
const {
  sellSettlementOutputRaw,
  submittedOrderStatus
} = require('../domains/trade/trade-repository');

test('an immediate provider failure remains in the reconciliation queue', () => {
  assert.equal(submittedOrderStatus('failed'), 'failure_verifying');
  assert.equal(submittedOrderStatus('expired'), 'failure_verifying');
  assert.equal(submittedOrderStatus('confirmed'), 'chain_verifying');
  assert.equal(submittedOrderStatus('pending'), 'pending');
});

test('order reconciliation exits when another worker owns the order claim', async () => {
  let queried = false;
  const reconciler = new TradeReconciler({
    repository: {
      claimOrderReconciliation: async () => null
    },
    gmgnHttp: {
      queryOrder: async () => { queried = true; }
    }
  });
  const result = await reconciler.reconcileOrder({ id: 91 });
  assert.deepEqual(result, { orderId: 91, status: 'reconciliation_claimed_elsewhere' });
  assert.equal(queried, false);
});

test('order reconciliation uses adaptive 1s, 2s, 5s, and 15-30s polling', () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    assert.equal(pollingIntervalMs(new Date(995_000), 'pending', () => 0), 1000);
    assert.equal(pollingIntervalMs(new Date(980_000), 'pending', () => 0), 2000);
    assert.equal(pollingIntervalMs(new Date(940_000), 'pending', () => 0), 5000);
    assert.equal(pollingIntervalMs(new Date(800_000), 'pending', () => 0), 15000);
    assert.equal(pollingIntervalMs(new Date(800_000), 'pending', () => 1), 30000);
    assert.equal(pollingIntervalMs(new Date(800_000), 'triggered', () => 1), 1000);
    assert.equal(pollingIntervalMs(new Date(999_000), 'definitive_failed_no_fill', () => 0), 900000);
    assert.equal(pollingIntervalMs(new Date(999_000), 'definitive_failed_no_fill', () => 1), 1800000);
  } finally {
    Date.now = originalNow;
  }
});

test('receipt validation requires the target token transfer before confirmation', () => {
  const solOrder = { chain: 'sol', side: 'buy', output_token: 'TokenMint', input_token: 'native' };
  assert.equal(receiptContainsTradedToken(solOrder, {
    transfers: { preTokenBalances: [], postTokenBalances: [{ mint: 'TokenMint' }] }
  }), true);
  assert.equal(receiptContainsTradedToken(solOrder, {
    transfers: { preTokenBalances: [], postTokenBalances: [] }
  }), false);
  const evmOrder = { chain: 'base', side: 'sell', input_token: '0x0000000000000000000000000000000000000001', output_token: 'native' };
  assert.equal(receiptContainsTradedToken(evmOrder, {
    transfers: [{ address: '0x0000000000000000000000000000000000000001' }]
  }), true);
});

test('receipt validation matches exact managed-wallet token deltas', () => {
  const solOrder = {
    chain: 'sol',
    side: 'sell',
    wallet_address: 'ManagedWallet',
    input_token: 'TokenMint',
    output_token: 'native',
    input_amount_raw: '400'
  };
  const solReceipt = {
    transfers: {
      preTokenBalances: [{ mint: 'TokenMint', owner: 'ManagedWallet', uiTokenAmount: { amount: '1000' } }],
      postTokenBalances: [{ mint: 'TokenMint', owner: 'ManagedWallet', uiTokenAmount: { amount: '600' } }]
    }
  };
  assert.equal(receiptTradedAmountRaw(solOrder, solReceipt), '400');
  assert.equal(receiptMatchesTradedAmount(solOrder, {
    report: { inputAmountRaw: '400' }
  }, solReceipt), true);

  const wallet = '1111111111111111111111111111111111111111';
  const evmOrder = {
    chain: 'base',
    side: 'buy',
    wallet_address: `0x${wallet}`,
    input_token: 'native',
    output_token: '0x0000000000000000000000000000000000000001',
    output_amount_raw: '25'
  };
  const evmReceipt = {
    transfers: [{
      address: evmOrder.output_token,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        `0x${'0'.repeat(64)}`,
        `0x${'0'.repeat(24)}${wallet}`
      ],
      data: '0x19'
    }]
  };
  assert.equal(receiptTradedAmountRaw(evmOrder, evmReceipt), '25');
  assert.equal(receiptMatchesTradedAmount(evmOrder, {
    report: { outputAmountRaw: '25' }
  }, evmReceipt), true);

  const oneUnitRoundingSurplus = {
    transfers: [{ ...evmReceipt.transfers[0], data: '0x1a' }]
  };
  assert.equal(receiptTradedAmountRaw(evmOrder, oneUnitRoundingSurplus), '26');
  assert.equal(receiptMatchesTradedAmount(evmOrder, {
    report: { outputAmountRaw: '25' }
  }, oneUnitRoundingSurplus), true);

  const oneUnitShortfall = {
    transfers: [{ ...evmReceipt.transfers[0], data: '0x18' }]
  };
  assert.equal(receiptMatchesTradedAmount(evmOrder, {
    report: { outputAmountRaw: '25' }
  }, oneUnitShortfall), false);

  assert.equal(receiptMatchesTradedAmount({ ...evmOrder, chain: 'robinhood' }, {
    report: { outputAmountRaw: '25' }
  }, oneUnitShortfall), true);

  const twoUnitShortfall = {
    transfers: [{ ...evmReceipt.transfers[0], data: '0x17' }]
  };
  assert.equal(receiptMatchesTradedAmount({ ...evmOrder, chain: 'robinhood' }, {
    report: { outputAmountRaw: '25' }
  }, twoUnitShortfall), false);
});

test('buy settlement records the managed-wallet receipt amount as authoritative', () => {
  const { orderWithReceiptTradedAmount } = require('../domains/trade/reconciliation-service');
  const wallet = '1111111111111111111111111111111111111111';
  const token = '2222222222222222222222222222222222222222';
  const row = {
    chain: 'robinhood',
    side: 'buy',
    wallet_address: `0x${wallet}`,
    output_token: `0x${token}`,
    output_amount_raw: '25'
  };
  const receipt = {
    transfers: [{
      address: `0x${token}`,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        `0x${'0'.repeat(64)}`,
        `0x${'0'.repeat(24)}${wallet}`
      ],
      data: '0x18'
    }]
  };
  const settled = orderWithReceiptTradedAmount(row, {
    report: { outputAmountRaw: '25' },
    raw: { status: 'confirmed' }
  }, receipt);
  assert.equal(settled.report.outputAmountRaw, '24');
  assert.deepEqual(settled.raw.xbot_receipt_settlement, {
    source: 'managed_wallet_token_transfer',
    provider_output_amount_raw: '25',
    receipt_output_amount_raw: '24'
  });
});

test('sell receipt validation still requires the exact managed-wallet token amount', () => {
  const wallet = '1111111111111111111111111111111111111111';
  const evmOrder = {
    chain: 'base',
    side: 'sell',
    wallet_address: `0x${wallet}`,
    input_token: '0x0000000000000000000000000000000000000001',
    output_token: '0x0000000000000000000000000000000000000000',
    input_amount_raw: '25'
  };
  const transfer = (amount) => ({
    transfers: [{
      address: evmOrder.input_token,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        `0x${'0'.repeat(24)}${wallet}`,
        `0x${'0'.repeat(24)}${'2'.repeat(40)}`
      ],
      data: `0x${amount.toString(16)}`
    }]
  });
  assert.equal(receiptMatchesTradedAmount(evmOrder, {
    report: { inputAmountRaw: '25' }
  }, transfer(25)), true);
  assert.equal(receiptMatchesTradedAmount(evmOrder, {
    report: { inputAmountRaw: '25' }
  }, transfer(26)), false);
});

test('native sell proceeds fail closed when an EVM receipt cannot prove the wallet delta', () => {
  const evmSell = {
    chain: 'base',
    side: 'sell',
    input_token: '0x0000000000000000000000000000000000000001',
    output_token: '0x0000000000000000000000000000000000000000'
  };
  assert.equal(receiptHasVerifiableNativeProceeds(evmSell, {
    nativeBalanceDeltaRaw: null
  }), false);
  assert.equal(receiptHasVerifiableNativeProceeds(evmSell, {
    nativeBalanceDeltaRaw: '5000000000000000'
  }), true);
  assert.equal(receiptHasVerifiableNativeProceeds(evmSell, {
    nativeBalanceDeltaRaw: null,
    nativeProceedsRaw: '5000000000000000'
  }), true);

  const solSell = {
    chain: 'sol',
    side: 'sell',
    input_token: 'TokenMint',
    output_token: 'So11111111111111111111111111111111111111112'
  };
  assert.equal(receiptHasVerifiableNativeProceeds(solSell, {
    nativeBalanceDeltaRaw: '97582155'
  }), true);
});

test('Solana sell settlement excludes closed token-account rent from wallet delta', () => {
  assert.equal(sellSettlementOutputRaw('sol', {
    nativeBalanceDeltaRaw: '6790766',
    closedTokenAccountRentRaw: '2039280'
  }, '4814642', null), '4751486');
  assert.equal(sellSettlementOutputRaw('base', {
    nativeBalanceDeltaRaw: '4751486'
  }, '4814642', null), '4751486');
  assert.equal(sellSettlementOutputRaw('base', {
    nativeBalanceDeltaRaw: null,
    nativeProceedsRaw: '4814642'
  }, '4814642', null), '4814642');
  assert.equal(sellSettlementOutputRaw('sol', {
    nativeBalanceDeltaRaw: null,
    closedTokenAccountRentRaw: '0'
  }, '4814642', null), '4814642');
});

test('EVM replacement is accepted only from a refreshed GMGN order hash', async () => {
  const calls = [];
  const reconciler = new TradeReconciler({
    gmgnHttp: {
      queryOrder: async () => ({
        order_id: 'gmgn-order-1',
        status: 'success',
        tx_hash: '0xnew',
        report: { input_amount: '10', output_amount: '25' }
      })
    },
    receiptService: {
      verify: async () => ({
        status: 'dropped', confirmations: 0, blockRef: null, transfers: [], raw: {}
      })
    },
    repository: {
      saveChainReceipt: async (_id, _chain, hash, receipt) => {
        calls.push(['receipt', hash, receipt.status]);
      },
      updateOrderAfterQuery: async (_id, order) => {
        calls.push(['order', order.txHash, order.status]);
      }
    },
    logger: { error() {}, warn() {} }
  });
  const result = await reconciler.reconcileOrder({
    id: 8,
    attempt_id: 3,
    chain: 'base',
    side: 'buy',
    provider_order_id: 'gmgn-order-1',
    normalized_status: 'chain_verifying',
    tx_hash: '0xold',
    input_amount_raw: '10',
    output_amount_raw: '25',
    report_json: { input_amount: '10', output_amount: '25' },
    last_response_json: {},
    attempt_metadata: {}
  });
  assert.equal(result.status, 'chain_replaced');
  assert.deepEqual(calls, [
    ['receipt', '0xold', 'dropped'],
    ['receipt', '0xold', 'replaced'],
    ['order', '0xnew', 'chain_verifying']
  ]);
});

test('strategy reconciliation prioritizes triggered states and claims a close once', async () => {
  assert.equal(strategyPollingIntervalMs('triggered', () => 1), 1000);
  assert.equal(strategyPollingIntervalMs('unknown', () => 1), 60000);
  assert.equal(strategyPollingIntervalMs('running', () => 0), 300000);
  assert.equal(strategyPollingIntervalMs('running', () => 1), 600000);

  const calls = [];
  const reconciler = new TradeReconciler({
    gmgnHttp: {
      getStrategyOrders: async (_chain, query) => ({
        list: query.type === 'open' ? [] : [{
          order_id: 'strategy-1',
          status: 'closed',
          strategy_status: 'stopped',
          close_amount: '500',
          close_sign_hash: 'close-hash',
          close_time: 1_750_000_000_000,
          condition_orders: [{ cid: 'leg-1', status: 'success', sell_ratio: '100' }]
        }]
      })
    },
    repository: {
      persistStrategySnapshot: async (id, strategy) => calls.push(['persist', id, strategy.status]),
      claimStrategyClose: async (id, strategy) => {
        calls.push(['claim', id, strategy.closeTxHash]);
        return { orderId: 88, existing: false };
      }
    },
    logger: { error() {}, warn() {} },
    random: () => 0
  });
  const result = await reconciler.reconcileStrategy({
    id: 7,
    chain_id: 'sol',
    provider_order_id: 'strategy-1',
    wallet_address: 'wallet',
    contract_address: 'token',
    status: 'running'
  });
  assert.deepEqual(calls, [
    ['persist', 7, 'triggered'],
    ['claim', 7, 'close-hash']
  ]);
  assert.equal(result.orderId, 88);
});

test('missing swap strategy id is recovered only from one exact strategy match', async () => {
  const submittedAt = new Date('2026-07-22T00:00:00.000Z');
  const row = {
    chain: 'sol',
    wallet_address: 'ManagedWallet',
    input_amount_raw: '100000000',
    output_amount_raw: '4132773117',
    output_token: 'CupseyMint',
    submitted_at: submittedAt,
    attempt_metadata: { condition_orders: [{ order_type: 'profit_stop' }] }
  };
  const exact = {
    order_id: 'strategy-1',
    wallet_address: 'ManagedWallet',
    base_token: 'CupseyMint',
    open_amount: '4132773117',
    quote_investment: '100000000',
    create_time: submittedAt.getTime() + 1000,
    status: 'open',
    strategy_status: 'running'
  };
  const wrongAmount = { ...exact, order_id: 'strategy-2', open_amount: '1' };
  let strategyQueries = 0;
  const reconciler = new TradeReconciler({
    gmgnHttp: {
      getStrategyOrders: async (_chain, filters) => {
        strategyQueries += 1;
        return { list: filters.type === 'open' ? [exact, wrongAmount] : [exact] };
      }
    }
  });
  const normalizedOrder = {
    status: 'confirmed',
    strategyOrderId: null,
    report: { inputAmountRaw: '100000000', outputAmountRaw: '4132773117' },
    raw: {}
  };
  assert.equal(
    strategyMatchesConfirmedOrder(row, normalizedOrder, require('../lib/gmgn-adapter').normalizeStrategy(exact)),
    true
  );
  const resolved = await reconciler.resolveProtectionStrategy(row, normalizedOrder);
  assert.equal(resolved.strategyOrderId, 'strategy-1');
  assert.equal(resolved.raw.xbot_strategy_association.status, 'matched');
  assert.equal(strategyQueries, 1);
});

test('position balance reconciliation records surplus without selling external holdings', async () => {
  const calls = [];
  const reconciler = new TradeReconciler({
    gmgnHttp: {
      getWalletTokenBalance: async () => ({ balances: [{ balance: '125', decimal: 6 }] })
    },
    repository: {
      getPositionBalanceState: async () => ({
        position_id: 9,
        chain_id: 'sol',
        contract_address: 'TokenMint',
        wallet_address: 'Wallet',
        token_decimals: 6,
        remaining_amount_raw: '100000000',
        active_strategy_count: 0
      }),
      observePositionBalance: async (_id, actualRaw) => {
        calls.push(actualRaw);
        return { deficitRaw: '0', externalRaw: '25000000' };
      }
    },
    logger: { error() {}, warn() {} }
  });
  const result = await reconciler.reconcilePositionBalance({ id: 9 });
  assert.deepEqual(calls, ['125000000']);
  assert.equal(result.status, 'external_balance_present');
});

test('position balance reconciliation uses verified decimals when GMGN reports zero for a fractional balance', async () => {
  const calls = [];
  const reconciler = new TradeReconciler({
    gmgnHttp: {
      getWalletTokenBalance: async () => ({
        balances: [{ balance: '19.16844', decimal: 0 }]
      })
    },
    repository: {
      getPositionBalanceState: async () => ({
        position_id: 11,
        chain_id: 'sol',
        contract_address: 'TokenMint',
        wallet_address: 'Wallet',
        token_decimals: 6,
        remaining_amount_raw: '19168440',
        active_strategy_count: 1
      }),
      observePositionBalance: async (_id, actualRaw) => {
        calls.push(actualRaw);
        return { deficitRaw: '0', externalRaw: '0' };
      }
    },
    logger: { error() {}, warn() {} }
  });
  const result = await reconciler.reconcilePositionBalance({ id: 11 });
  assert.deepEqual(calls, ['19168440']);
  assert.equal(result.status, 'matched');
});

test('position balance deficit with an active strategy fails to manual review', async () => {
  const alerts = [];
  const reconciler = new TradeReconciler({
    gmgnHttp: {
      getWalletTokenBalance: async () => ({ balances: [{ balance: '75', decimal: 6 }] })
    },
    repository: {
      getPositionBalanceState: async () => ({
        position_id: 10,
        chain_id: 'sol',
        contract_address: 'TokenMint',
        wallet_address: 'Wallet',
        token_decimals: 6,
        remaining_amount_raw: '100000000',
        active_strategy_count: 1
      }),
      observePositionBalance: async () => ({ deficitRaw: '25000000', externalRaw: '0' }),
      markPositionBalanceMismatch: async (_id, details) => alerts.push(details)
    },
    logger: { error() {}, warn() {} }
  });
  const result = await reconciler.reconcilePositionBalance({ id: 10 });
  assert.equal(result.status, 'active_strategy_conflict');
  assert.equal(alerts[0].reason, 'ACTIVE_STRATEGY_BALANCE_DEFICIT');
});

test('cancelled strategy uncertainty recovers only when balance proves no sell occurred', async () => {
  const calls = [];
  const reconciler = new TradeReconciler({
    gmgnHttp: {
      queryStrategyOrder: async () => ({
        list: [{
          order_id: 'strategy-1',
          status: 'canceled',
          strategy_status: 'canceled',
          close_sign_hash: '',
          base_decimal: 6
        }]
      }),
      getWalletTokenBalance: async () => ({
        balances: [{ balance: '19.16844', decimal: 0 }]
      })
    },
    repository: {
      getAttemptDetails: async () => ({
        orders: [],
        events: [{
          to_status: 'submission_uncertain',
          reason: 'GMGN strategy cancellation was not explicitly confirmed'
        }],
        strategy_groups: [{ id: 29, provider_order_id: 'strategy-1' }],
        position_lots: [{
          remaining_amount_raw: '19168440',
          token_decimals: 6,
          wallet_address: 'wallet'
        }]
      }),
      resolveCancelledCloseAttempt: async (attemptId, positionId, evidence) => {
        calls.push({ attemptId, positionId, evidence });
        return { attemptId, positionId, status: 'open_unprotected' };
      }
    },
    logger: { error() {}, warn() {} }
  });
  const result = await reconciler.reconcileCancelledCloseAttempt({
    id: 106,
    position_id: 42,
    side: 'sell',
    status: 'reconciliation_required',
    error_code: 'SUBMISSION_COULD_NOT_BE_UNIQUELY_RECONCILED',
    chain: 'sol',
    input_token: 'token'
  });
  assert.equal(result.status, 'cancelled_before_swap_recovered');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].evidence[0].normalized.status, 'cancelled');
});

test('deterministic pre-submit rate failure recovers without querying GMGN', async () => {
  const calls = [];
  const reconciler = new TradeReconciler({
    gmgnHttp: {
      queryStrategyOrder: async () => {
        throw new Error('must not query provider for a local pre-submit failure');
      },
      getWalletTokenBalance: async () => {
        throw new Error('must not query provider for a local pre-submit failure');
      }
    },
    repository: {
      getAttemptDetails: async () => ({
        orders: [],
        events: [{ reason: 'GMGN rate reservation is invalid or exhausted' }],
        strategy_groups: [],
        position_lots: []
      }),
      recoverDeterministicPreSubmitSellAttempt: async (attemptId, positionId, reason) => {
        calls.push({ attemptId, positionId, reason });
        return { attemptId, positionId, status: 'open_unprotected' };
      }
    },
    logger: { error() {}, warn() {} }
  });
  const result = await reconciler.reconcileCancelledCloseAttempt({
    id: 138,
    position_id: 573,
    side: 'sell',
    status: 'reconciliation_required',
    error_code: 'SUBMISSION_COULD_NOT_BE_UNIQUELY_RECONCILED'
  });
  assert.equal(result.status, 'pre_submit_failure_recovered');
  assert.deepEqual(calls, [{
    attemptId: 138,
    positionId: 573,
    reason: 'GMGN_RATE_RESERVATION_INVALID'
  }]);
});
