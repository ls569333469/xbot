const { Connection, PublicKey } = require('@solana/web3.js');
const { formatUnits, JsonRpcProvider } = require('ethers');
const { requireChain, rpcConfig } = require('./chain-adapters');

const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const GMGN_ROUTER_SWAP_EVENT_TOPICS = new Set([
  // Legacy GMGN router event.
  '0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a',
  // Current EVM router event emitted by the live ETH sell path.
  '0x3145c7c5a7804148dd68148a26f9f6a2ad2816be643e0f456290a8b81b9c5154'
]);
const EVM_WRAPPED_NATIVE_WITHDRAWAL_TOPIC =
  '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const WRAPPED_NATIVE_TOKENS_BY_CHAIN_ID = Object.freeze({
  1: new Set(['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']),
  56: new Set(['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c']),
  8453: new Set(['0x4200000000000000000000000000000000000006'])
});

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  )));
}

function closedTokenAccountRentRaw(transfers, walletAddress, tradedToken) {
  const wallet = String(walletAddress || '');
  const token = String(tradedToken || '');
  const preTokenBalances = Array.isArray(transfers?.preTokenBalances)
    ? transfers.preTokenBalances
    : [];
  const postTokenIndexes = new Set(
    (Array.isArray(transfers?.postTokenBalances) ? transfers.postTokenBalances : [])
      .map((balance) => Number(balance.accountIndex))
      .filter(Number.isInteger)
  );
  const preBalances = Array.isArray(transfers?.preBalances) ? transfers.preBalances : [];
  const postBalances = Array.isArray(transfers?.postBalances) ? transfers.postBalances : [];
  return preTokenBalances.reduce((total, balance) => {
    const accountIndex = Number(balance.accountIndex);
    if (!Number.isInteger(accountIndex)
        || postTokenIndexes.has(accountIndex)
        || String(balance.owner || '') !== wallet
        || (token && String(balance.mint || '') !== token)) return total;
    const before = Number(preBalances[accountIndex]);
    const after = Number(postBalances[accountIndex]);
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || before <= after) return total;
    return total + BigInt(before - after);
  }, 0n).toString();
}

function topicAddress(topic) {
  const value = String(topic || '').toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(value) ? `0x${value.slice(-40)}` : null;
}

function wrappedNativeWithdrawalProceeds(receipt, walletAddress, dependencies = {}) {
  const wallet = String(walletAddress || '').toLowerCase();
  const router = String(receipt?.to || '').toLowerCase();
  const sender = String(receipt?.from || '').toLowerCase();
  const chainId = Number(dependencies.chainId);
  const wrappedTokens = WRAPPED_NATIVE_TOKENS_BY_CHAIN_ID[chainId];
  const expectedOutput = String(dependencies.expectedOutputAmountRaw || '');
  const allowProviderOutputMismatch = dependencies.allowProviderOutputMismatch === true;
  if (!wallet || sender !== wallet || !router || !wrappedTokens
      || (!allowProviderOutputMismatch && !/^\d+$/.test(expectedOutput))) return null;

  for (const log of receipt.logs || []) {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    const wrappedToken = String(log.address || '').toLowerCase();
    if (!wrappedTokens.has(wrappedToken)
        || String(topics[0] || '').toLowerCase() !== EVM_WRAPPED_NATIVE_WITHDRAWAL_TOPIC
        || topicAddress(topics[1]) !== router) continue;
    const data = String(log.data || '').replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/i.test(data)) continue;
    const amountRaw = BigInt(`0x${data}`).toString();
    if (BigInt(amountRaw) <= 0n
        || (!allowProviderOutputMismatch && amountRaw !== expectedOutput)) continue;
    return {
      amountRaw,
      verification: {
        method: 'wrapped_native_withdrawal',
        chain_id: chainId,
        wrapped_token: wrappedToken,
        event_topic: EVM_WRAPPED_NATIVE_WITHDRAWAL_TOPIC,
        log_index: Number(log.index ?? -1),
        withdrawal_source: router,
        recipient: wallet,
        provider_output_amount_raw: /^\d+$/.test(expectedOutput) ? expectedOutput : null,
        provider_output_matched: amountRaw === expectedOutput
      }
    };
  }
  return null;
}

