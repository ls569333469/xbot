const assert = require('node:assert/strict');
const test = require('node:test');
const { explorerUrl } = require('../lib/chain-config');
const { escapeHtml, Notifier } = require('../lib/notifier');

test('P27 Telegram fields are HTML escaped', () => {
  assert.equal(escapeHtml('<BAD & "quoted">'), '&lt;BAD &amp; &quot;quoted&quot;&gt;');
});

test('P27 explorer registry maps Robinhood and never falls back for unknown chains', () => {
  const address = '0xabc/unsafe';
  assert.equal(
    explorerUrl('robinhood', 'address', address),
    'https://robinhoodchain.blockscout.com/address/0xabc%2Funsafe'
  );
  assert.equal(new Notifier().getChainExplorerLink('unknown', address), null);
});
