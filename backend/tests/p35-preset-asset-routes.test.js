const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  normalizePresetRoutes,
  routeExecutionSnapshot
} = require('../domains/dynamic-signal/preset-route-schema');
const { resolveDynamicSignal } = require('../domains/dynamic-signal/ca-resolver');
const {
  extractWithPresetRoutes,
  withPreviewRouteEvidence
} = require('../domains/dynamic-signal/preset-route-resolver');
const {
  commitPreparedPolicyUpsert,
  normalizePolicyInput,
  preparePolicyUpsert
} = require('../domains/dynamic-signal/policy-service');
const { normalizeTemplateConfig } = require('../domains/dynamic-signal/templates');
const assetRegistry = require('../domains/dynamic-signal/asset-registry');
const presetRouteRepository = require('../domains/dynamic-signal/preset-route-repository');
const resolutionStore = require('../domains/dynamic-signal/resolution-store');
const {
  probeEvmContract,
  probeSolanaMint,
  SOLANA_MAINNET_GENESIS_HASH
} = require('../lib/contract-chain-resolver');
const {
  MAX_VERIFY_CACHE_ENTRIES,
  pruneVerificationCache
} = require('../domains/dynamic-signal/preset-route-verification');

const CA_A = '0x0000000000000000000000000000000000000001';
const CA_B = '0x0000000000000000000000000000000000000002';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function route(overrides = {}) {
  return {
    route_id: 11,
    label: 'Utility',
    aliases: ['utility', '何必东奔西走，币安全部都有。'],
    chain_id: 'bsc',
    contract_address: CA_A,
    enabled: true,
    variant_id: 21,
    asset_family_id: 31,
    verification: {
      status: 'verified', source: 'local_rpc',
      verified_at: '2026-08-16T00:00:00.000Z', error_code: null
    },
    ...overrides
  };
}

function policyInput(overrides = {}) {
  return {
    allowed_chain_ids: ['bsc'],
    allowed_event_types: ['tweet'],
    allowed_term_types: ['approved_name'],
    approved_aliases: [],
    preset_asset_routes: [{
      label: 'Utility', aliases: ['utility'], chain_id: 'bsc',
      contract_address: CA_A, enabled: true
    }],
    ...overrides
  };
}

test('P35 route schema preserves existing NFKC punctuation rules and rejects cross-route conflicts', () => {
  const [normalized] = normalizePresetRoutes([{
    label: ' Utility ', aliases: ['ＵＴＩＬＩＴＹ', '何必东奔西走, 币安全部都有!'],
    chain_id: 'BSC', contract_address: CA_A.toUpperCase().replace('0X', '0x'), enabled: true
  }]);
  assert.equal(normalized.chain_id, 'bsc');
  assert.equal(normalized.contract_address, CA_A);
  assert.deepEqual(normalized.normalized_aliases.map((item) => item.normalized_key), [
    'utility', '何必东奔西走币安全部都有'
  ]);
  assert.throws(() => normalizePresetRoutes([
    { label: 'A', aliases: ['GME'], chain_id: 'bsc', contract_address: CA_A },
    { label: 'B', aliases: ['g.m.e'], chain_id: 'bsc', contract_address: CA_B }
  ]), { code: 'DYNAMIC_ROUTE_ALIAS_CONFLICT' });
  assert.throws(() => normalizePresetRoutes([
    { label: 'A', aliases: ['utility'], chain_id: 'bsc', contract_address: CA_A }
  ], { legacyAliases: ['Utility'] }), { code: 'DYNAMIC_ROUTE_ALIAS_CONFLICT' });
});