function gmgnRouterNativeProceeds(receipt, walletAddress, dependencies = {}) {
  const wallet = String(walletAddress || '').toLowerCase();
  const router = String(receipt?.to || '').toLowerCase();
  const sender = String(receipt?.from || '').toLowerCase();
  const expectedInput = String(dependencies.expectedInputAmountRaw || '');
  const expectedOutput = String(dependencies.expectedOutputAmountRaw || '');
  const allowProviderOutputMismatch = dependencies.allowProviderOutputMismatch === true;
  if (!wallet || sender !== wallet || !router
      || !/^\d+$/.test(expectedInput)
      || (!allowProviderOutputMismatch && !/^\d+$/.test(expectedOutput))) return null;

  for (const log of receipt.logs || []) {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (String(log.address || '').toLowerCase() !== router
        || !GMGN_ROUTER_SWAP_EVENT_TOPICS.has(String(topics[0] || '').toLowerCase())
        || topicAddress(topics[1]) !== wallet
        || topicAddress(topics[2]) !== wallet) continue;
    const data = String(log.data || '').replace(/^0x/, '');
    if (!/^[0-9a-f]+$/i.test(data) || data.length < 128) continue;
    const inputRaw = BigInt(`0x${data.slice(0, 64)}`).toString();
    const outputRaw = BigInt(`0x${data.slice(64, 128)}`).toString();
    if (inputRaw !== expectedInput
        || (!allowProviderOutputMismatch && outputRaw !== expectedOutput)
        || BigInt(outputRaw) <= 0n) continue;
    return {
      amountRaw: outputRaw,
      verification: {
        method: 'gmgn_router_swap_event',
        router,
        log_index: Number(log.index ?? -1),
        event_topic: String(topics[0]).toLowerCase(),
        input_amount_raw: inputRaw,
        output_amount_raw: outputRaw,
        provider_output_amount_raw: /^\d+$/.test(expectedOutput) ? expectedOutput : null,
        provider_output_matched: outputRaw === expectedOutput,
        recipient: wallet
      }
    };
  }
  return null;
}

async function verifySolana(txHash, config, dependencies = {}) {
  const connection = dependencies.connection || new Connection(config.url, 'confirmed');
  const transaction = await connection.getTransaction(txHash, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0
  });
  if (!transaction) {
    return { status: 'pending', confirmations: 0, blockRef: null, transfers: [], raw: {} };
  }
  const currentSlot = await connection.getSlot('confirmed');
  const confirmations = Math.max(1, currentSlot - transaction.slot + 1);
  const accountKeys = (transaction.transaction?.message?.accountKeys
    || transaction.transaction?.message?.staticAccountKeys || [])
    .map((key) => key?.pubkey?.toBase58?.() || key?.toBase58?.() || String(key));
  const walletIndex = dependencies.walletAddress
    ? accountKeys.findIndex((key) => key === dependencies.walletAddress)
    : -1;
  const preNative = walletIndex >= 0 ? transaction.meta?.preBalances?.[walletIndex] : null;
  const postNative = walletIndex >= 0 ? transaction.meta?.postBalances?.[walletIndex] : null;
  const nativeBalanceDeltaRaw = Number.isSafeInteger(preNative) && Number.isSafeInteger(postNative)
    ? (BigInt(postNative) - BigInt(preNative)).toString()
    : null;
  const transfers = {
    accountKeys,
    preTokenBalances: transaction.meta?.preTokenBalances || [],
    postTokenBalances: transaction.meta?.postTokenBalances || [],
    preBalances: transaction.meta?.preBalances || [],
    postBalances: transaction.meta?.postBalances || []
  };
  const tokenAccountRentRaw = closedTokenAccountRentRaw(
    transfers,
    dependencies.walletAddress,
    dependencies.tradedToken
  );
  return {
    status: transaction.meta?.err ? 'failed' : confirmations >= config.confirmations ? 'confirmed' : 'pending',
    confirmations,
    blockRef: String(transaction.slot),
    transfers,
    nativeBalanceDeltaRaw,
    closedTokenAccountRentRaw: tokenAccountRentRaw,
    raw: jsonSafe(transaction)
  };
}

