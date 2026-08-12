const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');

const migrationSql = fs.readFileSync(path.resolve(
  __dirname, '../db/migrations/047_p27_local_candidate_metadata_backfill.sql'
), 'utf8');

function emptySnapshot(chain, contractAddress) {
  return {
    snapshot_version: 'p27.asset.v1',
    source: 'historical_backfill',
    chain_id: chain,
    contract_address: contractAddress,
    symbol: null,
    name: null,
    logo_url: null,
    project_handles: [],
    snapshot_hash: 'pre-backfill'
  };
}

test('P27 local candidate backfill enriches only exact P20/P21 historical links', async () => {
  const client = await db.pool.connect();
  await client.query('BEGIN');
  try {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const kol = (await client.query(
      `INSERT INTO x_kol_accounts (x_user_id, x_handle, display_name, enabled)
       VALUES ($1,$2,$3,true) RETURNING id`,
      [`p27-backfill-${suffix}`, `p27backfill${suffix}`.slice(0, 48), 'P27 Backfill']
    )).rows[0];
    const family = (await client.query(
      `INSERT INTO dynamic_asset_families (identity_key, canonical_name, canonical_symbol)
       VALUES ($1,$2,$3) RETURNING id`,
      [`p27-backfill-${suffix}`, 'Candidate Family', 'P27C']
    )).rows[0];
    const dynamicAddress = `0x${'1'.repeat(35)}${suffix.slice(-5)}`;
    const followAddress = `0x${'2'.repeat(35)}${suffix.slice(-5)}`;
    const untouchedAddress = `0x${'3'.repeat(35)}${suffix.slice(-5)}`;
    const variants = (await client.query(
      `INSERT INTO dynamic_asset_variants
        (asset_family_id, chain_id, contract_address, name, symbol)
       VALUES ($1,'robinhood',$2,'Dynamic Candidate','DYNC'),
              ($1,'robinhood',$3,'Follow Candidate','FOLC')
       RETURNING id, contract_address`,
      [family.id, dynamicAddress, followAddress]
    )).rows;
    const dynamicVariant = variants.find((row) => row.contract_address === dynamicAddress);
    const followVariant = variants.find((row) => row.contract_address === followAddress);
    const resolution = (await client.query(
      `INSERT INTO dynamic_ca_resolution_attempts
        (source_provider, source_event_id, resolver_revision, intent_rule_revision,
         intent_class, allowed_chain_ids, status, selected_family_id, selected_variant_id)
       VALUES ('6551',$1,'p27-test','p27-test','full_ca_solo',ARRAY['robinhood'],
         'resolved',$2,$3) RETURNING id`,
      [`p27-backfill-resolution-${suffix}`, family.id, dynamicVariant.id]
    )).rows[0];
    const policy = (await client.query(
      `INSERT INTO follow_discovery_policies
        (kol_id, mode, enabled, allowed_chain_ids, context_hash)
       VALUES ($1,'live',true,ARRAY['robinhood'],$2) RETURNING id`,
      [kol.id, `p27-follow-context-${suffix}`]
    )).rows[0];

    const signalIds = {};
    for (const fixture of [
      { key: 'dynamic', address: dynamicAddress, type: 'dynamic_policy', variant: dynamicVariant.id },
      { key: 'follow', address: followAddress, type: 'follow_discovery', variant: followVariant.id },
      { key: 'untouched', address: untouchedAddress, type: 'dynamic_policy', variant: null }
    ]) {
      const whitelist = (await client.query(
        `INSERT INTO ca_whitelist
          (contract_address, chain_id, budget_per_trade, total_budget, source,
           managed_by_system, live_activation_state)
         VALUES ($1,'robinhood',0.001,0.01,$2,true,'live_ready') RETURNING id`,
        [fixture.address, fixture.type === 'follow_discovery' ? 'follow_discovery' : 'dynamic_keyword']
      )).rows[0];
      const activity = (await client.query(
        `INSERT INTO x_activities
          (kol_id, kol_handle, activity_type, tweet_id, provider, processed)
         VALUES ($1,$2,$3,$4,'6551',true) RETURNING id`,
        [kol.id, `p27backfill${suffix}`.slice(0, 48),
          fixture.type === 'follow_discovery' ? 'follow' : 'tweet',
          `p27-backfill-${fixture.key}-${suffix}`]
      )).rows[0];
      let followEventId = null;
      if (fixture.type === 'follow_discovery') {
        followEventId = (await client.query(
          `INSERT INTO follow_discovery_events
            (x_activity_id, policy_id, policy_revision, mode, actor_user_id,
             actor_handle, target_user_id, target_handle, behavior_key,
             provider_created_at, status, stage, chain_id, contract_address,
             variant_id, whitelist_id)
           VALUES ($1,$2,1,'live',$3,$4,$5,$6,$7,NOW(),'resolved','materialized',
             'robinhood',$8,$9,$10) RETURNING id`,
          [activity.id, policy.id, `actor-${suffix}`, `p27backfill${suffix}`.slice(0, 48),
            `target-${suffix}`, `target${suffix}`.slice(0, 48),
            `p27-follow-${suffix}`, fixture.address, fixture.variant, whitelist.id]
        )).rows[0].id;
      }
      const signal = (await client.query(
        `INSERT INTO trade_signals
          (activity_id, whitelist_id, kol_id, kol_handle, signal_type, execution_mode,
           status, canonical_key, matched_dynamic_resolution_id,
           follow_discovery_policy_id, follow_discovery_event_id, strategy_type,
           asset_snapshot, authorization_snapshot)
         VALUES ($1,$2,$3,$4,$5,'live','recorded',$6,$7,$8,$9,$10,$11,'{}')
         RETURNING id`,
        [activity.id, whitelist.id, kol.id, `p27backfill${suffix}`.slice(0, 48),
          fixture.type === 'follow_discovery' ? 'follow_discovery' : 'dynamic_keyword',
          `p27-backfill:${fixture.key}:${suffix}`,
          fixture.type === 'dynamic_policy' && fixture.variant ? resolution.id : null,
          fixture.type === 'follow_discovery' ? policy.id : null,
          followEventId, fixture.type, emptySnapshot('robinhood', fixture.address)]
      )).rows[0];
      signalIds[fixture.key] = signal.id;
      await client.query(
        `INSERT INTO positions
          (signal_id, whitelist_id, contract_address, chain_id, execution_mode,
           status, asset_snapshot)
         VALUES ($1,$2,$3,'robinhood','live','open_protected',$4)`,
        [signal.id, whitelist.id, fixture.address, emptySnapshot('robinhood', fixture.address)]
      );
    }

    await client.query(migrationSql);
    const rows = (await client.query(
      `SELECT signal.id, signal.asset_snapshot AS signal_snapshot,
              position.asset_snapshot AS position_snapshot,
              signal.status, position.status AS position_status,
              position.contract_address
       FROM trade_signals AS signal
       JOIN positions AS position ON position.signal_id = signal.id
       WHERE signal.id = ANY($1::int[]) ORDER BY signal.id`,
      [Object.values(signalIds)]
    )).rows;
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    for (const [key, expected] of [
      ['dynamic', { name: 'Dynamic Candidate', symbol: 'DYNC' }],
      ['follow', { name: 'Follow Candidate', symbol: 'FOLC' }]
    ]) {
      const row = byId.get(Number(signalIds[key]));
      assert.equal(row.signal_snapshot.name, expected.name);
      assert.equal(row.signal_snapshot.symbol, expected.symbol);
      assert.equal(row.signal_snapshot.source, 'historical_candidate_backfill');
      assert.deepEqual(row.position_snapshot, row.signal_snapshot);
      assert.equal(row.status, 'recorded');
      assert.equal(row.position_status, 'open_protected');
    }
    const untouched = byId.get(Number(signalIds.untouched));
    assert.equal(untouched.signal_snapshot.name, null);
    assert.equal(untouched.signal_snapshot.symbol, null);
    assert.equal(untouched.signal_snapshot.source, 'historical_backfill');
    assert.equal(untouched.position_snapshot.source, 'historical_backfill');
    assert.equal(untouched.contract_address, untouchedAddress);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test.after(async () => {
  await db.pool.end();
});
