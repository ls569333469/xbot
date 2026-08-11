const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertTargetChainReady,
  boundedEvidenceDeadline,
  derivePriceImpactPct,
  evaluateRisk,
  feeReserve,
  gmgnRequestContext,
  mergeTriggeredTokenInfo,
  nativeBalance,
  nativePriceUsd,
  resolveNativePriceUsd,
  resolveWalletNativeBalance,
  taxAdjustedPriceImpact
} = require('../domains/trade/execution-service');

test('GMGN execution provenance uses one scope and a non-empty trace for every signal', () => {
  const previous = process.env.P22_GMGN_RATE_SCOPE;
  process.env.P22_GMGN_RATE_SCOPE = 'gmgn:test-scope';
  try {
    assert.deepEqual(gmgnRequestContext({
      signal_id: 901,
      actor_policy_id: 7,
      whitelist_id: 878
    }, 'quote'), {
      source: 'p20_dynamic_quote',
      signalId: 901,
      policyId: 7,
      whitelistId: 878,
      traceId: 'signal:901',
      executionSessionId: 'signal:901',
      rateScope: 'gmgn:test-scope'
    });
    assert.equal(
      gmgnRequestContext({ signal_id: 902 }, 'swap', 'trace-902').traceId,
      'trace-902'
    );
  } finally {
    if (previous === undefined) delete process.env.P22_GMGN_RATE_SCOPE;
    else process.env.P22_GMGN_RATE_SCOPE = previous;
  }
});

test('pre-submit evidence receives its full bounded window when evidence capture begins', () => {
  assert.equal(boundedEvidenceDeadline(20_000, 10_000), 11_500);
  assert.equal(boundedEvidenceDeadline(11_000, 10_000), 11_000);
});

test('execution fee reserve must be explicitly configured per chain', () => {
  const previous = process.env.GMGN_MAX_FEE_RESERVE_ROBINHOOD;
  try {
    delete process.env.GMGN_MAX_FEE_RESERVE_ROBINHOOD;
    assert.throws(() => feeReserve('robinhood'), { code: 'CHAIN_FEE_RESERVE_MISSING' });
    process.env.GMGN_MAX_FEE_RESERVE_ROBINHOOD = '0.002';
    assert.equal(feeReserve('robinhood'), '0.002');
  } finally {
    if (previous === undefined) delete process.env.GMGN_MAX_FEE_RESERVE_ROBINHOOD;
    else process.env.GMGN_MAX_FEE_RESERVE_ROBINHOOD = previous;
  }
});

test('execution checks readiness for the target chain instead of any ready chain', () => {
  const readiness = {
    chains: [
      { chain: 'sol', ready: true, blockers: [] },
      { chain: 'base', ready: false, blockers: ['WALLET_QUARANTINE_ACTIVE'] }
    ]
  };
  assert.equal(assertTargetChainReady(readiness, 'sol').chain, 'sol');
  assert.throws(
    () => assertTargetChainReady(readiness, 'base'),
    (error) => error.code === 'LIVE_CHAIN_READINESS_FAILED'
  );
});

test('strategy-scoped execution accepts infrastructure readiness without widening fixed scope', () => {
  const readiness = {
    chains: [{
      chain: 'bsc',
      ready: false,
      infrastructure_ready: true,
      blockers: []
    }]
  };

  assert.throws(
    () => assertTargetChainReady(readiness, 'bsc'),
    { code: 'LIVE_CHAIN_READINESS_FAILED' }
  );
  assert.equal(
    assertTargetChainReady(readiness, 'bsc', { strategyScope: true }).chain,
    'bsc'
  );
});

test('execution derives native USD price from GMGN balance and usd_value', () => {
  const wallet = {
    balances: [{ symbol: 'SOL', balance: '0.5', usd_value: '75' }]
  };
  assert.equal(nativeBalance(wallet, 'SOL'), 0.5);
  assert.equal(nativePriceUsd(wallet, 'SOL'), 150);
});

test('execution uses the GMGN wallet balance without an RPC request when available', async () => {
  let rpcCalls = 0;
  const result = await resolveWalletNativeBalance({
    chain: { id: 'robinhood', nativeSymbol: 'ETH' },
    wallet: {
      address: '0x1111111111111111111111111111111111111111',
      balances: [{ symbol: 'ETH', balance: '0.15' }]
    }
  }, {
    probeRpc: async () => {
      rpcCalls += 1;
      return { ok: true, nativeBalance: 99 };
    }
  });

  assert.deepEqual(result, { value: 0.15, source: 'gmgn', rpc: null });
  assert.equal(rpcCalls, 0);
});