async function verifyEvm(txHash, config, dependencies = {}) {
  const provider = dependencies.provider || new JsonRpcProvider(config.url);
  const walletAddress = String(dependencies.walletAddress || '').toLowerCase();
  const network = await provider.getNetwork();
  if (config.chainId && Number(network.chainId) !== Number(config.chainId)) {
    return {
      status: 'unavailable',
      confirmations: 0,
      blockRef: null,
      transfers: [],
      nativeBalanceDeltaRaw: null,
      raw: {},
      reason: 'RPC_CHAIN_MISMATCH'
    };
  }
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    const transaction = await provider.getTransaction(txHash);
    return {
      status: transaction ? 'pending' : 'dropped',
      confirmations: 0,
      blockRef: null,
      transfers: [],
      raw: transaction ? jsonSafe(transaction) : {}
    };
  }
  const latestBlock = await provider.getBlockNumber();
  const confirmations = Math.max(1, latestBlock - receipt.blockNumber + 1);
  let nativeBalanceDeltaRaw = null;
  let nativeBalanceVerification = null;
  const routerProceeds = dependencies.verifyNativeBalanceDelta
    ? gmgnRouterNativeProceeds(receipt, walletAddress, dependencies)
    : null;
  const wrappedWithdrawal = dependencies.verifyNativeBalanceDelta
    ? wrappedNativeWithdrawalProceeds(receipt, walletAddress, {
      ...dependencies,
      chainId: dependencies.chainId || config.chainId
    })
    : null;
  if (dependencies.verifyNativeBalanceDelta && walletAddress && receipt.blockNumber > 0) {
    try {
      const [transaction, beforeBalance, afterBalance, rawBlock] = await Promise.all([
        provider.getTransaction(txHash),
        provider.getBalance(walletAddress, receipt.blockNumber - 1),
        provider.getBalance(walletAddress, receipt.blockNumber),
        provider.send('eth_getBlockByNumber', [`0x${receipt.blockNumber.toString(16)}`, true])
      ]);
      const walletTransactions = Array.isArray(rawBlock?.transactions)
        ? rawBlock.transactions.filter((item) => (
          String(item?.from || '').toLowerCase() === walletAddress
          || String(item?.to || '').toLowerCase() === walletAddress
        ))
        : [];
      const targetFromWallet = String(receipt.from || transaction?.from || '').toLowerCase() === walletAddress;
      const uniqueTopLevelActivity = walletTransactions.length === 1
        && String(walletTransactions[0]?.hash || '').toLowerCase() === String(txHash).toLowerCase();
      if (targetFromWallet && uniqueTopLevelActivity) {
        nativeBalanceDeltaRaw = (BigInt(afterBalance) - BigInt(beforeBalance)).toString();
        nativeBalanceVerification = {
          method: 'block_balance_delta',
          before_block: receipt.blockNumber - 1,
          after_block: receipt.blockNumber,
          unique_top_level_activity: true
        };
      }
    } catch {
      nativeBalanceDeltaRaw = null;
    }
  }
  return {
    status: receipt.status === 0
      ? 'failed'
      : confirmations >= config.confirmations ? 'confirmed' : 'pending',
    confirmations,
    blockRef: String(receipt.blockNumber),
    transfers: (receipt.logs || []).map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      index: log.index
    })),
    nativeBalanceDeltaRaw,
    nativeProceedsRaw: routerProceeds?.amountRaw || wrappedWithdrawal?.amountRaw || null,
    raw: {
      receipt: jsonSafe(receipt),
      nativeBalanceVerification,
      nativeProceedsVerification: routerProceeds?.verification
        || wrappedWithdrawal?.verification || null
    }
  };
}

async function probeRpc(chainId, dependencies = {}) {
  const chain = requireChain(chainId);
  const config = rpcConfig(chain.id);
  if (!config.url && !dependencies.connection && !dependencies.provider) {
    return { ok: false, chain: chain.id, error: 'CHAIN_RPC_MISSING' };
  }
  try {
    if (chain.id === 'sol') {
      const connection = dependencies.connection || new Connection(config.url, 'confirmed');
      const [genesisHash, slot, nativeBalanceRaw] = await Promise.all([
        connection.getGenesisHash(),
        connection.getSlot('confirmed'),
        dependencies.walletAddress
          ? connection.getBalance(new PublicKey(dependencies.walletAddress), 'confirmed')
          : null
      ]);
      if (genesisHash !== SOLANA_MAINNET_GENESIS_HASH) {
        return { ok: false, chain: chain.id, error: 'RPC_CHAIN_MISMATCH', identity: genesisHash };
      }
      return {
        ok: true,
        chain: chain.id,
        identity: genesisHash,
        blockRef: String(slot),
        ...(nativeBalanceRaw === null ? {} : {
          nativeBalanceRaw: String(nativeBalanceRaw),
          nativeBalance: Number(formatUnits(nativeBalanceRaw, chain.decimals))
        })
      };
    }
    const provider = dependencies.provider || new JsonRpcProvider(config.url);
    const [network, blockNumber, nativeBalanceRaw] = await Promise.all([
      provider.getNetwork(),
      provider.getBlockNumber(),
      dependencies.walletAddress
        ? provider.getBalance(dependencies.walletAddress, 'latest')
        : null
    ]);
    if (config.chainId && Number(network.chainId) !== Number(config.chainId)) {
      return {
        ok: false,
        chain: chain.id,
        error: 'RPC_CHAIN_MISMATCH',
        identity: String(network.chainId)
      };
    }
    return {
      ok: true,
      chain: chain.id,
      identity: String(network.chainId),
      blockRef: String(blockNumber),
      ...(nativeBalanceRaw === null ? {} : {
        nativeBalanceRaw: String(nativeBalanceRaw),
        nativeBalance: Number(formatUnits(nativeBalanceRaw, chain.decimals))
      })
    };
  } catch (error) {
    return { ok: false, chain: chain.id, error: error.code || 'CHAIN_RPC_UNAVAILABLE' };
  }
}

