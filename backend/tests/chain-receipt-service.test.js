const assert = require('node:assert/strict');
const test = require('node:test');
const {
  closedTokenAccountRentRaw,
  gmgnRouterNativeProceeds,
  probeRpc,
  verifyEvm,
  verifySolana
} = require('../domains/trade/chain-receipt-service');

const GMGN_SWAP_TOPIC = '0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a';
const GMGN_LIVE_ETH_SWAP_TOPIC = '0x3145c7c5a7804148dd68148a26f9f6a2ad2816be643e0f456290a8b81b9c5154';

function uint256(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

test('GMGN router event proves exact EVM native proceeds when historical balances are unavailable', () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const router = '0x2222222222222222222222222222222222222222';
  const evidence = gmgnRouterNativeProceeds({
    from: wallet,
    to: router,
    logs: [{
      address: router,
      index: 7,
      topics: [
        GMGN_SWAP_TOPIC,
        `0x${wallet.slice(2).padStart(64, '0')}`,
        `0x${wallet.slice(2).padStart(64, '0')}`
      ],
      data: `0x${uint256(400)}${uint256(975)}`
    }]
  }, wallet, {
    expectedInputAmountRaw: '400',
    expectedOutputAmountRaw: '975'
  });
  assert.equal(evidence.amountRaw, '975');
  assert.equal(evidence.verification.method, 'gmgn_router_swap_event');
  assert.equal(evidence.verification.event_topic, GMGN_SWAP_TOPIC);
  assert.equal(gmgnRouterNativeProceeds({
    from: wallet,
    to: router,
    logs: [{
      address: router,
      topics: [
        GMGN_SWAP_TOPIC,
        `0x${wallet.slice(2).padStart(64, '0')}`,
        `0x${wallet.slice(2).padStart(64, '0')}`
      ],
      data: `0x${uint256(401)}${uint256(975)}`
    }]
  }, wallet, {
    expectedInputAmountRaw: '400',
    expectedOutputAmountRaw: '975'
  }), null);
});

test('GMGN live ETH router event proves proceeds when approve and swap share the block', () => {
  const wallet = '0x2ee060cac1b13d7758bf03298730f3b067dfa898';
  const router = '0x4313c378cc91ea583c91387b9216e2c03096b27f';
  const input = '449765582468526225438846';
  const output = '974845558502501';
  const evidence = gmgnRouterNativeProceeds({
    from: wallet,
    to: router,
    logs: [
      {
        address: router,
        index: 34,
        topics: ['0xddf252ad'],
        data: '0x00'
      },
      {
        address: router,
        index: 41,
        topics: [
          GMGN_LIVE_ETH_SWAP_TOPIC,
          `0x${wallet.slice(2).padStart(64, '0')}`,
          `0x${wallet.slice(2).padStart(64, '0')}`,
          `0x${'0'.padStart(64, '0')}`
        ],
        data: `0x${uint256(input)}${uint256(output)}`
      }
    ]
  }, wallet, {
    expectedInputAmountRaw: input,
    expectedOutputAmountRaw: output
  });
  assert.equal(evidence.amountRaw, output);
  assert.equal(evidence.verification.method, 'gmgn_router_swap_event');
  assert.equal(evidence.verification.event_topic, GMGN_LIVE_ETH_SWAP_TOPIC);
});

function providerWithTransactions(transactions, receipt = { status: 1, blockNumber: 100, logs: [] }) {
  return {
    getNetwork: async () => ({ chainId: 8453n }),
    getTransactionReceipt: async () => receipt,
    getTransaction: async () => ({ from: '0xmanaged' }),
    getBlockNumber: async () => 102,
    getBalance: async (_wallet, block) => block === 99 ? 1000n : 1125n,
    send: async () => ({ transactions })
  };
}

test('EVM receipt verifies GMGN native proceeds despite another wallet transaction in the block', async () => {
  const wallet = '0x2ee060cac1b13d7758bf03298730f3b067dfa898';
  const router = '0x4313c378cc91ea583c91387b9216e2c03096b27f';
  const input = '449765582468526225438846';
  const output = '974845558502501';
  const provider = providerWithTransactions([
    { hash: '0xapprove', from: wallet, to: '0xtoken' },
    { hash: '0xtarget', from: wallet, to: router }
  ], {
    status: 1,
    blockNumber: 100,
    from: wallet,
    to: router,
    logs: [{
      address: router,
      index: 41,
      topics: [
        GMGN_LIVE_ETH_SWAP_TOPIC,
        `0x${wallet.slice(2).padStart(64, '0')}`,
        `0x${wallet.slice(2).padStart(64, '0')}`,
        `0x${'0'.padStart(64, '0')}`
      ],
      data: `0x${uint256(input)}${uint256(output)}`
    }]
  });
  const verified = await verifyEvm('0xtarget', {
    url: 'http://unused', chainId: 8453, confirmations: 2
  }, {
    walletAddress: wallet,
    expectedInputAmountRaw: input,
    expectedOutputAmountRaw: output,
    verifyNativeBalanceDelta: true,
    provider
  });
  assert.equal(verified.status, 'confirmed');
  assert.equal(verified.nativeBalanceDeltaRaw, null);
  assert.equal(verified.nativeProceedsRaw, output);
  assert.equal(verified.raw.nativeProceedsVerification.event_topic, GMGN_LIVE_ETH_SWAP_TOPIC);
});