test('P35 resolver deduplicates multiple aliases on one route without loading Candidate Index', async () => {
  let indexLoads = 0;
  const result = await resolveDynamicSignal({
    eventType: 'tweet',
    actorText: 'UTILITY。何必东奔西走，币安全部都有。',
    allowedChains: ['bsc'],
    allowedTermTypes: ['approved_name'],
    executionMode: 'live',
    presetRoutes: [route()],
    legacyApprovedAliases: []
  }, {
    loadCandidateIndex: async () => {
      indexLoads += 1;
      throw new Error('Preset-only resolution must not load Candidate Index');
    }
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.selectedCandidate.contractAddress, CA_A);
  assert.equal(result.selectedCandidate.presetRouteId, 11);
  assert.deepEqual(result.reasonCodes, ['PRESET_ROUTE_ALIAS']);
  assert.equal(indexLoads, 0);
  assert.equal(result.candidates.length, 1);
});

test('P35 route matching keeps ASCII word boundaries and explicit ambiguity codes', async () => {
  const gme = route({ aliases: ['GME'] });
  const miss = await resolveDynamicSignal({
    actorText: 'GAME', allowedChains: ['bsc'], allowedTermTypes: ['approved_name'],
    presetRoutes: [gme], legacyApprovedAliases: []
  });
  assert.equal(miss.selectedCandidate, null);

  const ambiguous = await resolveDynamicSignal({
    actorText: 'utility and GME', allowedChains: ['bsc'], allowedTermTypes: ['approved_name'],
    presetRoutes: [route({ aliases: ['utility'] }), route({
      route_id: 12, label: 'GME', aliases: ['GME'], contract_address: CA_B,
      variant_id: 22, asset_family_id: 32
    })], legacyApprovedAliases: []
  });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.failureCode, 'DYNAMIC_ROUTE_AMBIGUOUS');
});

test('P35 treats a cashtag overlapping an approved route alias as one asset', async () => {
  const gme = route({ aliases: ['GME'] });
  const matched = await resolveDynamicSignal({
    actorText: 'Happy Monday Eve $GME. The chart deserves another look.',
    allowedChains: ['bsc'],
    allowedTermTypes: ['approved_name', 'cashtag'],
    executionMode: 'live',
    presetRoutes: [gme],
    legacyApprovedAliases: []
  });
  assert.equal(matched.status, 'resolved');
  assert.equal(matched.intent.intentClass, 'approved_term_direct');
  assert.equal(matched.selectedCandidate.contractAddress, CA_A);
  const cashtag = matched.extraction.authorOwnedTerms.find((term) => term.type === 'cashtag');
  const approved = matched.extraction.authorOwnedTerms.find((term) => term.type === 'approved_name');
  assert.equal(cashtag.assetKey, approved.assetKey);
  assert.equal(cashtag.localPresetRouteAlias, true);

  const ambiguous = await resolveDynamicSignal({
    actorText: '$GME and $BTC',
    allowedChains: ['bsc'],
    allowedTermTypes: ['approved_name', 'cashtag'],
    executionMode: 'live',
    presetRoutes: [gme],
    legacyApprovedAliases: []
  });
  assert.equal(ambiguous.status, 'rejected');
  assert.equal(ambiguous.failureCode, 'DYNAMIC_CA_POLICY_BLOCKED');
  assert.equal(ambiguous.intent.intentClass, 'multi_asset_ambiguous');
});

test('P35 match preview gives drafts identities distinct from persisted route ids', () => {
  const routes = withPreviewRouteEvidence(normalizePresetRoutes([
    { route_id: 2, label: 'Utility', aliases: ['utility'], chain_id: 'bsc', contract_address: CA_A },
    { label: 'GME', aliases: ['GME'], chain_id: 'bsc', contract_address: CA_B }
  ]));
  assert.equal(new Set(routes.map((item) => item.route_id)).size, 2);
  const state = extractWithPresetRoutes({
    actorText: 'utility and GME',
    presetRoutes: routes,
    legacyApprovedAliases: []
  });
  assert.equal(state.status, 'ambiguous');
  assert.equal(state.failureCode, 'DYNAMIC_ROUTE_AMBIGUOUS');
  assert.equal(state.matchedRoutes.length, 2);
});

test('P35 resolver merges a matching full CA and rejects a conflicting full CA', async () => {
  const same = await resolveDynamicSignal({
    actorText: `utility ${CA_A}`, allowedChains: ['bsc', 'base'],
    allowedTermTypes: ['approved_name', 'ca'], executionMode: 'live',
    presetRoutes: [route()], legacyApprovedAliases: []
  });
  assert.equal(same.status, 'resolved');
  assert.equal(same.selectedCandidate.contractAddress, CA_A);

  const conflict = await resolveDynamicSignal({
    actorText: `utility ${CA_B}`, allowedChains: ['bsc'],
    allowedTermTypes: ['approved_name', 'ca'], executionMode: 'live',
    presetRoutes: [route()], legacyApprovedAliases: []
  });
  assert.equal(conflict.status, 'rejected');
  assert.equal(conflict.failureCode, 'DYNAMIC_ROUTE_CA_CONFLICT');
});

