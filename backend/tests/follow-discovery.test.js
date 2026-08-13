const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizePolicyInput, remove } = require('../domains/follow-discovery/policy-service');
const { enqueueFollow, markFailed, markWaiting } = require('../domains/follow-discovery/repository');
const { normalizeResearchCandidates, resolveFollowEvent } = require('../domains/follow-discovery/resolver');
const { materialize } = require('../domains/follow-discovery/materializer');
const { evaluateSignal } = require('../domains/follow-discovery/authorization');
const whitelistQueries = require('../domains/whitelist/queries');

const ADDRESSES = [
  '0x0000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000002'
];

test('Record follow policy is valid without a trade template and keeps zero trade configuration', async () => {
  const policy = await normalizePolicyInput({
    mode: 'record', enabled: true, allowed_chain_ids: ['bsc'], resolver_options: {}
  }, {}, { query: async () => ({ rows: [] }) });
  assert.equal(policy.mode, 'record');
  assert.equal(policy.trade_template_id, null);
  assert.deepEqual(policy.trade_config_snapshot.chain_budgets.bsc, {
    budget_per_trade: 0, daily_budget: 0
  });
  assert.equal(policy.resolver_options.event_ttl_seconds, 900);
});

test('Live follow policy snapshots a positive existing trade template', async () => {
  const executor = { async query(sql) {
    assert.match(sql, /dynamic_policy_templates/);
    return { rows: [{ id: 7, version: 2, config: {
      allowed_chain_ids: ['bsc'],
      chain_budgets: { bsc: { budget_per_trade: 0.01, daily_budget: 0.05 } },
      daily_new_token_limit: 2, per_token_buy_limit: 1, slippage: 10,
      exit_strategy: { version: 1, sell_ratio_type: 'buy_amount', legs: [
        { type: 'take_profit', trigger_pct: 100, sell_pct: 50 }
      ] }
    } }] };
  } };
  const policy = await normalizePolicyInput({
    mode: 'live', allowed_chain_ids: ['bsc'], trade_template_id: 7
  }, {}, executor);
  assert.equal(policy.trade_template_id, 7);
  assert.equal(policy.trade_template_version, 2);
  assert.equal(policy.trade_config_snapshot.chain_budgets.bsc.budget_per_trade, 0.01);
});