async function captureWalletState(chainId, walletAddress, dependencies = {}) {
  const chain = requireChain(chainId);
  const config = rpcConfig(chain.id);
  if (!config.url && !dependencies.connection && !dependencies.provider) {
    const error = new Error('Chain RPC is required for a pre-submit snapshot');
    error.code = 'CHAIN_RPC_MISSING';
    throw error;
  }
  if (chain.id === 'sol') {
    const connection = dependencies.connection || new Connection(config.url, 'confirmed');
    const publicKey = new PublicKey(walletAddress);
    const [slot, nativeBalanceRaw, signatures] = await Promise.all([
      connection.getSlot('confirmed'),
      connection.getBalance(publicKey, 'confirmed'),
      connection.getSignaturesForAddress(publicKey, { limit: 1 }, 'confirmed')
    ]);
    return {
      kind: 'solana',
      slot,
      nativeBalanceRaw: String(nativeBalanceRaw),
      signatureCursor: signatures[0]?.signature || null,
      signatureSlot: signatures[0]?.slot || null
    };
  }
  const provider = dependencies.provider || new JsonRpcProvider(config.url);
  const [network, blockNumber, latestNonce, pendingNonce, nativeBalance] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    provider.getTransactionCount(walletAddress, 'latest'),
    provider.getTransactionCount(walletAddress, 'pending'),
    provider.getBalance(walletAddress, 'latest')
  ]);
  if (Number(network.chainId) !== Number(config.chainId)) {
    const error = new Error('RPC chain does not match the Chain Manifest');
    error.code = 'RPC_CHAIN_MISMATCH';
    throw error;
  }
  return {
    kind: 'evm',
    chainId: Number(network.chainId),
    blockNumber,
    latestNonce,
    pendingNonce,
    nativeBalanceRaw: nativeBalance.toString()
  };
}

async function scanWalletSinceSnapshot(chainId, walletAddress, snapshot, dependencies = {}) {
  const chain = requireChain(chainId);
  const config = rpcConfig(chain.id);
  if (chain.id !== 'sol') {
    return {
      available: false,
      reason: 'EVM_ADDRESS_HISTORY_PROVIDER_NOT_CONFIGURED',
      transactions: []
    };
  }
  const connection = dependencies.connection || new Connection(config.url, 'confirmed');
  const signatures = await connection.getSignaturesForAddress(
    new PublicKey(walletAddress),
    { limit: 100 },
    'confirmed'
  );
  const newer = signatures.filter((item) => Number(item.slot) > Number(snapshot?.slot || 0));
  return {
    available: true,
    transactions: newer.map((item) => ({
      signature: item.signature,
      slot: item.slot,
      err: item.err,
      blockTime: item.blockTime
    }))
  };
}

async function verify(chainId, txHash, dependencies = {}) {
  const chain = requireChain(chainId);
  if (!txHash) {
    return { status: 'unavailable', confirmations: 0, blockRef: null, transfers: [], raw: {}, reason: 'TX_HASH_MISSING' };
  }
  const config = rpcConfig(chain.id);
  if (!config.url && !dependencies.connection && !dependencies.provider) {
    return { status: 'unavailable', confirmations: 0, blockRef: null, transfers: [], raw: {}, reason: 'RPC_NOT_CONFIGURED' };
  }
  return chain.id === 'sol'
    ? verifySolana(txHash, config, dependencies)
    : verifyEvm(txHash, config, dependencies);
}

module.exports = {
  closedTokenAccountRentRaw,
  captureWalletState,
  gmgnRouterNativeProceeds,
  jsonSafe,
  probeRpc,
  scanWalletSinceSnapshot,
  wrappedNativeWithdrawalProceeds,
  verify,
  verifyEvm,
  verifySolana
};
