const CHAIN_REGISTRY = {
  sol: {
    name: 'Solana',
    gmgnId: 'sol',
    nativeToken: 'So11111111111111111111111111111111111111112',
    nativeSymbol: 'SOL',
    decimals: 9,
    addressFormat: 'base58',
    walletEnvKey: 'WALLET_SOL',
    capabilities: ['dex', 'snipe'],
    color: '#14F195'
  },
  bsc: {
    name: 'BNB Smart Chain',
    gmgnId: 'bsc',
    nativeToken: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    nativeSymbol: 'BNB',
    decimals: 18,
    addressFormat: 'hex',
    walletEnvKey: 'WALLET_EVM',
    capabilities: ['dex'],
    color: '#F3BA2F'
  },
  base: {
    name: 'Base',
    gmgnId: 'base',
    nativeToken: '0x4200000000000000000000000000000000000006',
    nativeSymbol: 'ETH',
    decimals: 18,
    addressFormat: 'hex',
    walletEnvKey: 'WALLET_EVM',
    capabilities: ['dex'],
    color: '#0052FF'
  },
  eth: {
    name: 'Ethereum',
    gmgnId: 'eth',
    nativeToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    nativeSymbol: 'ETH',
    decimals: 18,
    addressFormat: 'hex',
    walletEnvKey: 'WALLET_EVM',
    capabilities: ['dex'],
    color: '#627EEA'
  },
  robinhood: {
    name: 'Robinhood',
    gmgnId: 'robinhood',
    nativeToken: '',
    nativeSymbol: 'USD',
    decimals: 2,
    addressFormat: 'none',
    walletEnvKey: '',
    capabilities: ['cex'],
    color: '#00C805'
  }
};

function getChain(chainId) {
  return CHAIN_REGISTRY[chainId];
}

function getAllChains() {
  return Object.values(CHAIN_REGISTRY);
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
  supportsCapability,
  getWalletAddress
};
