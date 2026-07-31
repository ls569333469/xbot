const assert = require('node:assert/strict');
const test = require('node:test');
const adapter = require('../lib/gmgn-adapter');

test('adapter normalizes nested prices, nullable security, and processed orders', () => {
  assert.equal(adapter.normalizeTokenInfo({ decimals: 6, price: { price: '0.25' } }).priceUsd, 0.25);
  assert.equal(adapter.normalizeSecurity({ is_honeypot: null }, 'sol').isHoneypot, null);
  assert.equal(adapter.normalizeOrderStatus('processed'), 'pending');
  assert.equal(adapter.normalizeStrategyStatus('open'), 'running');
  assert.equal(adapter.normalizeStrategyStatus('success'), 'triggered');
});

test('strategy adapter preserves provider close facts for chain verification', () => {
  const strategy = adapter.normalizeStrategy({
    order_id: 'strategy-1',
    status: 'closed',
    strategy_status: 'stopped',
    close_amount: '1250000',
    close_sign_hash: 'tx-hash',
    close_time: 1_750_000_000_000,
    base_decimal: 6,
    quote_decimal: 9,
    condition_orders: [{ cid: 'leg-1', status: 'success', sell_ratio: '50' }]
  });
  assert.equal(strategy.status, 'triggered');
  assert.equal(strategy.closeAmountRaw, '1250000');
  assert.equal(strategy.closeTxHash, 'tx-hash');
  assert.equal(strategy.quoteDecimals, 9);
});

test('adapter fails closed on malformed exact quote and balance amounts', () => {
  assert.throws(() => adapter.normalizeQuote({ output_amount: '1.2' }), error => error.code === 'GMGN_SCHEMA_INVALID');
  assert.throws(() => adapter.normalizeWalletTokenBalance({}, 6), error => error.code === 'GMGN_SCHEMA_INVALID');
  assert.equal(adapter.normalizeWalletTokenBalance({ balance_raw: '123' }, 6).amountRaw, '123');
  const listed = adapter.normalizeWalletTokenBalance({
    balances: [{ balance: '1.234567', decimal: 6 }]
  }, 9);
  assert.equal(listed.amountRaw, null);
  assert.equal(listed.amountDisplay, '1.234567');
  assert.equal(listed.decimals, 6);
  assert.equal(adapter.normalizeWalletTokenBalance({
    balances: [{ balance: '0', decimal: 0 }]
  }, 6).decimals, 6);
  const fractionalWithBrokenDecimals = adapter.normalizeWalletTokenBalance({
    balances: [{ balance: '19.16844', decimal: 0 }]
  }, 6);
  assert.equal(fractionalWithBrokenDecimals.amountDisplay, '19.16844');
  assert.equal(fractionalWithBrokenDecimals.decimals, 6);
});

test('wallet adapter derives native balance and USD price without hardcoded prices', () => {
  const wallet = { balances: [{ symbol: 'SOL', balance: '0.5', usd_value: '75' }] };
  assert.equal(adapter.walletNativeBalance(wallet, 'SOL'), 0.5);
  assert.equal(adapter.walletNativePriceUsd(wallet, 'SOL'), 150);
});

test('market adapter preserves unknown fields and normalizes nested hot-search blocks', () => {
  const result = adapter.normalizeMarketCollection([{
    chain: 'bsc',
    interval: '24h',
    tokens: [{
      address: '0x39dbed3a2bd333467115de45665cc57f813c4571',
      symbol: 'pons',
      liquidity: '0',
      wallet_tags_stat: {}
    }]
  }]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].symbol, 'PONS');
  assert.equal(result.candidates[0].liquidityUsd, 0);
  assert.equal(result.candidates[0].renownedWallets, null);
  assert.equal(result.candidates[0].fieldAvailability.liquidity, 'known');
  assert.equal(result.candidates[0].fieldAvailability.renowned_wallets, 'unknown');
});

test('holder adapter does not count pure transfers or fully exited wallets as active buyers', () => {
  assert.equal(adapter.normalizeHolder({
    buy_volume_cur: '100', balance: '10', transfer_in: true
  }).activeBuyer, false);
  assert.equal(adapter.normalizeHolder({
    buy_volume_cur: '100', balance: '0', sell_amount_percentage: '1'
  }).activeBuyer, false);
  assert.equal(adapter.normalizeHolder({
    buy_volume_cur: '100', balance: '10', transfer_in: false
  }).activeBuyer, true);
});
