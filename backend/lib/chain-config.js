const CHAIN_REGISTRY = {
  sol: {
    id: 'sol',
    name: 'Solana',
    gmgnId: 'sol',
    nativeToken: 'So11111111111111111111111111111111111111112',
    nativeSymbol: 'SOL',
    decimals: 9,
    addressFormat: 'base58',
    walletEnvKey: null,
    rpcEnvKey: 'SOLANA_RPC_URL',
    defaultConfirmations: 1,
    executionImplemented: true,
    tradeDefaults: { tpPct: 100, slPct: 20, slippage: 10 },
    retryDefault: { enabled: false, maxRetries: 2, retryWindowMs: 8000, failureEvidenceWindowMs: 30000 },
    feeCapabilities: ['priority_fee', 'tip_fee', 'anti_mev'],
    receiptVerifier: 'solana',
    addressActivityProvider: 'solana_rpc',
    capabilities: ['dex', 'snipe'],
    color: '#14F195'
  },
  bsc: {
    id: 'bsc',
    name: 'BNB Smart Chain',
    gmgnId: 'bsc',
    nativeToken: '0x0000000000000000000000000000000000000000',
    nativeSymbol: 'BNB',
    decimals: 18,
    chainId: 56,
    addressFormat: 'hex',
    walletEnvKey: null,
    rpcEnvKey: 'BSC_RPC_URL',
    defaultConfirmations: 2,
    executionImplemented: true,
    tradeDefaults: { tpPct: 100, slPct: 20, slippage: 10 },
    retryDefault: { enabled: false, maxRetries: 2, retryWindowMs: 10000, failureEvidenceWindowMs: 30000 },
    feeCapabilities: ['gas_price', 'anti_mev'],
    receiptVerifier: 'evm',
    addressActivityProvider: null,
    capabilities: ['dex'],
    color: '#F3BA2F'
  },
  base: {
    id: 'base',
    name: 'Base',
    gmgnId: 'base',
    nativeToken: '0x0000000000000000000000000000000000000000',
    nativeSymbol: 'ETH',
    decimals: 18,
    chainId: 8453,
    addressFormat: 'hex',
    walletEnvKey: null,
    rpcEnvKey: 'BASE_RPC_URL',
    defaultConfirmations: 2,
    executionImplemented: true,
    tradeDefaults: { tpPct: 100, slPct: 20, slippage: 10 },
    retryDefault: { enabled: false, maxRetries: 2, retryWindowMs: 12000, failureEvidenceWindowMs: 30000 },
    feeCapabilities: ['gas_price'],
    receiptVerifier: 'evm',
    addressActivityProvider: null,
    capabilities: ['dex'],
    color: '#0052FF'
  },
  eth: {
    id: 'eth',
    name: 'Ethereum',
    gmgnId: 'eth',
    nativeToken: '0x0000000000000000000000000000000000000000',
    nativeSymbol: 'ETH',
    decimals: 18,
    chainId: 1,
    addressFormat: 'hex',
    walletEnvKey: null,
    rpcEnvKey: 'ETH_RPC_URL',
    defaultConfirmations: 2,
    executionImplemented: true,
    tradeDefaults: { tpPct: 100, slPct: 20, slippage: 10 },
    retryDefault: { enabled: false, maxRetries: 2, retryWindowMs: 30000, failureEvidenceWindowMs: 30000 },
    feeCapabilities: ['gas_level', 'auto_fee'],
    receiptVerifier: 'evm',
    addressActivityProvider: null,
    capabilities: ['dex'],
    color: '#627EEA'
  },
  robinhood: {
    id: 'robinhood',
    name: 'Robinhood Chain',
    gmgnId: 'robinhood',
    nativeToken: '0x0000000000000000000000000000000000000000',
    nativeSymbol: 'ETH',
    decimals: 18,
    chainId: 4663,
    addressFormat: 'hex',
    walletEnvKey: null,
    rpcEnvKey: 'ROBINHOOD_RPC_URL',
    defaultConfirmations: 2,
    executionImplemented: true,
    tradeDefaults: { tpPct: 50, slPct: 15, slippage: 5 },
    retryDefault: { enabled: false, maxRetries: 0, retryWindowMs: 30000, failureEvidenceWindowMs: 30000 },
    feeCapabilities: [],
    receiptVerifier: 'evm',
    addressActivityProvider: null,
    capabilities: ['dex'],
    color: '#00C805'
  }
};

function getChain(chainId) {
  return CHAIN_REGISTRY[chainId];
}

function getAllChains() {
  return Object.values(CHAIN_REGISTRY);
}

function getExecutionChains() {
  return getAllChains().filter((chain) => chain.executionImplemented);
}

function assertChainRegistry() {
  const required = [
    'id', 'name', 'gmgnId', 'nativeToken', 'nativeSymbol', 'decimals',
    'addressFormat', 'rpcEnvKey', 'defaultConfirmations', 'retryDefault',
    'tradeDefaults', 'feeCapabilities', 'receiptVerifier'
  ];
  for (const [id, chain] of Object.entries(CHAIN_REGISTRY)) {
    const missing = required.filter((key) => chain[key] === undefined || chain[key] === null);
    if (chain.id !== id || missing.length > 0) {
      throw new Error(`Invalid Chain Manifest for ${id}: ${missing.join(', ') || 'id mismatch'}`);
    }
  }
  return true;
}

function supportsCapability(chainId, capability) {
  const chain = getChain(chainId);
  return chain ? chain.capabilities.includes(capability) : false;
}

function getWalletAddress(chainId) {
  const chain = getChain(chainId);
  if (!chain || !chain.walletEnvKey) return null;
  return process.env[chain.walletEnvKey] || null;
}

module.exports = {
  CHAIN_REGISTRY,
  getChain,
  getAllChains,
  getExecutionChains,
  assertChainRegistry,
  supportsCapability,
  getWalletAddress
};
