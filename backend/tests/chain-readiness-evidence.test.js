const assert = require('node:assert/strict');
const test = require('node:test');
const { persistContractProbeEvidence } = require('../domains/trade/readiness-service');

test('passed contract probes append evidence before enabling contract readiness', async () => {
  const calls = [];
  const executor = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO chain_readiness_evidence')) {
        return { rows: [{ id: '12', created_at: new Date('2026-07-22T00:00:00.000Z') }] };
      }
      return { rows: [] };
    }
  };
  const evidence = await persistContractProbeEvidence(
    { providers: ['6551'], eventTypes: ['reply'], chains: ['sol'] },
    [{ id: 97, chain_id: 'sol', contract_address: 'contract' }],
    { 97: { ok: true, chain: 'sol', tokenDecimals: 6, quoteOutputAmountRaw: '123' } },
    { sol: { ok: true, wallet: 'wallet', nativeBalance: 0.49 } },
    executor
  );

  assert.equal(evidence.sol.status, 'passed');
  assert.equal(calls[0].sql.includes('INSERT INTO chain_readiness_evidence'), true);
  assert.equal(calls[1].sql.includes('UPDATE chain_live_readiness'), true);
  assert.equal(calls[0].params.join(' ').includes('PRIVATE_KEY'), false);
});

test('failed contract probes record evidence without enabling the chain', async () => {
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
  assert.equal(calls.some((sql) => sql.includes('UPDATE chain_live_readiness')), false);
});