test('EVM receipt derives native proceeds only from an unambiguous wallet block delta', async () => {
  const verified = await verifyEvm('0xtarget', { url: 'http://unused', chainId: 8453, confirmations: 2 }, {
    walletAddress: '0xmanaged',
    verifyNativeBalanceDelta: true,
    provider: providerWithTransactions([{ hash: '0xtarget', from: '0xmanaged', to: '0xrouter' }])
  });
  assert.equal(verified.status, 'confirmed');
  assert.equal(verified.nativeBalanceDeltaRaw, '125');
  assert.equal(verified.raw.nativeBalanceVerification.unique_top_level_activity, true);

  const ambiguous = await verifyEvm('0xtarget', { url: 'http://unused', chainId: 8453, confirmations: 2 }, {
    walletAddress: '0xmanaged',
    verifyNativeBalanceDelta: true,
    provider: providerWithTransactions([
      { hash: '0xtarget', from: '0xmanaged', to: '0xrouter' },
      { hash: '0xother', from: '0xmanaged', to: '0xelse' }
    ])
  });
  assert.equal(ambiguous.nativeBalanceDeltaRaw, null);

  const wrongNetwork = providerWithTransactions([]);
  wrongNetwork.getNetwork = async () => ({ chainId: 1n });
  const mismatch = await verifyEvm('0xtarget', { url: 'http://unused', chainId: 8453, confirmations: 2 }, {
    walletAddress: '0xmanaged',
    verifyNativeBalanceDelta: true,
    provider: wrongNetwork
  });
  assert.equal(mismatch.reason, 'RPC_CHAIN_MISMATCH');
});

test('RPC probe verifies current chain identity and latest block', async () => {
  const previousBaseRpc = process.env.BASE_RPC_URL;
  process.env.BASE_RPC_URL = 'https://base.invalid';
  try {
    const valid = await probeRpc('base', {
      provider: {
        getNetwork: async () => ({ chainId: 8453n }),
        getBlockNumber: async () => 321
      }
    });
    assert.deepEqual(valid, {
      ok: true,
      chain: 'base',
      identity: '8453',
      blockRef: '321'
    });
    const mismatch = await probeRpc('base', {
      provider: {
        getNetwork: async () => ({ chainId: 1n }),
        getBlockNumber: async () => 321
      }
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error, 'RPC_CHAIN_MISMATCH');
  } finally {
    if (previousBaseRpc === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = previousBaseRpc;
  }
});

test('EVM RPC probe returns the verified wallet native balance when requested', async () => {
  const previousBaseRpc = process.env.BASE_RPC_URL;
  process.env.BASE_RPC_URL = 'https://base.invalid';
  try {
    const result = await probeRpc('base', {
      walletAddress: '0x1111111111111111111111111111111111111111',
      provider: {
        getNetwork: async () => ({ chainId: 8453n }),
        getBlockNumber: async () => 321,
        getBalance: async () => 150000000000000000n
      }
    });
    assert.equal(result.nativeBalanceRaw, '150000000000000000');
    assert.equal(result.nativeBalance, 0.15);
  } finally {
    if (previousBaseRpc === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = previousBaseRpc;
  }
});

test('Solana RPC probe accepts only the mainnet genesis hash', async () => {
  const previousRpc = process.env.SOLANA_RPC_URL;
  process.env.SOLANA_RPC_URL = 'https://solana.invalid';
  try {
    const valid = await probeRpc('sol', {
      connection: {
        getGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getSlot: async () => 123456
      }
    });
    assert.equal(valid.ok, true);
    assert.equal(valid.blockRef, '123456');
    const mismatch = await probeRpc('sol', {
      connection: {
        getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        getSlot: async () => 1
      }
    });
    assert.equal(mismatch.error, 'RPC_CHAIN_MISMATCH');
  } finally {
    if (previousRpc === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = previousRpc;
  }
});

test('Solana receipt separates closed token account rent from sell proceeds', async () => {
  const transfers = {
    preTokenBalances: [{ accountIndex: 1, owner: 'wallet', mint: 'token' }],
    postTokenBalances: [],
    preBalances: [1000, 2039280],
    postBalances: [6791766, 0]
  };
  assert.equal(closedTokenAccountRentRaw(transfers, 'wallet', 'token'), '2039280');
  const receipt = await verifySolana('tx', { url: 'http://unused', confirmations: 1 }, {
    walletAddress: 'wallet',
    tradedToken: 'token',
    connection: {
      getTransaction: async () => ({
        slot: 10,
        transaction: { message: { accountKeys: ['wallet', 'token-account'] } },
        meta: { err: null, ...transfers }
      }),
      getSlot: async () => 10
    }
  });
  assert.equal(receipt.nativeBalanceDeltaRaw, '6790766');
  assert.equal(receipt.closedTokenAccountRentRaw, '2039280');
});
