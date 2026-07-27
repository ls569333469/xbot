const assert = require('node:assert/strict');
const test = require('node:test');
const { addKol, normalizeKolFields, resolveProfile, updateKol } = require('../domains/kol/service');

test('KOL fields normalize repeated at signs and ecosystem tags', () => {
  assert.deepEqual(normalizeKolFields({
    x_handle: '@@TheUniPcs',
    chain_ids: ['cross_chain', 'base', 'base'],
    weight: 10
  }, { requireHandle: true }), {
    x_handle: 'theunipcs',
    chain_ids: ['cross_chain', 'base'],
    weight: 10
  });
});

test('KOL weight remains bounded metadata', () => {
  assert.throws(() => normalizeKolFields({ weight: 11 }), /between 1 and 10/);
  assert.throws(() => normalizeKolFields({ chain_ids: ['unknown'] }), /Unsupported ecosystem tag/);
});

test('KOL creation persists immediately and queues profile enrichment', async () => {
  let created;
  const result = await addKol({
    x_handle: '@RobinhoodCrypto',
    display_name: 'Robinhood Crypto 官方',
    chain_ids: ['robinhood'],
    weight: 10
  }, {
    queries: {
      create: async (data) => {
        created = data;
        return { id: '101', ...data, enabled: true };
      }
    }
  });

  assert.equal(created.x_user_id, 'robinhoodcrypto');
  assert.equal(created.x_handle, 'robinhoodcrypto');
  assert.equal(created.display_name, 'Robinhood Crypto 官方');
  assert.equal(result.profile_status, 'pending');
  assert.equal(created.profile_attempt_count, 0);
  assert.match(result.profile_warning, /后台/);
});

test('KOL creation does not wait for the profile client before saving', async () => {
  let initialized = false;
  const result = await addKol({
    x_handle: '@sizechad',
    display_name: 'Robinhood Chain 社区建设者',
    chain_ids: ['robinhood']
  }, {
    createXClient: () => {
      initialized = true;
      throw new Error('provider configuration unavailable');
    },
    queries: {
      create: async (data) => ({ id: '104', ...data, enabled: true })
    }
  });

  assert.equal(result.x_handle, 'sizechad');
  assert.equal(result.x_user_id, 'sizechad');
  assert.equal(result.profile_status, 'pending');
  assert.equal(initialized, false);
});

test('KOL profile resolution rejects provider sentinel IDs', async () => {
  const result = await resolveProfile({
    x_handle: '@MEADGod',
    display_name: 'MEAD',
    chain_ids: ['robinhood']
  }, {
    xClient: {
      getUserProfile: async () => ({ id: undefined, handle: 'meadgod', name: 'MEAD' })
    },
    logger: { warn() {} },
  });

  assert.equal(result.profile.id, '@MEADGod');
  assert.equal(result.profile_status, 'pending');
});

test('KOL profile resolution returns a verified provider identity', async () => {
  const result = await resolveProfile({ x_handle: 'vladtenev', chain_ids: ['robinhood'] }, {
    xClient: {
      getUserProfile: async () => ({
        id: '12345',
        handle: 'vladtenev',
        name: 'Vlad Tenev'
      })
    }
  });

  assert.equal(result.profile.id, '12345');
  assert.equal(result.profile.handle, 'vladtenev');
  assert.equal(result.profile.name, 'Vlad Tenev');
  assert.equal(result.profile_status, 'verified');
});

test('KOL handle updates remain editable while profile enrichment is unavailable', async () => {
  const result = await updateKol('103', {
    x_handle: '@SizeChad',
    display_name: 'Robinhood Chain 社区建设者'
  }, {
    queries: {
      getById: async () => ({ id: '103', x_handle: 'oldhandle', profile_status: 'verified' }),
      update: async (id, data) => ({ id, ...data, enabled: true })
    }
  });

  assert.equal(result.x_user_id, 'sizechad');
  assert.equal(result.x_handle, 'sizechad');
  assert.equal(result.profile_status, 'pending');
  assert.equal(result.identity_reset, true);
});

test('KOL metadata updates preserve an already verified identity', async () => {
  let updated;
  const result = await updateKol('104', {
    x_handle: '@VladTenev',
    weight: 9
  }, {
    queries: {
      getById: async () => ({ id: '104', x_handle: 'vladtenev', profile_status: 'verified' }),
      update: async (id, data) => {
        updated = data;
        return { id, x_user_id: '12345', profile_status: 'verified', ...data };
      }
    }
  });

  assert.equal(updated.identity_reset, false);
  assert.equal(updated.x_user_id, undefined);
  assert.equal(result.profile_status, 'verified');
});