test('Follow queue uses stable actor and target user IDs and marks baseline events', async () => {
  const executor = { async query(sql, params) {
    if (sql.includes('FROM follow_discovery_policies')) return { rows: [{
      id: 8, revision: 1, mode: 'record', baseline_at: '2026-08-05T12:00:00Z'
    }] };
    if (sql.includes('INSERT INTO follow_discovery_events')) return { rows: [{
      id: 9, behavior_key: params[9], status: params[11]
    }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const rows = await enqueueFollow({
    providerEventId: 1,
    activity: { id: 2 },
    kol: { id: 3, x_user_id: '10001' },
    item: { activityType: 'follow', actorHandle: 'cz_binance', targetUserId: '20002',
      targetHandles: ['new_project'], sourceCreatedAt: '2026-08-05T11:59:59Z' }
  }, executor);
  assert.equal(rows[0].behavior_key, 'follow:10001:20002');
  assert.equal(rows[0].status, 'baseline');
});

function resolverContext() {
  return {
    target_handle: 'new_project', target_user_id: '20002',
    allowed_chain_ids: ['bsc'],
    resolver_options: { minimum_account_age_days: 0, max_tweets: 20,
      require_original_content: true, include_profile_website: false }
  };
}

function researchResult({ handle = 'new_project', classification = 'project', roleTypes = ['official_project'],
  address = ADDRESSES[0], addresses = null, ownerHandle = handle, related = [], excerpt = '',
  chain = 'bsc' } = {}) {
  const values = addresses || [address];
  const evidence = values.map((value, index) => ({
    evidence_id: `evidence_${index + 1}`, source_type: 'original_post',
    url: `https://x.com/${ownerHandle}/status/${index + 1}`, tweet_id: String(index + 1),
    handle: ownerHandle, published_at: '2026-08-05T11:00:00Z',
    excerpt: excerpt || `Official CA ${value} on BNB Chain`
  }));
  return {
    summary: 'Grok x_search found an evidence-backed project account',
    target_identity: { classification, role_types: roleTypes, confidence: 'high',
      reasons: ['evidence-backed identity'], evidence_ids: ['identity'] },
    related_project_accounts: related.map((item, index) => ({
      handle: item, display_name: 'Official Project', relationship: 'reciprocal project relationship',
      confidence: 'high', evidence_ids: [`relationship_${index + 1}`]
    })),
    candidates: values.map((value, index) => ({
      address: value, chain_id: chain, chain_evidence_id: evidence[index].evidence_id,
      owner_handle: ownerHandle,
      source_url: evidence[index].url, source_tweet_id: evidence[index].tweet_id,
      published_at: evidence[index].published_at, source_excerpt: evidence[index].excerpt,
      confidence: 'high', evidence_ids: [evidence[index].evidence_id]
    })),
    evidence: [
      { evidence_id: 'identity', source_type: 'profile', url: `https://x.com/${handle}`,
        tweet_id: '', handle, published_at: '', excerpt: 'Official project profile' },
      ...evidence,
      ...related.map((item, index) => ({ evidence_id: `relationship_${index + 1}`,
        source_type: 'profile', url: `https://x.com/${item}`, tweet_id: '', handle: item,
        published_at: '', excerpt: `Official account references @${handle}` }))
    ],
    citations: []
  };
}

function resolverDependencies(options = {}) {
  const research = researchResult(options);
  return {
    async researchFollowTarget(input) {
      assert.equal(input.target_user_id, '20002');
      return research;
    },
    async resolveContractChain(address) {
      return {
        status: 'resolved',
        chainId: options.resolvedChain || options.chain || 'bsc',
        contractAddress: address.toLowerCase(),
        source: 'rpc_contract_code',
        matches: [options.resolvedChain || options.chain || 'bsc'],
        probes: []
      };
    },
    async verifyCandidate(candidate) { return {
      ...candidate, providerStatus: 'verified', tradableStatus: 'tradable',
      xHandles: [options.ownerHandle || options.handle || 'new_project'],
      providerSnapshot: { info: {} }, symbol: 'NEW', name: 'New Project'
    }; }
  };
}

test('P24 Follow resolver accepts one author-owned full CA from Grok evidence', async () => {
  const result = await resolveFollowEvent(resolverContext(), resolverDependencies({
    excerpt: `Official CA ${ADDRESSES[0]} on BNB Chain`
  }));
  assert.equal(result.selected.chainId, 'bsc');
  assert.equal(result.selected.contractAddress, ADDRESSES[0]);
  assert.equal(result.classification.deterministic, 'project');
});

test('Follow resolver sends the immutable target ID to Grok without a 6551 post lookup', async () => {
  let researchInput;
  const result = await resolveFollowEvent(resolverContext(), {
    ...resolverDependencies(),
    async researchFollowTarget(input) {
      researchInput = input;
      return researchResult();
    }
  });
  assert.equal(researchInput.target_user_id, '20002');
  assert.equal(result.selected.contractAddress, ADDRESSES[0]);
});

test('Follow resolver records Grok x_search evidence as the CA source', async () => {
  const result = await resolveFollowEvent(resolverContext(), resolverDependencies({
    excerpt: `Pinned official CA ${ADDRESSES[0]} on BNB Chain`
  }));
  assert.equal(result.selected.contractAddress, ADDRESSES[0]);
  assert.equal(result.evidence.some((item) => item.type === 'grok_original_post'), true);
});

test('Follow resolver matches a website primary evidence without requiring a website handle', () => {
  const event = { target_handle: 'new_project', provider_created_at: '2026-08-05T12:00:00Z' };
  const evidence = [{
    evidence_id: 'website_1', source_type: 'website', url: 'https://new-project.example',
    tweet_id: '', handle: '', published_at: '',
    excerpt: `Official CA ${ADDRESSES[0]} on BNB Chain`
  }];
  const result = normalizeResearchCandidates({
    evidence,
    candidates: [{ address: ADDRESSES[0], chain_id: 'bsc', chain_evidence_id: 'website_1',
      owner_handle: 'new_project',
      source_url: 'https://new-project.example', source_tweet_id: '', published_at: '',
      source_excerpt: `Official CA ${ADDRESSES[0]} on BNB Chain`, evidence_ids: ['website_1'] }]
  }, event, new Set(['new_project']));
  assert.equal(result.length, 1);
  assert.equal(result[0].evidence_id, 'website_1');
});

test('Follow resolver rejects a Grok candidate whose evidence excerpt omits the address', async () => {
  await assert.rejects(
    resolveFollowEvent(resolverContext(), resolverDependencies({ excerpt: 'MarsCoin launch announcement' })),
    (error) => error.code === 'FOLLOW_CA_NOT_FOUND' && error.rejected === true
  );
});

test('Follow resolver lets RPC resolve an EVM chain when Grok has no explicit chain evidence', async () => {
  const result = await resolveFollowEvent(resolverContext(), resolverDependencies({
    excerpt: `Official CA ${ADDRESSES[0]}`
  }));
  assert.equal(result.selected.chainId, 'bsc');
  assert.equal(result.selected.localEvidence.grok_chain_hint, 'bsc');
});

test('Follow resolver ignores a wrong Grok chain hint and uses the unique RPC deployment', async () => {
  const context = resolverContext();
  context.allowed_chain_ids = ['base', 'robinhood'];
  const result = await resolveFollowEvent(context, resolverDependencies({
    chain: 'base', resolvedChain: 'robinhood',
    excerpt: `Official CA ${ADDRESSES[0]} on Base`
  }));
  assert.equal(result.selected.chainId, 'robinhood');
  assert.equal(result.selected.localEvidence.grok_chain_hint, 'base');
  assert.deepEqual(result.selected.localEvidence.chain_resolution.matches, ['robinhood']);
});

test('Follow resolver rejects a contract deployed on multiple allowed chains', async () => {
  await assert.rejects(
    resolveFollowEvent(resolverContext(), {
      ...resolverDependencies(),
      async resolveContractChain(address) {
        return { status: 'ambiguous', contractAddress: address,
          matches: ['base', 'robinhood'], probes: [] };
      }
    }),
    (error) => error.code === 'FOLLOW_CA_CHAIN_AMBIGUOUS' && error.rejected === true
  );
});

test('Follow resolver waits instead of guessing when any allowed-chain RPC is unavailable', async () => {
  await assert.rejects(
    resolveFollowEvent(resolverContext(), {
      ...resolverDependencies(),
      async resolveContractChain(address) {
        return { status: 'unavailable', contractAddress: address,
          matches: [], probes: [{ chainId: 'bsc', ok: false, error: 'CHAIN_RPC_UNAVAILABLE' }] };
      }
    }),
    (error) => error.code === 'FOLLOW_CHAIN_RPC_UNAVAILABLE' && error.retryable === true
  );
});

test('Follow resolver resolves a founder through a Grok-discovered official project account', async () => {
  const context = resolverContext();
  context.target_handle = 'agilepeter';
  const result = await resolveFollowEvent(context, resolverDependencies({
    handle: 'agilepeter', ownerHandle: 'wen_officialx', classification: 'person',
    roleTypes: ['founder'], related: ['wen_officialx'],
    excerpt: `Official CA ${ADDRESSES[0]} on BNB Chain`
  }));
  assert.equal(result.classification.deterministic, 'personnel_associated_project');
  assert.deepEqual(result.relatedAccounts.map((account) => account.handle), ['wen_officialx']);
  assert.equal(result.selected.contractAddress, ADDRESSES[0]);
});

test('P24 Follow resolver does not require a second GMGN account-alignment pass', async () => {
  const context = resolverContext();
  context.target_handle = 'agilepeter';
  let verifyCalls = 0;
  const result = await resolveFollowEvent(context, {
    ...resolverDependencies({
      handle: 'agilepeter', ownerHandle: 'wen_officialx', classification: 'person',
      roleTypes: ['founder'], related: ['wen_officialx'],
      excerpt: `Official CA ${ADDRESSES[0]} on BNB Chain`
    }),
    async verifyCandidate() {
      verifyCalls += 1;
      throw new Error('P24 Follow resolution must not call GMGN candidate verification');
    }
  });
  assert.equal(verifyCalls, 0);
  assert.equal(result.selected.contractAddress, ADDRESSES[0]);
  assert.equal(result.classification.deterministic, 'personnel_associated_project');
});

test('Follow resolver rejects multiple Grok candidates instead of ranking them', async () => {
  await assert.rejects(
    resolveFollowEvent(resolverContext(), resolverDependencies({
      addresses: [ADDRESSES[0], ADDRESSES[1]],
      excerpt: `CA ${ADDRESSES[0]} and ${ADDRESSES[1]} on BNB Chain`
    })),
    (error) => error.code === 'FOLLOW_CA_AMBIGUOUS' && error.rejected === true
  );
});

test('Fixed CA queries exclude dynamic and follow-discovery system whitelists', async () => {
  const calls = [];
  const executor = { async query(sql) {
    calls.push(sql);
    return sql.includes('COUNT(*)') ? { rows: [{ count: '0' }] } : { rows: [] };
  } };
  await whitelistQueries.getAll({}, executor);
  await whitelistQueries.getActiveByContract(ADDRESSES[0], 'bsc', executor);
  const whitelistSelects = calls.filter((sql) => sql.includes('FROM ca_whitelist'));
  assert.ok(whitelistSelects.length >= 3);
  assert.ok(whitelistSelects.every((sql) => (
    sql.includes("source NOT IN ('dynamic_keyword', 'follow_discovery')")
  )));
});

test('Archiving a follow policy preserves history and cancels only queued work', async () => {
  const calls = [];
  const executor = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('UPDATE follow_discovery_policies')) return { rows: [{ id: 12 }] };
    return { rows: [] };
  } };
  assert.equal(await remove(12, executor), true);
  assert.equal(calls.some((item) => /DELETE FROM follow_discovery/i.test(item.sql)), false);
  assert.ok(calls.some((item) => item.sql.includes("mode = 'paused'") && item.sql.includes('archived_at = NOW()')));
  assert.ok(calls.some((item) => item.sql.includes('UPDATE follow_discovery_events')
    && item.sql.includes("status IN ('pending', 'processing')")));
  assert.ok(calls.some((item) => item.sql.includes('UPDATE ca_whitelist')
    && item.sql.includes("status = 'archived'")));
});

test('Follow provider waits until GMGN reset_at instead of retrying during a ban', async () => {
  let delaySeconds;
  const executor = { async query(_sql, params) {
    delaySeconds = Number(params[1]);
    return { rows: [{ id: 12, next_attempt_at: new Date() }] };
  } };
  const resetAt = Date.now() + 240_000;
  await markWaiting(12, { code: 'RATE_LIMIT_BANNED', resetAt }, executor);
  assert.ok(delaySeconds >= 238 && delaySeconds <= 242, `delay=${delaySeconds}`);
});

test('Follow provider accepts a seconds-based reset_at value', async () => {
  let delaySeconds;
  const executor = { async query(_sql, params) {
    delaySeconds = Number(params[1]);
    return { rows: [{ id: 12 }] };
  } };
  const resetAt = Math.floor((Date.now() + 120_000) / 1000);
  await markWaiting(12, { code: 'RATE_LIMIT_BANNED', resetAt }, executor);
  assert.ok(delaySeconds >= 118 && delaySeconds <= 122, `delay=${delaySeconds}`);
});

test('Revision cancellation cannot be overwritten by a stale Follow worker', async () => {
  const queries = [];
  const executor = { async query(sql, params) {
    queries.push({ sql, params });
    return { rows: [] };
  } };
  await markFailed(12, Object.assign(new Error('stale'), { code: 'FOLLOW_POLICY_REVISION_CHANGED' }), executor);
  await markWaiting(12, { code: 'RATE_LIMIT_BANNED' }, executor);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(({ sql }) => sql.includes("status IN ('pending', 'processing')")));
});

