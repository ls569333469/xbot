const assert = require('node:assert/strict');
const test = require('node:test');
const {
  hasContractCode,
  numericChainId,
  resolveContractChain
} = require('../lib/contract-chain-resolver');

const ADDRESS = '0x7fe995a80075df3dc8ae11a9b82c7fe4202cd87f';
const IDENTITIES = { bsc: '0x38', base: '0x2105', eth: '0x1', robinhood: '0x1237' };

function rpcDeployment(chains = [], failures = []) {
  return async (chain, method) => {
    if (failures.includes(chain)) {
      const error = new Error('RPC unavailable');
      error.code = 'CHAIN_RPC_UNAVAILABLE';
      throw error;
    }
    if (method === 'eth_chainId') return IDENTITIES[chain];
    if (method === 'eth_getCode') return chains.includes(chain) ? '0x6001600055' : '0x';
    throw new Error(`Unexpected RPC method: ${method}`);
  };
}

test('contract code and chain ID normalization reject empty provider values', () => {
  assert.equal(hasContractCode('0x'), false);
  assert.equal(hasContractCode('0x0000'), false);
  assert.equal(hasContractCode('0x6001'), true);
  assert.equal(numericChainId('0x1237'), 4663);
  assert.equal(numericChainId('8453'), 8453);
});

test('EVM contract chain resolver selects the only RPC with deployed bytecode', async () => {
  const result = await resolveContractChain(
    ADDRESS,
    ['bsc', 'base', 'eth', 'robinhood'],
    { env: {
      BSC_RPC_URL: 'https://bsc.test', BASE_RPC_URL: 'https://base.test',
      ETH_RPC_URL: 'https://eth.test', ROBINHOOD_RPC_URL: 'https://robinhood.test'
    }, rpcCall: rpcDeployment(['robinhood']) }
  );
  assert.equal(result.status, 'resolved');
  assert.equal(result.chainId, 'robinhood');
  assert.deepEqual(result.matches, ['robinhood']);
  assert.equal(result.probes.every((probe) => probe.ok), true);
});

test('EVM contract chain resolver fails closed on multi-chain deployment', async () => {
  const result = await resolveContractChain(ADDRESS, ['base', 'robinhood'], {
    env: { BASE_RPC_URL: 'https://base.test', ROBINHOOD_RPC_URL: 'https://robinhood.test' },
    rpcCall: rpcDeployment(['base', 'robinhood'])
  });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.matches, ['base', 'robinhood']);
});

test('EVM contract chain resolver does not select a chain while another RPC is unavailable', async () => {
  const result = await resolveContractChain(ADDRESS, ['base', 'robinhood'], {
    env: { BASE_RPC_URL: 'https://base.test', ROBINHOOD_RPC_URL: 'https://robinhood.test' },
    rpcCall: rpcDeployment(['robinhood'], ['base'])
  });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.matches, ['robinhood']);
});

test('Solana address format resolves without EVM RPC calls', async () => {
  const result = await resolveContractChain(
    'So11111111111111111111111111111111111111112',
    ['sol', 'base'],
    { rpcCall: async () => { throw new Error('RPC should not be called'); } }
  );
  assert.equal(result.status, 'resolved');
  assert.equal(result.chainId, 'sol');
  assert.equal(result.source, 'address_format');
});