test('P35 runtime never guesses a CA for an unbound legacy alias', async () => {
  let indexLoads = 0;
  const result = await resolveDynamicSignal({
    actorText: 'utility', allowedChains: ['bsc'], allowedTermTypes: ['approved_name'],
    executionMode: 'record', presetRoutes: [], legacyApprovedAliases: ['utility']
  }, { loadCandidateIndex: async () => { indexLoads += 1; } });
  assert.equal(result.status, 'rejected');
  assert.equal(result.failureCode, 'DYNAMIC_ROUTE_BINDING_REQUIRED');
  assert.equal(indexLoads, 0);
});

test('P35 policy hash changes only for route execution fields', () => {
  const base = normalizePolicyInput(policyInput());
  const renamed = normalizePolicyInput(policyInput({ preset_asset_routes: [{
    label: 'Display name changed', aliases: ['UTILITY!'], chain_id: 'bsc',
    contract_address: CA_A, enabled: true
  }] }));
  const changedAlias = normalizePolicyInput(policyInput({ preset_asset_routes: [{
    label: 'Utility', aliases: ['bStocks'], chain_id: 'bsc',
    contract_address: CA_A, enabled: true
  }] }));
  assert.equal(base.context_hash, renamed.context_hash);
  assert.notEqual(base.context_hash, changedAlias.context_hash);
  assert.deepEqual(routeExecutionSnapshot(base.preset_asset_routes), [{
    enabled: true, chain_id: 'bsc', contract_address: CA_A, aliases: ['utility']
  }]);
  assert.throws(() => normalizePolicyInput(policyInput({
    allowed_term_types: ['ca']
  })), { code: 'DYNAMIC_ROUTE_TERM_TYPE_REQUIRED' });
});

test('P35 live policies reject unbound aliases and templates strip account evidence', () => {
  assert.throws(() => normalizePolicyInput(policyInput({
    mode: 'live', approved_aliases: ['legacy'],
    chain_budgets: { bsc: { budget_per_trade: 0.01, daily_budget: 0.1 } },
    daily_new_token_limit: 1
  })), { code: 'DYNAMIC_ROUTE_BINDING_REQUIRED' });

  const config = normalizeTemplateConfig(policyInput({ preset_asset_routes: [{
    route_id: 99, label: 'Utility', aliases: ['utility'], chain_id: 'bsc',
    contract_address: CA_A, enabled: true, variant_id: 100,
    verification: { status: 'verified', verified_at: '2026-08-16T00:00:00.000Z' }
  }] }));
  assert.deepEqual(config.preset_asset_routes, [{
    label: 'Utility', aliases: ['utility'], chain_id: 'bsc',
    contract_address: CA_A, enabled: true
  }]);
});

test('P35 EVM and Solana probes verify the selected chain without GMGN', async () => {
  const evm = await probeEvmContract('bsc', CA_A, {
    env: { BSC_RPC_URL: 'https://bsc.example' },
    rpcCall: async (_chain, method) => method === 'eth_chainId' ? '0x38' : '0x6001'
  });
  assert.equal(evm.ok, true);
  assert.equal(evm.contractFound, true);

  const data = Buffer.alloc(82);
  data[45] = 1;
  const sol = await probeSolanaMint(SOL_MINT, {
    connection: {
      getGenesisHash: async () => SOLANA_MAINNET_GENESIS_HASH,
      getAccountInfo: async () => ({
        owner: { toBase58: () => 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        data,
        executable: false
      })
    }
  });
  assert.equal(sol.mintFound, true);
  const wallet = await probeSolanaMint(SOL_MINT, {
    connection: {
      getGenesisHash: async () => SOLANA_MAINNET_GENESIS_HASH,
      getAccountInfo: async () => ({
        owner: { toBase58: () => '11111111111111111111111111111111' },
        data,
        executable: false
      })
    }
  });
  assert.equal(wallet.mintFound, false);
  assert.equal(wallet.error, 'SOL_MINT_OWNER_INVALID');
});

test('P35 RPC verification cache removes expired entries and remains bounded', () => {
  const cache = new Map([
    ['expired', { expires_at: 99 }],
    ...Array.from({ length: MAX_VERIFY_CACHE_ENTRIES }, (_, index) => [
      `live-${index}`, { expires_at: 1_000 }
    ])
  ]);
  pruneVerificationCache(cache, 100);
  assert.equal(cache.has('expired'), false);
  assert.equal(cache.size, MAX_VERIFY_CACHE_ENTRIES - 1);
});

test('P35 asset registration reuses an existing family and preserves provider metadata', async () => {
  const calls = [];
  const executor = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM dynamic_asset_variants variant')) {
        return { rows: [{ id: 7, asset_family_id: 8, provider_status: 'verified' }] };
      }
      if (sql.startsWith('UPDATE dynamic_asset_variants')) return { rows: [{ id: 7, asset_family_id: 8 }] };
      return { rows: [] };
    }
  };
  const row = await assetRegistry.ensureVariant({
    chainId: 'bsc', contractAddress: CA_A,
    providerStatus: 'local_rpc', tradableStatus: 'unknown'
  }, 'preset_route', executor, { identityOnly: true, expiresAt: null });
  assert.equal(row.asset_family_id, 8);
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO dynamic_asset_families')), false);
  const update = calls.find((call) => call.sql.startsWith('UPDATE dynamic_asset_variants'));
  assert.doesNotMatch(update.sql, /asset_family_id\s*=/);
  assert.equal(update.params.at(-1), true);
  assert.match(update.sql, /CASE WHEN \$15 THEN expires_at/);
});