function materializerFixture(mode) {
  const calls = [];
  const policy = {
    id: 9, kol_id: 3, enabled: true, kol_enabled: true, revision: 2,
    context_hash: 'ctx', mode,
    trade_config_snapshot: {
      chain_budgets: { bsc: { budget_per_trade: 0.01, daily_budget: 0.05 } },
      slippage: 10, per_token_buy_limit: 1,
      exit_strategy: { version: 1, sell_ratio_type: 'buy_amount', legs: [
        { type: 'take_profit', trigger_pct: 100, sell_pct: 100 }
      ] }
    }
  };
  const executor = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('FROM follow_discovery_policies')) return { rows: [policy] };
    if (sql.includes('INSERT INTO dynamic_asset_families')) return { rows: [{ id: 21 }] };
    if (sql.includes('INSERT INTO dynamic_asset_variants')) return { rows: [{
      id: 22, asset_family_id: 21, chain_id: 'bsc', contract_address: ADDRESSES[0]
    }] };
    if (sql.includes('INSERT INTO dynamic_candidate_index')) return { rows: [] };
    if (sql.includes('INSERT INTO ca_whitelist')) {
      return { rows: [{ id: 23, activation_version: 1, live_activation_state: 'live_ready' }] };
    }
    if (sql.includes('UPDATE ca_whitelist') && sql.includes('activation_version')) {
      return { rows: [{ id: 23, activation_version: 1 }] };
    }
    if (sql.includes('INSERT INTO whitelist_activation_outbox')) return { rows: [] };
    if (sql.includes('INSERT INTO trade_signals')) return { rows: [{ id: 24 }] };
    if (sql.includes('INSERT INTO notification_outbox')) return { rows: [{ id: 25 }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  return { calls, executor };
}

function materializerInput(mode) {
  return {
    event: { id: 8, mode, policy_id: 9, policy_revision: 2, context_hash: 'ctx',
      x_activity_id: 7, actor_handle: 'cz_binance' },
    resolution: { selected: { chainId: 'bsc', contractAddress: ADDRESSES[0],
      symbol: 'NEW', name: 'New Project', providerStatus: 'verified',
      tradableStatus: 'tradable', xHandles: ['new_project'], sources: ['official_profile'] } }
  };
}

test('Record follow resolution never materializes a whitelist or signal', async () => {
  const { event, resolution } = materializerInput('record');
  const result = await materialize(event, resolution, {
    async query() { throw new Error('Record mode must not query materialization tables'); }
  });
  assert.equal(result, null);
});

test('Paper and Live follow resolutions use the shared pipeline without Activation', async () => {
  for (const mode of ['paper', 'live']) {
    const { calls, executor } = materializerFixture(mode);
    const { event, resolution } = materializerInput(mode);
    const result = await materialize(event, resolution, executor);
    assert.equal(result.signal.id, 24);
    assert.ok(calls.some((item) => item.sql.includes('INSERT INTO ca_whitelist')));
    assert.ok(calls.some((item) => item.sql.includes('INSERT INTO trade_signals')));
    assert.equal(result.whitelist.live_activation_state, 'live_ready');
    assert.equal(calls.some((item) => item.sql.includes('whitelist_activation_outbox')), false);
    const signalInsert = calls.find((item) => item.sql.includes('INSERT INTO trade_signals'));
    assert.equal(signalInsert.params.at(-2).name, 'New Project');
    assert.equal(signalInsert.params.at(-1).strategy_type, 'follow_discovery');
    assert.equal(signalInsert.params.at(-1).execution_decision.status, 'not_attempted');
    assert.ok(calls.some((item) => item.sql.includes("'entity_event','entity.changed'")));
  }
});

test('Live follow materialization persists P24 current-event CA provenance', async () => {
  const { calls, executor } = materializerFixture('live');
  const { event, resolution } = materializerInput('live');
  resolution.selected.providerStatus = 'local_event';
  await materialize(event, resolution, executor);
  const variantInsert = calls.find((item) => item.sql.includes('INSERT INTO dynamic_asset_variants'));
  assert.equal(variantInsert.params[8], 'local_event');
});

function authorizationSignal(overrides = {}) {
  return {
    follow_discovery_policy_id: 9, follow_discovery_event_id: 8,
    follow_discovery_policy_revision: 2, follow_discovery_context_hash: 'ctx',
    chain_id: 'bsc', contract_address: ADDRESSES[0],
    source_created_at: new Date().toISOString(), signal_created_at: new Date().toISOString(),
    ...overrides
  };
}

function authorizationPolicy(overrides = {}) {
  return {
    id: 9, enabled: true, kol_enabled: true, mode: 'live', archived_at: null,
    watch_sync_status: 'succeeded', watch_desired_present: true,
    watch_desired_flags: { newFlwBol: true },
    revision: 2, context_hash: 'ctx', event_status: 'resolved', event_chain: 'bsc',
    event_ca: ADDRESSES[0], provider_created_at: new Date().toISOString(),
    resolver_options: { event_ttl_seconds: 900 },
    trade_config_snapshot: { chain_budgets: { bsc: { budget_per_trade: 0.02, daily_budget: 0.1 } },
      daily_new_token_limit: 2, per_token_buy_limit: 2 },
    ...overrides
  };
}

test('Follow runtime authorization rejects stale revisions and expired signals', async () => {
  const executor = { async query() { return { rows: [authorizationPolicy()] }; } };
  const stale = await evaluateSignal(authorizationSignal({
    follow_discovery_policy_revision: 1,
    source_created_at: new Date(Date.now() - 1_000_000).toISOString()
  }), executor, { env: { P21_FOLLOW_DISCOVERY_ENABLED: 'true' }, skipUsage: true });
  assert.ok(stale.blockers.includes('FOLLOW_POLICY_REVISION_CHANGED'));
  assert.ok(stale.blockers.includes('SIGNAL_EXPIRED'));
});

test('Follow runtime authorization blocks only the policy whose Watch is not synchronized', async () => {
  const executor = { async query() { return { rows: [authorizationPolicy({
    watch_sync_status: 'pending'
  })] }; } };
  const result = await evaluateSignal(authorizationSignal(), executor, {
    env: { P21_FOLLOW_DISCOVERY_ENABLED: 'true' }, skipUsage: true
  });
  assert.deepEqual(result.blockers, ['FOLLOW_WATCH_NOT_SYNCED']);
});

test('Follow event enqueue requires that policy own a synchronized follow Watch', async () => {
  let inserted = false;
  const executor = { async query(sql) {
    if (sql.includes('FROM follow_discovery_policies')) {
      assert.match(sql, /watch\.status = 'succeeded'/);
      assert.match(sql, /newFlwBol/);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO follow_discovery_events')) inserted = true;
    return { rows: [] };
  } };
  const rows = await enqueueFollow({
    providerEventId: 1,
    activity: { id: 2 },
    kol: { id: 3, x_user_id: '10001' },
    item: { activityType: 'follow', actorHandle: 'cryptogle', targetUserId: '20002',
      targetHandles: ['new_project'], sourceCreatedAt: new Date().toISOString() }
  }, executor);
  assert.deepEqual(rows, []);
  assert.equal(inserted, false);
});

test('Follow runtime authorization enforces per-chain daily budget', async () => {
  let call = 0;
  const executor = { async query() {
    call += 1;
    if (call === 1) return { rows: [authorizationPolicy()] };
    return { rows: [{ spent_native: '0.08', reserved_native: '0.01', new_token_count: 0,
      open_positions: 0, token_buys: 0, existing_token_events: 0 }] };
  } };
  const result = await evaluateSignal(authorizationSignal(), executor, {
    env: { P21_FOLLOW_DISCOVERY_ENABLED: 'true' }
  });
  assert.deepEqual(result.blockers, ['FOLLOW_DAILY_BUDGET_EXCEEDED']);
});
