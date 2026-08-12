-- P27 additive, immutable display and authorization snapshots.

ALTER TABLE trade_signals
  ADD COLUMN IF NOT EXISTS asset_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS authorization_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_type text;

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS asset_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM trade_signals
    WHERE actor_policy_id IS NOT NULL AND follow_discovery_policy_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'P27 strategy attribution conflict: signal has both dynamic and follow policy';
  END IF;
END $$;

UPDATE trade_signals
SET strategy_type = CASE
      WHEN follow_discovery_policy_id IS NOT NULL THEN 'follow_discovery'
      WHEN actor_policy_id IS NOT NULL THEN 'dynamic_policy'
      ELSE 'fixed_ca'
    END
WHERE strategy_type IS NULL;

UPDATE trade_signals AS signal
SET asset_snapshot = jsonb_build_object(
      'snapshot_version', 'p27.asset.v1',
      'source', 'historical_backfill',
      'chain_id', whitelist.chain_id,
      'contract_address', whitelist.contract_address,
      'symbol', NULLIF(whitelist.symbol, ''),
      'name', NULLIF(whitelist.project_name, ''),
      'logo_url', NULL,
      'project_handles', COALESCE(whitelist.project_x_handles, '{}'::text[])
    ) || jsonb_build_object(
      'snapshot_hash', md5(jsonb_build_object(
        'chain_id', whitelist.chain_id,
        'contract_address', whitelist.contract_address,
        'symbol', NULLIF(whitelist.symbol, ''),
        'name', NULLIF(whitelist.project_name, ''),
        'project_handles', COALESCE(whitelist.project_x_handles, '{}'::text[])
      )::text)
    )
FROM ca_whitelist AS whitelist
WHERE signal.whitelist_id = whitelist.id
  AND signal.asset_snapshot = '{}'::jsonb;

UPDATE trade_signals
SET authorization_snapshot = jsonb_build_object(
      'snapshot_version', 'p27.authorization.v1',
      'source', 'historical_backfill',
      'signal_policy_snapshot', jsonb_build_object(
        'mode', CASE WHEN execution_mode IN ('live','paper') THEN execution_mode ELSE 'record' END,
        'policy_id', CASE
          WHEN follow_discovery_policy_id IS NOT NULL THEN to_jsonb(follow_discovery_policy_id)
          WHEN actor_policy_id IS NOT NULL THEN to_jsonb(actor_policy_id)
          ELSE to_jsonb(whitelist_id)
        END,
        'revision', CASE
          WHEN follow_discovery_policy_revision IS NOT NULL THEN to_jsonb(follow_discovery_policy_revision)
          WHEN actor_policy_revision IS NOT NULL THEN to_jsonb(actor_policy_revision)
          ELSE 'null'::jsonb
        END,
        'context_hash', COALESCE(
          to_jsonb(follow_discovery_context_hash),
          to_jsonb(dynamic_policy_context_hash),
          'null'::jsonb
        )
      ),
      'execution_decision', jsonb_build_object('status', 'unknown', 'blockers', '[]'::jsonb)
    )
WHERE authorization_snapshot = '{}'::jsonb;

UPDATE positions AS position
SET asset_snapshot = signal.asset_snapshot
FROM trade_signals AS signal
WHERE position.signal_id = signal.id
  AND position.asset_snapshot = '{}'::jsonb
  AND signal.asset_snapshot <> '{}'::jsonb;

UPDATE positions AS position
SET asset_snapshot = jsonb_build_object(
      'snapshot_version', 'p27.asset.v1',
      'source', 'historical_backfill',
      'chain_id', position.chain_id,
      'contract_address', position.contract_address,
      'symbol', NULLIF(COALESCE(position.symbol, whitelist.symbol), ''),
      'name', NULLIF(whitelist.project_name, ''),
      'logo_url', NULL,
      'project_handles', COALESCE(whitelist.project_x_handles, '{}'::text[])
    )
FROM ca_whitelist AS whitelist
WHERE position.whitelist_id = whitelist.id
  AND position.asset_snapshot = '{}'::jsonb;

ALTER TABLE trade_signals
  DROP CONSTRAINT IF EXISTS trade_signals_strategy_type_check;
ALTER TABLE trade_signals
  ADD CONSTRAINT trade_signals_strategy_type_check
  CHECK (strategy_type IN ('fixed_ca','dynamic_policy','follow_discovery')) NOT VALID;
ALTER TABLE trade_signals VALIDATE CONSTRAINT trade_signals_strategy_type_check;
ALTER TABLE trade_signals ALTER COLUMN strategy_type SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trade_signals_strategy_created
  ON trade_signals(strategy_type, created_at DESC);