test('execution falls back to the same-wallet RPC balance when GMGN omits it', async () => {
  const walletAddress = '0x2222222222222222222222222222222222222222';
  const result = await resolveWalletNativeBalance({
    chain: { id: 'robinhood', nativeSymbol: 'ETH' },
    wallet: { address: walletAddress, balances: [] }
  }, {
    probeRpc: async (chain, options) => {
      assert.equal(chain, 'robinhood');
      assert.equal(options.walletAddress, walletAddress);
      return {
        ok: true,
        nativeBalance: 0.15,
        identity: '46614',
        blockRef: '12345'
      };
    }
  });

  assert.deepEqual(result, {
    value: 0.15,
    source: 'rpc',
    rpc: { identity: '46614', block_ref: '12345' }
  });
});

test('execution reports an unknown balance only when GMGN and RPC are unavailable', async () => {
  const result = await resolveWalletNativeBalance({
    chain: { id: 'robinhood', nativeSymbol: 'ETH' },
    wallet: {
      address: '0x3333333333333333333333333333333333333333',
      balances: []
    }
  }, {
    probeRpc: async () => ({ ok: false, error: 'CHAIN_RPC_UNAVAILABLE' })
  });

  assert.deepEqual(result, {
    value: null,
    source: 'unavailable',
    rpc: { error: 'CHAIN_RPC_UNAVAILABLE' }
  });
});

