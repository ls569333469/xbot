const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const database = String(process.env.DB_NAME || '').trim();
const testDatabase = String(process.env.XBOT_TEST_DB_NAME || '').trim();
const productionDatabase = String(process.env.XBOT_PRODUCTION_DB_NAME || '').trim();
const productionReadOnly = process.argv.includes('--production-readonly');
const dedicatedTest = Boolean(database && testDatabase && database === testDatabase
  && /test/i.test(database) && (!productionDatabase || database !== productionDatabase));

if (!database || (!dedicatedTest && !productionReadOnly)) {
  throw new Error('Schema audit requires a dedicated test database or --production-readonly');
}

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || '',
  database
});

async function requireColumns(table, expected) {
  const result = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
       AND column_name = ANY($2::text[])`,
    [table, expected]
  );
  const found = new Set(result.rows.map((row) => row.column_name));
  const missing = expected.filter((column) => !found.has(column));
  if (missing.length > 0) throw new Error(`${table} is missing columns: ${missing.join(', ')}`);
}

async function requireIndexes(expected) {
  const result = await client.query(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
    [expected]
  );
  const found = new Set(result.rows.map((row) => row.indexname));
  const missing = expected.filter((index) => !found.has(index));
  if (missing.length > 0) throw new Error(`Schema is missing indexes: ${missing.join(', ')}`);
}

async function main() {
  await client.connect();
  const migration = await client.query(
    `SELECT name FROM schema_migrations
     WHERE name = ANY($1::text[])`,
    [['027_p19_low_latency_execution.sql', '028_p20_readonly_dynamic_resolution.sql',
      '029_p20_runtime_dynamic_signal_pipeline.sql',
      '030_p20_runtime_launch_window_lease_columns.sql',
      '031_p20_runtime_schema_index_repair.sql',
      '032_p20_dynamic_chain_budget_matrix.sql',
      '033_p20_dynamic_policy_templates.sql',
      '034_p20_approved_term_intent_and_index_bounds.sql',
      '035_p20_split_implicit_asset_families.sql',
      '036_p21_follow_discovery.sql', '037_p21_follow_discovery_candidate_source.sql',
      '038_p22_gmgn_shared_rate_state_and_audit.sql', '039_p22_follow_verification_snapshot.sql',
      '040_p23_runtime_scope_readiness_snapshot.sql',
      '041_p24_local_event_provider_status.sql',
      '042_p25_gmgn_terminal_execution.sql',
      '043_p26_local_rpc_provider_status.sql',
      '044_p27_migration_manifest.sql',
      '045_p27_signal_contract_snapshots.sql',
      '046_p27_reliable_notification_outbox.sql',
      '047_p27_local_candidate_metadata_backfill.sql',
      '048_p27_shared_gmgn_asset_metadata.sql',
      '049_p27_metadata_enqueue_missing_only.sql',
      '050_p33_kol_performance_analysis.sql',
      '051_p34_kol_research_result_convergence.sql',
      '052_p35_dynamic_preset_asset_routes.sql',
      '053_p36_kol_custom_labels.sql',
      '054_p37_project_research_xai_checkpoints.sql',
      '055_p42_template_sync_trade_config_snapshots.sql']]
  );
  const migrations = new Set(migration.rows.map((row) => row.name));
  if (!migrations.has('027_p19_low_latency_execution.sql')) throw new Error('Migration 027 is not applied');
  if (!migrations.has('028_p20_readonly_dynamic_resolution.sql')) throw new Error('Migration 028 is not applied');
  if (!migrations.has('029_p20_runtime_dynamic_signal_pipeline.sql')) throw new Error('Migration 029 is not applied');
  if (!migrations.has('030_p20_runtime_launch_window_lease_columns.sql')) throw new Error('Migration 030 is not applied');
  if (!migrations.has('031_p20_runtime_schema_index_repair.sql')) throw new Error('Migration 031 is not applied');
  if (!migrations.has('032_p20_dynamic_chain_budget_matrix.sql')) throw new Error('Migration 032 is not applied');
  if (!migrations.has('033_p20_dynamic_policy_templates.sql')) throw new Error('Migration 033 is not applied');
  if (!migrations.has('034_p20_approved_term_intent_and_index_bounds.sql')) throw new Error('Migration 034 is not applied');
  if (!migrations.has('035_p20_split_implicit_asset_families.sql')) throw new Error('Migration 035 is not applied');
  if (!migrations.has('036_p21_follow_discovery.sql')) throw new Error('Migration 036 is not applied');
  if (!migrations.has('037_p21_follow_discovery_candidate_source.sql')) throw new Error('Migration 037 is not applied');
  if (!migrations.has('038_p22_gmgn_shared_rate_state_and_audit.sql')) throw new Error('Migration 038 is not applied');
  if (!migrations.has('039_p22_follow_verification_snapshot.sql')) throw new Error('Migration 039 is not applied');
  if (!migrations.has('040_p23_runtime_scope_readiness_snapshot.sql')) throw new Error('Migration 040 is not applied');
  if (!migrations.has('041_p24_local_event_provider_status.sql')) throw new Error('Migration 041 is not applied');
  if (!migrations.has('042_p25_gmgn_terminal_execution.sql')) throw new Error('Migration 042 is not applied');
  if (!migrations.has('043_p26_local_rpc_provider_status.sql')) throw new Error('Migration 043 is not applied');
  if (!migrations.has('044_p27_migration_manifest.sql')) throw new Error('Migration 044 is not applied');
  if (!migrations.has('045_p27_signal_contract_snapshots.sql')) throw new Error('Migration 045 is not applied');
  if (!migrations.has('046_p27_reliable_notification_outbox.sql')) throw new Error('Migration 046 is not applied');
  if (!migrations.has('047_p27_local_candidate_metadata_backfill.sql')) throw new Error('Migration 047 is not applied');
  if (!migrations.has('048_p27_shared_gmgn_asset_metadata.sql')) throw new Error('Migration 048 is not applied');
  if (!migrations.has('049_p27_metadata_enqueue_missing_only.sql')) throw new Error('Migration 049 is not applied');
  if (!migrations.has('050_p33_kol_performance_analysis.sql')) throw new Error('Migration 050 is not applied');
  if (!migrations.has('051_p34_kol_research_result_convergence.sql')) throw new Error('Migration 051 is not applied');
  if (!migrations.has('052_p35_dynamic_preset_asset_routes.sql')) throw new Error('Migration 052 is not applied');
  if (!migrations.has('053_p36_kol_custom_labels.sql')) throw new Error('Migration 053 is not applied');
  if (!migrations.has('054_p37_project_research_xai_checkpoints.sql')) throw new Error('Migration 054 is not applied');
  if (!migrations.has('055_p42_template_sync_trade_config_snapshots.sql')) throw new Error('Migration 055 is not applied');

  await requireColumns('schema_migrations', [
    'checksum_sha256', 'migration_manifest_id', 'release_sha'
  ]);
  await requireColumns('trade_signals', [
    'asset_snapshot', 'authorization_snapshot', 'strategy_type', 'trade_config_snapshot'
  ]);
  await requireColumns('positions', ['asset_snapshot']);
  await requireColumns('asset_metadata', [
    'chain_id', 'contract_address', 'contract_address_key', 'provider',
    'name', 'symbol', 'logo_url', 'decimals', 'status', 'attempt_count',
    'next_attempt_at', 'locked_at', 'locked_by', 'last_error',
    'provider_snapshot', 'fetched_at'
  ]);
  await requireColumns('kol_performance_runs', [
    'mode', 'actor_handle', 'sample_started_at', 'sample_ended_at', 'as_of_at',
    'status', 'metrics', 'reason_codes', 'error_code', 'last_error'
  ]);
  await requireColumns('kol_performance_events', [
    'run_id', 'source_type', 'source_id', 'source_url', 'target_handle',
    'source_occurred_at', 'extraction_status', 'chain_id', 'contract_address',
    'contract_address_key', 'evidence_json'
  ]);
  await requireColumns('kol_performance_assets', [
    'run_id', 'first_event_id', 'chain_id', 'contract_address', 'contract_address_key',
    'entry_price', 'entry_candle_at', 'peak_price', 'peak_candle_at', 'peak_multiple',
    'price_status', 'provider_snapshot'
  ]);
  await requireColumns('kol_price_replay_cache', [
    'chain_id', 'contract_address_key', 'resolution', 'from_unix', 'to_unix',
    'provider_version', 'rows_json', 'fetched_at'
  ]);
  await requireColumns('kol_profile_runs', [
    'actor_handle', 'status', 'result_json', 'error_code', 'last_error'
  ]);
  await requireColumns('notification_outbox', [
    'channel', 'dedupe_key', 'locked_at', 'locked_by'
  ]);
  await requireColumns('x_kol_labels', [
    'id', 'name', 'normalized_name', 'created_by', 'created_at', 'updated_at'
  ]);
  await requireColumns('x_kol_account_labels', [
    'kol_id', 'label_id', 'created_at'
  ]);

  await requireColumns('ca_whitelist', [
    'live_activation_state', 'activation_version', 'activation_context_hash',
    'activation_error_code', 'activation_error_detail', 'activation_checked_at', 'activated_at'
  ]);
  await requireColumns('trade_signals', [
    'activation_wait_version', 'matched_dynamic_resolution_id', 'dynamic_target_id',
    'actor_policy_id', 'actor_policy_revision', 'dynamic_policy_context_hash'
  ]);
  await requireColumns('x_provider_events', [
    'trace_id', 'timing_json', 'swap_submitted_at', 'receive_to_submitted_ms'
  ]);
  await requireColumns('x_activities', ['trace_id']);
  await requireColumns('trade_signals', ['trace_id']);
  await requireColumns('trade_attempts', ['trace_id', 'timing_json']);
  await requireColumns('trade_orders', [
    'reconciliation_claim_token', 'reconciliation_claimed_at', 'receipt_available_at'
  ]);
  await requireColumns('x_watch_sync_outbox', [
    'desired_present', 'desired_flags', 'desired_fingerprint'
  ]);
  await requireColumns('arm_preparations', [
    'token_hash', 'configuration_fingerprint', 'policy_fingerprint',
    'activation_versions', 'compact_summary', 'status', 'expires_at', 'consumed_at',
    'failed_at', 'failure_code', 'failure_detail', 'scope_type', 'scope_id',
    'scope_chain_ids', 'scope_revision', 'scope_manifest_hash', 'readiness_snapshot',
    'probe_requested'
  ]);
  await requireColumns('whitelist_activation_outbox', [
    'whitelist_id', 'desired_version', 'status', 'attempt_count', 'locked_at'
  ]);
  await requireColumns('x_actor_dynamic_policies', [
    'kol_id', 'mode', 'enabled', 'allowed_chain_ids', 'allowed_event_types',
    'allowed_term_types', 'chain_budgets', 'revision', 'context_hash'
  ]);
  await requireColumns('dynamic_policy_asset_routes', [
    'actor_policy_id', 'label', 'variant_id', 'enabled', 'verification_source',
    'verification_snapshot', 'verified_at', 'archived_at'
  ]);
  await requireColumns('dynamic_policy_asset_aliases', [
    'route_id', 'actor_policy_id', 'alias_text', 'normalized_key', 'sort_order', 'archived_at'
  ]);
  await requireColumns('dynamic_ca_resolution_attempts', [
    'selected_preset_route_id', 'preset_route_snapshot'
  ]);
  await requireColumns('dynamic_ca_resolution_candidates', [
    'preset_route_id', 'preset_route_snapshot'
  ]);
  await requireColumns('dynamic_policy_usage_daily_by_chain', [
    'actor_policy_id', 'usage_date', 'chain_id', 'spent_native', 'reserved_native',
    'new_token_count', 'signal_count'
  ]);
  await requireColumns('dynamic_signal_jobs', [
    'x_activity_id', 'actor_policy_id', 'policy_revision', 'mode', 'status',
    'attempt_count', 'resolution_attempt_id', 'failure_code', 'last_error'
  ]);
  await requireColumns('dynamic_launch_windows', [
    'dynamic_job_id', 'status', 'attempt_count', 'worker_id', 'locked_at',
    'lease_expires_at', 'next_attempt_at', 'expires_at'
  ]);
  await requireColumns('dynamic_targets', [
    'actor_policy_id', 'actor_policy_revision', 'resolution_attempt_id', 'variant_id',
    'whitelist_id', 'chain_id', 'contract_address', 'mode', 'status', 'context_hash'
  ]);
  await requireColumns('dynamic_paper_sessions', [
    'actor_policy_id', 'policy_revision', 'status', 'started_at', 'ends_at', 'completed_at'
  ]);
  await requireColumns('dynamic_paper_evaluations', [
    'paper_session_id', 'dynamic_target_id', 'signal_id', 'position_id', 'status', 'failure_code'
  ]);
  await requireColumns('follow_discovery_policies', [
    'kol_id', 'mode', 'enabled', 'allowed_chain_ids', 'trade_template_id',
    'trade_config_snapshot', 'resolver_options', 'revision', 'context_hash',
    'baseline_at', 'archived_at'
  ]);
  await requireColumns('follow_discovery_events', [
    'policy_id', 'policy_revision', 'mode', 'actor_user_id', 'target_user_id',
    'behavior_key', 'provider_created_at', 'status', 'stage', 'chain_id',
    'contract_address', 'whitelist_id', 'signal_id', 'failure_code'
  ]);
  await requireColumns('follow_discovery_usage_daily_by_chain', [
    'policy_id', 'usage_date', 'chain_id', 'spent_native', 'reserved_native',
    'new_token_count', 'signal_count'
  ]);
  await requireColumns('follow_discovery_usage_events', [
    'policy_id', 'signal_id', 'chain_id', 'contract_address', 'amount_native',
    'counts_new_token', 'status'
  ]);
  await requireColumns('ca_whitelist', [
    'follow_discovery_policy_id', 'follow_discovery_event_id', 'provider_verification_snapshot'
  ]);
  await requireColumns('provider_rate_events', [
    'source', 'process_role', 'signal_id', 'policy_id', 'whitelist_id', 'context_json'
  ]);
  await requireColumns('trade_signals', [
    'follow_discovery_policy_id', 'follow_discovery_event_id',
    'follow_discovery_policy_revision', 'follow_discovery_context_hash'
  ]);
  await requireColumns('whitelist_template_sync_runs', [
    'template_id', 'template_version', 'requested_whitelist_ids', 'created_by'
  ]);
  await requireColumns('whitelist_template_sync_items', [
    'run_id', 'whitelist_id', 'outcome', 'reason_code', 'reason_detail',
    'before_config', 'after_config'
  ]);
  await requireIndexes([
    'asset_metadata_chain_id_contract_address_key_key',
    'idx_asset_metadata_claim',
    'uq_dynamic_resolution_job',
    'uq_dynamic_paper_session_running',
    'uq_dynamic_policy_asset_routes_active_asset',
    'uq_dynamic_policy_asset_aliases_active_key',
    'idx_dynamic_policy_asset_routes_policy',
    'idx_dynamic_policy_asset_aliases_route',
    'x_kol_labels_normalized_name_key',
    'x_kol_account_labels_pkey',
    'idx_x_kol_account_labels_label',
    'uq_whitelist_dynamic_actor_ca_chain_active',
    'uq_trade_signal_dynamic_resolution',
    'uq_follow_discovery_policy_kol_current',
    'uq_whitelist_follow_discovery_active',
    'uq_trade_signal_follow_discovery_event',
    'idx_trade_signals_trade_config_snapshot',
    'idx_whitelist_template_sync_items_run',
    'idx_whitelist_template_sync_items_whitelist'
  ]);

  const invalidActivation = await client.query(
    `SELECT COUNT(*)::int AS count FROM ca_whitelist
     WHERE activation_version < 1
        OR live_activation_state NOT IN ('syncing','live_ready','sync_failed')`
  );
  if (invalidActivation.rows[0].count !== 0) throw new Error('Invalid whitelist activation rows found');

  process.stdout.write(`SCHEMA_AUDIT_OK=${database};MODE=${productionReadOnly ? 'production-readonly' : 'test'}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end().catch(() => {});
  });
