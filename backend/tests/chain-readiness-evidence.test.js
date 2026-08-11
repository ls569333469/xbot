const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyRpcBalanceFallback,
  persistContractProbeEvidence
} = require('../domains/trade/readiness-service');

test('readiness falls back to a same-wallet RPC balance when GMGN omits it', async () => {
  const probes = {
    robinhood: {
      ok: true,
      wallet: '0x1111111111111111111111111111111111111111',
      nativeBalance: null
    }
  };
  const updates = [];
  await applyRpcBalanceFallback(probes, {
    robinhood: { ok: true, nativeBalance: 0.15 }
  }, {
    query: async (sql, params) => {
      updates.push({ sql, params });
      return { rows: [] };
    }
  });
  assert.equal(probes.robinhood.nativeBalance, 0.15);
  assert.equal(probes.robinhood.nativeBalanceSource, 'rpc');
  assert.deepEqual(updates[0].params, ['robinhood', 0.15]);
});

test('passed contract probes append evidence before enabling contract readiness', async () => {
  const calls = [];
  const executor = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO chain_readiness_evidence')) {
        return { rows: [{
          id: '12',
          created_at: new Date('2026-07-22T00:00:00.000Z'),
          valid_until: new Date('2026-07-23T00:00:00.000Z')
        }] };
      }
      return { rows: [] };
    }
  };
  const evidence = await persistContractProbeEvidence(
    { providers: ['6551'], eventTypes: ['reply'], chains: ['sol'] },
    [{ id: 97, chain_id: 'sol', contract_address: 'contract' }],
    { 97: { ok: true, chain: 'sol', tokenDecimals: 6, quoteOutputAmountRaw: '123' } },
    { sol: { ok: true, wallet: 'wallet-secret-address', nativeBalance: 0.49 } },
    executor
  );

  assert.equal(evidence.sol.status, 'passed');
  assert.equal(calls[0].sql.includes('INSERT INTO chain_readiness_evidence'), true);
  assert.equal(calls[1].sql.includes('UPDATE chain_live_readiness'), true);
  assert.equal(calls[0].params.join(' ').includes('PRIVATE_KEY'), false);
  assert.equal(JSON.stringify(calls[0].params).includes('wallet-secret-address'), false);
  assert.match(evidence.sol.contextHash, /^[a-f0-9]{64}$/);
  assert.ok(evidence.sol.validUntil);
});

test('failed contract probes record evidence without revoking production approval', async () => {
  const calls = [];
  const executor = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: sql.includes('INSERT INTO chain_readiness_evidence')
        ? [{ id: '13', created_at: new Date('2026-07-22T00:00:00.000Z') }]
        : [] };
    }
  };
  const evidence = await persistContractProbeEvidence(
    { providers: ['6551'], eventTypes: ['reply'], chains: ['sol'] },
    [{ id: 97, chain_id: 'sol', contract_address: 'contract' }],
    { 97: { ok: false, chain: 'sol', error: 'QUOTE_FAILED' } },
    { sol: { ok: true, wallet: 'wallet', nativeBalance: 0.49 } },
    executor
  );

  assert.equal(evidence.sol.status, 'failed');
  const update = calls.find((sql) => sql.includes('UPDATE chain_live_readiness'));
  assert.equal(Boolean(update), true);
  assert.match(update, /CASE WHEN \$2 THEN true ELSE contract_tested END/);
});
