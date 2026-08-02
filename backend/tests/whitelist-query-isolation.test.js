const assert = require('node:assert/strict');
const test = require('node:test');
const queries = require('../domains/whitelist/queries');

test('fixed whitelist list excludes dynamic compatibility records', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT COUNT\(\*\) FROM ca_whitelist/.test(sql)) return { rows: [{ count: '1' }] };
      if (/SELECT \* FROM ca_whitelist/.test(sql)) {
        return { rows: [{ id: 1, source: 'manual', status: 'active' }] };
      }
      return { rows: [] };
    }
  };

  const result = await queries.getAll({ page: '1', pageSize: '20', summary: true }, executor);

  assert.equal(result.total, 1);
  const listQuery = calls.find((item) => /SELECT \* FROM ca_whitelist/.test(item.sql));
  assert.match(listQuery.sql, /source <> 'dynamic_keyword'/);
  assert.match(calls[0].sql, /source <> 'dynamic_keyword'/);
});

test('fixed CA lookup does not select a dynamic compatibility record', async () => {
  let query = '';
  const executor = {
    async query(sql) {
      query = sql;
      return { rows: [] };
    }
  };

  await queries.getActiveByContract(
    '0x1111111111111111111111111111111111111111',
    'base',
    executor
  );

  assert.match(query, /source <> 'dynamic_keyword'/);
});