test('execution merges token decimals from GMGN only after the local context lacks them', () => {
  const cached = {
    token: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: '', decimals: null },
    cacheMeta: { token: { hit: true, source: 'signal_snapshot' } }
  };
  const token = mergeTriggeredTokenInfo(cached, {
    raw: { decimals: 18 },
    address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    symbol: 'CRUDECAT', decimals: 18, priceUsd: 1.25, liquidityUsd: 1000,
    fieldAvailability: { liquidity: 'known' }
  }, { contract_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(token.decimals, 18);
  assert.equal(token.symbol, 'CRUDECAT');
  assert.equal(cached.cacheMeta.token.hit, false);
  assert.equal(cached.cacheMeta.token.source, 'gmgn_trigger_token_info');
});

test('execution rejects token info for a different contract', () => {
  assert.throws(() => mergeTriggeredTokenInfo({
    token: { decimals: null }, cacheMeta: { token: {} }
  }, { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', decimals: 18 }, {
    contract_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  }), { code: 'GMGN_TOKEN_ADDRESS_MISMATCH' });
});

test('execution prefers GMGN chain gas price over an ambiguous EVM zero-address token price', () => {
  assert.equal(resolveNativePriceUsd({
    chain: { id: 'bsc', nativeSymbol: 'BNB' },
    wallet: { balances: [{ symbol: 'BNB', balance: '0.1', usd_value: '' }] },
    gas: { native_token_usd_price: 570.55 },
    nativeToken: { priceUsd: 1922.79 }
  }), 570.55);
});

function riskContext(chain, security) {
  return {
    chain: { id: chain },
    security,
    pool: { liquidityUsd: 25000 },
    token: { liquidityUsd: 25000, rugRatio: 0.1, decimals: 6, priceUsd: 1 },
    quote: { priceImpactPct: 1, outputAmountRaw: '9900000' },
    walletNativeBalance: 1,
    budgetNative: '0.1',
    nativeUsd: 100,
    feeReserveNative: '0.001',
    budgetUsdSnapshot: 10
  };
}

test('execution risk records token security warnings without overriding whitelist authorization', () => {
  const evm = evaluateRisk(riskContext('base', {
    isHoneypot: false,
    buyTax: null,
    sellTax: null,
    renouncedMint: null,
    renouncedFreeze: null
  }), {});
  assert.equal(evm.passed, true);
  assert.ok(evm.warnings.includes('BUY_TAX_UNKNOWN'));
  assert.ok(evm.warnings.includes('SELL_TAX_UNKNOWN'));

  const sol = evaluateRisk(riskContext('sol', {
    isHoneypot: null,
    buyTax: null,
    sellTax: null,
    renouncedMint: false,
    renouncedFreeze: false
  }), {});
  assert.equal(sol.passed, true);
  assert.ok(sol.warnings.includes('MINT_AUTHORITY_ACTIVE'));
  assert.ok(sol.warnings.includes('FREEZE_AUTHORITY_ACTIVE'));
});

test('missing native USD price is observable but does not block the terminal swap', () => {
  const context = riskContext('robinhood', {
    isHoneypot: null,
    buyTax: null,
    sellTax: null,
    renouncedMint: null,
    renouncedFreeze: null
  });
  context.nativeUsd = null;
  context.budgetUsdSnapshot = null;

  const risk = evaluateRisk(context, {});

  assert.equal(risk.passed, true);
  assert.equal(risk.reasons.includes('GMGN_NATIVE_USD_PRICE_MISSING'), false);
});

test('whitelist tax policy warns but does not reject high taxes or count them as pool impact', () => {
  const context = riskContext('base', {
    isHoneypot: false,
    buyTax: 40,
    sellTax: 60,
    rugRatio: 0.1,
    renouncedMint: null,
    renouncedFreeze: null
  });
  context.quote.priceImpactPct = 43;
  const risk = evaluateRisk(context, {
    max_buy_tax: 5,
    max_sell_tax: 10,
    max_slippage_pct: 5
  });
  assert.equal(risk.passed, true);
  assert.ok(risk.warnings.includes('BUY_TAX_PRESENT'));
  assert.ok(risk.warnings.includes('SELL_TAX_PRESENT'));
  assert.equal(risk.checks.price_impact_gross_pct, 43);
  assert.equal(risk.checks.price_impact_pct, 3);
  assert.equal(risk.checks.tax_policy, 'whitelist_warning_only');
  assert.deepEqual(taxAdjustedPriceImpact({ value: 43, source: 'provider' }, 40), {
    value: 3,
    source: 'provider_excluding_buy_tax',
    grossValue: 43,
    buyTax: 40
  });
});

test('execution risk blocks unavailable and high rug ratio', () => {
  const unknown = riskContext('sol', {
    isHoneypot: null,
    buyTax: null,
    sellTax: null,
    rugRatio: null,
    renouncedMint: true,
    renouncedFreeze: true
  });
  unknown.token.rugRatio = null;
  const unknownSol = evaluateRisk(unknown, {});
  assert.ok(unknownSol.reasons.includes('GMGN_SECURITY_SCHEMA_INVALID'));

  const unknownEvm = riskContext('base', {
    isHoneypot: false,
    buyTax: 0,
    sellTax: 0,
    rugRatio: null,
    renouncedMint: null,
    renouncedFreeze: null
  });
  unknownEvm.token.rugRatio = null;
  const unknownEvmRisk = evaluateRisk(unknownEvm, {});
  assert.ok(unknownEvmRisk.reasons.includes('GMGN_SECURITY_SCHEMA_INVALID'));

  const high = riskContext('base', {
    isHoneypot: false,
    buyTax: 0,
    sellTax: 0,
    rugRatio: 0.31,
    renouncedMint: null,
    renouncedFreeze: null
  });
  const highRisk = evaluateRisk(high, { max_rug_ratio: 0.3 });
  assert.equal(highRisk.passed, false);
  assert.ok(highRisk.reasons.includes('GMGN_SECURITY_RUG_RISK'));
});

test('execution risk treats an unavailable Robinhood rug ratio as an official field warning', () => {
  const context = riskContext('robinhood', {
    isHoneypot: false,
    buyTax: 0,
    sellTax: 0,
    rugRatio: null,
    renouncedMint: null,
    renouncedFreeze: null
  });
  context.token.rugRatio = null;
  const result = evaluateRisk(context, {});
  assert.equal(result.reasons.includes('GMGN_SECURITY_SCHEMA_INVALID'), false);
  assert.ok(result.warnings.includes('RUG_RATIO_FIELD_UNAVAILABLE_ROBINHOOD'));
});

test('execution risk warns on unavailable Solana quote impact and authority facts', () => {
  const context = riskContext('sol', {
    isHoneypot: null,
    buyTax: null,
    sellTax: null,
    rugRatio: 0.1,
    renouncedMint: null,
    renouncedFreeze: null
  });
  context.quote.priceImpactPct = null;
  context.quote.outputAmountRaw = null;
  const result = evaluateRisk(context, {});
  assert.equal(result.reasons.includes('PRICE_IMPACT_UNKNOWN'), false);
  assert.ok(result.warnings.includes('PRICE_IMPACT_UNKNOWN'));
  assert.ok(result.warnings.includes('MINT_AUTHORITY_UNKNOWN_SOL'));
  assert.ok(result.warnings.includes('FREEZE_AUTHORITY_UNKNOWN_SOL'));
});

test('execution derives quote price impact from native and output token USD values', () => {
  const context = riskContext('sol', {
    isHoneypot: null,
    buyTax: null,
    sellTax: null,
    rugRatio: 0.1,
    renouncedMint: true,
    renouncedFreeze: true
  });
  context.quote.priceImpactPct = null;
  context.quote.outputAmountRaw = '9500000';
  assert.deepEqual(derivePriceImpactPct(context), {
    value: 5,
    source: 'derived_from_quote_values'
  });
  const risk = evaluateRisk(context, { max_slippage_pct: 4 });
  assert.equal(risk.passed, true);
  assert.equal(risk.checks.price_impact_source, 'derived_from_quote_values');
});
