const assert = require('node:assert/strict');
const test = require('node:test');
const queries = require('../domains/whitelist/queries');

test('whitelist deletion archives the row instead of destroying audit history', async () => {
  const calls = [];
  const executor = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 42, status: 'archived' }] };
    }
  };

  const result = await queries.archive(42, executor);

  assert.equal(result.status, 'archived');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE ca_whitelist/);
  assert.match(calls[0].sql, /status = 'archived'/);
  assert.doesNotMatch(calls[0].sql, /DELETE FROM/i);
  assert.deepEqual(calls[0].params, [42]);
});
