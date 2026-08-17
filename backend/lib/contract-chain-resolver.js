const { isAddress } = require('ethers');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getChain } = require('./chain-config');

const SOL_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SOLANA_TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);
const SOLANA_MINT_BASE_SIZE = 82;
const SOLANA_MINT_INITIALIZED_OFFSET = 45;

function normalizeAllowedChains(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => getChain(value)))];
}

function hasContractCode(value) {
  const code = String(value || '').trim().toLowerCase();
  return /^0x[0-9a-f]+$/.test(code) && !/^0x0*$/.test(code);
}

function numericChainId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = raw.startsWith('0x') ? Number.parseInt(raw.slice(2), 16) : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function jsonRpc(url, method, params, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(Math.max(500, Number(options.timeoutMs || 3500)))
  });
  if (!response.ok) {
    const error = new Error(`RPC ${method} failed with HTTP ${response.status}`);
    error.code = 'CHAIN_RPC_HTTP_ERROR';
    throw error;
  }
  const payload = await response.json();
  if (payload?.error || payload?.result === undefined) {
    const error = new Error(`RPC ${method} returned an invalid response`);
    error.code = 'CHAIN_RPC_RESPONSE_INVALID';
    throw error;
  }
  return payload.result;
}

async function probeEvmContract(chainId, contractAddress, options = {}) {
  const chain = getChain(chainId);
  const env = options.env || process.env;
  const rpcUrl = String(env[chain?.rpcEnvKey] || '').trim();
  if (!chain || chain.addressFormat !== 'hex' || !rpcUrl) {
    return { chainId, ok: false, contractFound: false, error: 'CHAIN_RPC_MISSING' };
  }
  const call = options.rpcCall
    ? (method, params) => options.rpcCall(chain.id, method, params)
    : (method, params) => jsonRpc(rpcUrl, method, params, options);
  try {
    const [identity, code] = await Promise.all([
      call('eth_chainId', []),
      call('eth_getCode', [contractAddress, 'latest'])
    ]);
    if (numericChainId(identity) !== Number(chain.chainId)) {
      return {
        chainId: chain.id, ok: false, contractFound: false,
        identity: numericChainId(identity), error: 'RPC_CHAIN_MISMATCH'
      };
    }
    return {
      chainId: chain.id,
      ok: true,
      identity: Number(chain.chainId),
      contractFound: hasContractCode(code)
    };
  } catch (error) {
    return {
      chainId: chain.id, ok: false, contractFound: false,
      error: error.code || 'CHAIN_RPC_UNAVAILABLE'
    };
  }
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Solana RPC request timed out');
          error.code = 'CHAIN_RPC_TIMEOUT';
          reject(error);
        }, Math.max(500, Number(timeoutMs || 3500)));
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeSolanaMint(contractAddress, options = {}) {
  const chain = getChain('sol');
  const env = options.env || process.env;
  const rpcUrl = String(env[chain?.rpcEnvKey] || '').trim();
  let publicKey;
  try {
    publicKey = new PublicKey(String(contractAddress || '').trim());
  } catch {
    return { chainId: 'sol', ok: false, mintFound: false, error: 'SOL_MINT_ADDRESS_INVALID' };
  }
  if (!chain || !options.connection && !rpcUrl) {
    return { chainId: 'sol', ok: false, mintFound: false, error: 'CHAIN_RPC_MISSING' };
  }
  try {
    const connection = options.connection || new Connection(rpcUrl, 'confirmed');
    const [genesisHash, account] = await withTimeout(Promise.all([
      connection.getGenesisHash(),
      connection.getAccountInfo(publicKey, 'confirmed')
    ]), options.timeoutMs);
    if (genesisHash !== SOLANA_MAINNET_GENESIS_HASH) {
      return {
        chainId: 'sol', ok: false, mintFound: false,
        identity: genesisHash, error: 'RPC_CHAIN_MISMATCH'
      };
    }
    if (!account) {
      return {
        chainId: 'sol', ok: true, mintFound: false,
        identity: genesisHash, error: 'SOL_MINT_NOT_FOUND'
      };
    }
    const owner = account.owner?.toBase58?.() || String(account.owner || '');
    const data = Buffer.from(account.data || []);
    if (!SOLANA_TOKEN_PROGRAMS.has(owner)) {
      return {
        chainId: 'sol', ok: true, mintFound: false, identity: genesisHash,
        owner, dataLength: data.length, error: 'SOL_MINT_OWNER_INVALID'
      };
    }
    if (account.executable || data.length < SOLANA_MINT_BASE_SIZE
        || data[SOLANA_MINT_INITIALIZED_OFFSET] !== 1) {
      return {
        chainId: 'sol', ok: true, mintFound: false, identity: genesisHash,
        owner, dataLength: data.length, executable: Boolean(account.executable),
        error: 'SOL_MINT_DATA_INVALID'
      };
    }
    return {
      chainId: 'sol', ok: true, mintFound: true, identity: genesisHash,
      owner, dataLength: data.length, executable: false
    };
  } catch (error) {
    return {
      chainId: 'sol', ok: false, mintFound: false,
      error: error.code || 'CHAIN_RPC_UNAVAILABLE'
    };
  }
}

async function resolveContractChain(contractAddress, allowedChains, options = {}) {
  const allowed = normalizeAllowedChains(allowedChains);
  const rawAddress = String(contractAddress || '').trim();
  if (SOL_ADDRESS_PATTERN.test(rawAddress)) {
    return allowed.includes('sol')
      ? { status: 'resolved', chainId: 'sol', contractAddress: rawAddress, source: 'address_format', probes: [] }
      : { status: 'not_allowed', contractAddress: rawAddress, matches: [], probes: [] };
  }
  if (!isAddress(rawAddress)) {
    return { status: 'invalid', contractAddress: rawAddress, matches: [], probes: [] };
  }
  const contract = rawAddress.toLowerCase();
  const evmChains = allowed.filter((chainId) => getChain(chainId)?.addressFormat === 'hex');
  if (evmChains.length === 0) {
    return { status: 'not_allowed', contractAddress: contract, matches: [], probes: [] };
  }
  const probes = await Promise.all(
    evmChains.map((chainId) => probeEvmContract(chainId, contract, options))
  );
  const unavailable = probes.filter((probe) => !probe.ok);
  const matches = probes.filter((probe) => probe.ok && probe.contractFound)
    .map((probe) => probe.chainId);
  if (unavailable.length > 0) {
    return { status: 'unavailable', contractAddress: contract, matches, probes };
  }
  if (matches.length === 1) {
    return {
      status: 'resolved', chainId: matches[0], contractAddress: contract,
      source: 'rpc_contract_code', matches, probes
    };
  }
  return {
    status: matches.length > 1 ? 'ambiguous' : 'not_found',
    contractAddress: contract,
    matches,
    probes
  };
}

module.exports = {
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_MINT_BASE_SIZE,
  SOLANA_TOKEN_PROGRAMS,
  hasContractCode,
  jsonRpc,
  normalizeAllowedChains,
  numericChainId,
  probeEvmContract,
  probeSolanaMint,
  resolveContractChain
};
