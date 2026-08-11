const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertSecurityContract,
  buildTriggeredProviderContext,
  normalizeGasPrice
} = require('../domains/trade/triggered-provider-context');

const TOKEN = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';

function input(overrides = {}) {
  return {
    cached: {
      chain: { id: 'robinhood', nativeToken: '0x0000000000000000000000000000000000000000' },
      wallet: { address: WALLET },
      token: { address: TOKEN, decimals: 18, symbol: 'TEST' },
      cacheMeta: { token: {}, security: {}, gas: {} }
    },
    signal: { contract_address: TOKEN },
    inputAmountRaw: '10000000000000000',
    slippage: 5,
    requestContext: (stage) => ({ source: 'test', stage }),
    ...overrides
  };
}

test('P25 default provider context makes no GMGN read before terminal swap', async () => {
  const calls = [];
  const result = await buildTriggeredProviderContext(input(), {
    gmgnAccess: {
      getTokenSecurity: async () => { calls.push('security'); return { is_honeypot: 'no', rug_ratio: 0.1 }; },
      getGasPrice: async () => { calls.push('gas'); return { native_token_usd_price: '3000' }; },
      quoteOrder: async () => { calls.push('quote'); return { output_amount: '123', output_token_decimals: 18 }; }
    }
  });

  assert.deepEqual(calls, []);
  assert.equal(result.security.isHoneypot, null);
  assert.deepEqual(result.gas, {});
  assert.equal(result.quote.outputAmountRaw, null);
});

test('P25 Robinhood terminal context does not pre-read security, gas, quote, or token info', async () => {
  const calls = [];
  const request = input();
  request.cached.token.decimals = null;
  const result = await buildTriggeredProviderContext(request, {
    gmgnAccess: {
      getTokenSecurity: async () => { calls.push('security'); return { is_honeypot: 'no', rug_ratio: 0.1 }; },
      getGasPrice: async () => { calls.push('gas'); return { average: '100000000' }; },
      quoteOrder: async () => { calls.push('quote'); return { output_amount: '123' }; },
      getTokenInfo: async () => { calls.push('token_info'); return { address: TOKEN, decimals: 18, symbol: 'TEST' }; }
    }
  });

  assert.equal(request.cached.token.decimals, null);
  assert.equal(result.quote.outputAmountRaw, null);
  assert.deepEqual(calls, []);
});

test('P25 BSC terminal context reads only gas when no local gas is available', async () => {
  const calls = [];
  const request = input({
    cached: {
      ...input().cached,
      chain: { id: 'bsc', nativeToken: '0x0000000000000000000000000000000000000000' }
    },
    mode: 'terminal'
  });
  const result = await buildTriggeredProviderContext(request, {
    gmgnAccess: {
      getGasPrice: async () => { calls.push('gas'); return { average: '100000000' }; },
      getTokenSecurity: async () => { calls.push('security'); return { is_honeypot: 'no', rug_ratio: 0.1 }; },
      quoteOrder: async () => { calls.push('quote'); return { output_amount: '123' }; }
    }
  });
  assert.deepEqual(calls, ['gas']);
  assert.equal(result.gas.average, '100000000');
  assert.equal(result.quote.outputAmountRaw, null);
});

test('explicit security and quote options are isolated from the default terminal path', async () => {
  const calls = [];
  const result = await buildTriggeredProviderContext({
    ...input(), mode: 'terminal', securityCheck: true, quoteRequired: true
  }, {
    gmgnAccess: {
      getTokenSecurity: async () => { calls.push('security'); return { is_honeypot: 'no', rug_ratio: 0.1 }; },
      quoteOrder: async () => { calls.push('quote'); return { output_amount: '123', output_token_decimals: 18 }; }
    }
  });
  assert.deepEqual(calls.sort(), ['quote', 'security']);
  assert.equal(result.security.isHoneypot, false);
  assert.equal(result.quote.outputAmountRaw, '123');
});

test('explicit security checks still reject official hazards', () => {
  assert.throws(
    () => assertSecurityContract({ raw: { is_honeypot: 'yes' }, isHoneypot: true, rugRatio: 0 }, 'base'),
    { code: 'GMGN_SECURITY_HONEYPOT' }
  );
  assert.throws(
    () => assertSecurityContract({ raw: { is_honeypot: 'no' }, isHoneypot: false, rugRatio: 0.31 }, 'robinhood'),
    { code: 'GMGN_SECURITY_RUG_RISK' }
  );
  assert.equal(normalizeGasPrice({ average: '100000000', native_token_usd_price: '' })
    .native_token_usd_price, null);
});

test('Robinhood accepts an omitted rug ratio because the official security schema does not provide it', () => {
  const security = {
    raw: { is_honeypot: false, buy_tax: '0', sell_tax: '0' },
    isHoneypot: false,
    rugRatio: null
  };
  assert.equal(assertSecurityContract(security, 'robinhood'), security);
  assert.throws(
    () => assertSecurityContract(security, 'base'),
    { code: 'GMGN_SECURITY_SCHEMA_INVALID' }
  );
});
