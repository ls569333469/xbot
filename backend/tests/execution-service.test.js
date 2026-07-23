const assert = require('node:assert/strict');
const test = require('node:test');
const {
  derivePriceImpactPct,
  evaluateRisk,
  nativeBalance,
  nativePriceUsd,
  resolveNativePriceUsd,
  taxAdjustedPriceImpact
} = require('../domains/trade/execution-service');

test('execution derives native USD price from GMGN balance and usd_value', () => {
  const wallet = {
    balances: [{ symbol: 'SOL', balance: '0.5', usd_value: '75' }]
  };
  assert.equal(nativeBalance(wallet, 'SOL'), 0.5);
  assert.equal(nativePriceUsd(wallet, 'SOL'), 150);
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

test('execution risk warns on unknown whitelist taxes and rejects active Solana authorities', () => {
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
  assert.equal(sol.passed, false);
  assert.ok(sol.reasons.includes('MINT_AUTHORITY_ACTIVE'));
  assert.ok(sol.reasons.includes('FREEZE_AUTHORITY_ACTIVE'));
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
  assert.ok(risk.warnings.includes('HIGH_BUY_TAX'));
  assert.ok(risk.warnings.includes('HIGH_SELL_TAX'));
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

test('execution risk warns on unavailable rug ratio but rejects known high values', () => {
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
  assert.equal(unknownSol.reasons.includes('RUG_RATIO_UNKNOWN'), false);
  assert.ok(unknownSol.warnings.includes('RUG_RATIO_UNKNOWN'));

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
  assert.equal(unknownEvmRisk.reasons.includes('RUG_RATIO_UNKNOWN'), false);
  assert.ok(unknownEvmRisk.warnings.includes('RUG_RATIO_UNKNOWN'));

  const high = riskContext('base', {
    isHoneypot: false,
    buyTax: 0,
    sellTax: 0,
    rugRatio: 0.31,
    renouncedMint: null,
    renouncedFreeze: null
  });
  assert.ok(evaluateRisk(high, { max_rug_ratio: 0.3 }).reasons.includes('HIGH_RUG_RATIO'));
});

test('execution risk warns on unavailable Solana quote impact while retaining authority blockers', () => {
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
  assert.ok(result.reasons.includes('MINT_AUTHORITY_UNKNOWN_SOL'));
  assert.ok(result.reasons.includes('FREEZE_AUTHORITY_UNKNOWN_SOL'));
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
  assert.ok(risk.reasons.includes('SLIPPAGE_TOO_HIGH'));
  assert.equal(risk.checks.price_impact_source, 'derived_from_quote_values');
});