test('P35 policy preflight completes RPC before any transaction and reuses unchanged verification', async () => {
  const calls = [];
  const emptyExecutor = { async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes('FROM x_actor_dynamic_policies AS policy')) return { rows: [] };
    if (sql.startsWith('SELECT id FROM x_kol_accounts')) return { rows: [{ id: 5 }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  let probes = 0;
  const prepared = await preparePolicyUpsert(5, policyInput(), emptyExecutor, {
    probeEvmContract: async () => {
      probes += 1;
      return { chainId: 'bsc', ok: true, contractFound: true, identity: 56 };
    },
    now: () => Date.parse('2026-08-16T01:00:00.000Z')
  });
  assert.equal(probes, 1);
  assert.equal(prepared.config.preset_asset_routes[0].verification.status, 'verified');
  assert.equal(calls.some((call) => /BEGIN|COMMIT|ROLLBACK/.test(call.sql)), false);

  const currentRow = {
    id: 9, kol_id: 5, revision: 3, context_hash: prepared.config.context_hash,
    mode: 'record', enabled: true, allowed_chain_ids: ['bsc'],
    allowed_event_types: ['tweet'], allowed_term_types: ['approved_name'],
    approved_aliases: [], chain_budgets: { bsc: { budget_per_trade: 0, daily_budget: 0 } },
    budget_per_trade: 0, daily_budget: 0, daily_new_token_limit: 0,
    per_token_buy_limit: 1, slippage: 10, exit_strategy: prepared.config.exit_strategy,
    resolver_options: {}
  };
  const currentExecutor = { async query(sql) {
    if (sql.includes('FROM x_actor_dynamic_policies AS policy')) return { rows: [currentRow] };
    if (sql.includes('FROM dynamic_policy_asset_routes route')) return { rows: [{
      id: 11, actor_policy_id: 9, label: 'Utility', variant_id: 21,
      asset_family_id: 31, chain_id: 'bsc', contract_address: CA_A,
      enabled: true, verification_source: 'local_rpc', verification_snapshot: {},
      verified_at: new Date('2026-08-16T01:00:00.000Z'),
      alias_rows: [{ alias_text: 'utility', normalized_key: 'utility', sort_order: 0 }]
    }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  probes = 0;
  const reused = await preparePolicyUpsert(5, policyInput({ preset_asset_routes: [{
    label: 'Renamed only', aliases: ['utility'], chain_id: 'bsc',
    contract_address: CA_A, enabled: true
  }] }), currentExecutor, {
    probeEvmContract: async () => { probes += 1; throw new Error('must not probe'); }
  });
  assert.equal(probes, 0);
  assert.equal(reused.config.preset_asset_routes[0].route_id, 11);
  assert.equal(reused.config.preset_asset_routes[0].variant_id, 21);
});

test('P35 commit rejects a concurrent policy change before route writes', async () => {
  const writes = [];
  const executor = { async query(sql) {
    writes.push(sql);
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM x_actor_dynamic_policies')) {
      return { rows: [{ id: 9, revision: 4, context_hash: 'changed' }] };
    }
    if (sql.includes('FROM dynamic_policy_asset_routes route')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  await assert.rejects(() => commitPreparedPolicyUpsert({
    kol_id: 5,
    baseline: { policy_id: 9, revision: 3, context_hash: 'old', route_state_hash: 'old' },
    config: normalizePolicyInput(policyInput())
  }, executor), { code: 'DYNAMIC_POLICY_CONCURRENT_UPDATE' });
  assert.equal(writes.some((sql) => /^INSERT|^UPDATE/.test(sql)), false);
});

test('P35 route persistence references variants and never writes Candidate Index', async () => {
  const calls = [];
  let listCount = 0;
  const executor = { async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes('FROM dynamic_policy_asset_routes route')) {
      listCount += 1;
      if (listCount === 1) return { rows: [] };
      return { rows: [{
        id: 44, actor_policy_id: 9, label: 'Utility', variant_id: 21,
        asset_family_id: 31, chain_id: 'bsc', contract_address: CA_A,
        enabled: true, verification_source: 'local_rpc', verification_snapshot: {},
        verified_at: new Date('2026-08-16T00:00:00.000Z'),
        alias_rows: [{ alias_text: 'utility', normalized_key: 'utility', sort_order: 0 }]
      }] };
    }
    if (sql.startsWith('INSERT INTO dynamic_policy_asset_routes')) return { rows: [{ id: 44 }] };
    return { rows: [] };
  } };
  const saved = await presetRouteRepository.sync(9, [route({
    route_id: null,
    aliases: ['utility'],
    normalized_aliases: [{ text: 'utility', normalized_key: 'utility', sort_order: 0 }]
  })], executor);
  assert.equal(saved[0].route_id, 44);
  assert.equal(calls.some((call) => call.sql.includes('dynamic_candidate_index')), false);
  assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO dynamic_policy_asset_routes')));
  assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO dynamic_policy_asset_aliases')));
});

test('P35 resolution audit persists the selected route and immutable snapshot', async () => {
  const calls = [];
  const executor = { async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.startsWith('INSERT INTO dynamic_ca_resolution_attempts')) return { rows: [{ id: 55 }] };
    if (sql.startsWith('UPDATE dynamic_signal_jobs')) return { rows: [{ id: 7 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const selected = {
    ...route(),
    id: 21,
    chainId: 'bsc',
    contractAddress: CA_A,
    assetFamilyId: 31,
    presetRouteId: 11,
    presetRouteSnapshot: {
      route_id: 11, label: 'Utility', matched_aliases: ['utility'],
      chain_id: 'bsc', contract_address: CA_A, variant_id: 21
    }
  };
  await resolutionStore.persist({
    id: 7, worker_id: 'worker', x_provider_event_id: 1, x_activity_id: 2,
    kol_id: 3, kol_handle: 'actor', provider_event_id: 'event', activity_type: 'tweet',
    allowed_chain_ids: ['bsc'], actor_policy_id: 9, policy_revision: 4,
    mode: 'live', context_hash: 'hash', started_at: new Date()
  }, {
    status: 'resolved', resolverRevision: 'p35', selectedCandidate: selected,
    candidates: [selected], extraction: {}, intent: {}, candidateCoverage: {}, timing: {}
  }, executor);
  const attemptInsert = calls.find((call) => call.sql.startsWith('INSERT INTO dynamic_ca_resolution_attempts'));
  const candidateInsert = calls.find((call) => call.sql.startsWith('INSERT INTO dynamic_ca_resolution_candidates'));
  assert.equal(attemptInsert.params[30], 11);
  assert.equal(JSON.parse(attemptInsert.params[31]).route_id, 11);
  assert.equal(candidateInsert.params[13], 11);
  assert.equal(JSON.parse(candidateInsert.params[14]).matched_aliases[0], 'utility');
});

test('P35 migration is additive and runtime context loads only enabled committed routes', () => {
  const root = path.resolve(__dirname, '..');
  const migration = fs.readFileSync(path.join(
    root, 'db/migrations/052_p35_dynamic_preset_asset_routes.sql'
  ), 'utf8');
  const queue = fs.readFileSync(path.join(
    root, 'domains/dynamic-signal/event-queue.js'
  ), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS dynamic_policy_asset_routes/i);
  assert.match(migration, /REFERENCES dynamic_asset_variants\(id\)/i);
  assert.match(migration, /uq_dynamic_policy_asset_aliases_active_key/i);
  assert.match(migration, /selected_preset_route_id/i);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|TRUNCATE/i);
  assert.match(queue, /route\.enabled = true AND route\.archived_at IS NULL/);
});
