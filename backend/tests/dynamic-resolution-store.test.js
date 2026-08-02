const assert = require('node:assert/strict');
const test = require('node:test');
const { getById } = require('../domains/dynamic-signal/resolution-store');

test('dynamic resolution detail reads one attempt with ordered candidate evidence', async () => {
  const calls = [];
  const executor = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 7, status: 'ambiguous', candidates: [] }] };
    }
  };

  const result = await getById('7', executor);

  assert.equal(result.id, 7);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(calls[0].params, [7]);
  assert.match(calls[0].sql, /dynamic_ca_resolution_candidates/);
  assert.match(calls[0].sql, /candidate\.selected DESC/);
});

test('dynamic resolution detail returns null when the attempt is missing', async () => {
  const executor = { query: async () => ({ rows: [] }) };
  assert.equal(await getById(999, executor), null);
});
