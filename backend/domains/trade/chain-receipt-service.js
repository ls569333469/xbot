const { Connection } = require('@solana/web3.js');
const { JsonRpcProvider } = require('ethers');
const { requireChain, rpcConfig } = require('./chain-adapters');

const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const GMGN_ROUTER_SWAP_EVENT_TOPIC = '0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a';

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

function gmgnRouterNativeProceeds(receipt, walletAddress, dependencies = {}) {
  const wallet = String(walletAddress || '').toLowerCase();
  const router = String(receipt?.to || '').toLowerCase();
  const sender = String(receipt?.from || '').toLowerCase();
  const expectedInput = String(dependencies.expectedInputAmountRaw || '');
  const expectedOutput = String(dependencies.expectedOutputAmountRaw || '');
  if (!wallet || sender !== wallet || !router
      || !/^\d+$/.test(expectedInput) || !/^\d+$/.test(expectedOutput)) return null;

  for (const log of receipt.logs || []) {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (String(log.address || '').toLowerCase() !== router
        || String(topics[0] || '').toLowerCase() !== GMGN_ROUTER_SWAP_EVENT_TOPIC
        || topicAddress(topics[1]) !== wallet
        || topicAddress(topics[2]) !== wallet) continue;
    const data = String(log.data || '').replace(/^0x/, '');
    if (!/^[0-9a-f]+$/i.test(data) || data.length < 128) continue;
    const inputRaw = BigInt(`0x${data.slice(0, 64)}`).toString();
    const outputRaw = BigInt(`0x${data.slice(64, 128)}`).toString();
    if (inputRaw !== expectedInput || outputRaw !== expectedOutput || BigInt(outputRaw) <= 0n) continue;
    return {
      amountRaw: outputRaw,
      verification: {
        method: 'gmgn_router_swap_event',
        router,
        log_index: Number(log.index ?? -1),
        input_amount_raw: inputRaw,
        output_amount_raw: outputRaw,
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
    nativeProceedsRaw: routerProceeds?.amountRaw || null,
    raw: {
      receipt: jsonSafe(receipt),
      nativeBalanceVerification,
      nativeProceedsVerification: routerProceeds?.verification || null
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
      const [genesisHash, slot] = await Promise.all([
        connection.getGenesisHash(),
        connection.getSlot('confirmed')
      ]);
      if (genesisHash !== SOLANA_MAINNET_GENESIS_HASH) {
        return { ok: false, chain: chain.id, error: 'RPC_CHAIN_MISMATCH', identity: genesisHash };
      }
      return { ok: true, chain: chain.id, identity: genesisHash, blockRef: String(slot) };
    }
    const provider = dependencies.provider || new JsonRpcProvider(config.url);
    const [network, blockNumber] = await Promise.all([
      provider.getNetwork(),
      provider.getBlockNumber()
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
      blockRef: String(blockNumber)
    };
  } catch (error) {
    return { ok: false, chain: chain.id, error: error.code || 'CHAIN_RPC_UNAVAILABLE' };
  }
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
  gmgnRouterNativeProceeds,
  jsonSafe,
  probeRpc,
  verify,
  verifyEvm,
  verifySolana
};
