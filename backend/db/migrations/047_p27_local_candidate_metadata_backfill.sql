-- P27 additive metadata repair. Reuse only the exact local candidate selected by
-- the original P20/P21 event; never search by CA and never call a provider.

WITH exact_candidate AS (
  SELECT signal.id AS signal_id, variant.name, variant.symbol
  FROM trade_signals AS signal
  JOIN dynamic_ca_resolution_attempts AS attempt
    ON signal.strategy_type = 'dynamic_policy'
   AND attempt.id = signal.matched_dynamic_resolution_id
  JOIN dynamic_asset_variants AS variant ON variant.id = attempt.selected_variant_id
  WHERE signal.asset_snapshot->>'source' = 'historical_backfill'

  UNION ALL

  SELECT signal.id AS signal_id, variant.name, variant.symbol
  FROM trade_signals AS signal
  JOIN follow_discovery_events AS follow_event
    ON signal.strategy_type = 'follow_discovery'
   AND follow_event.id = signal.follow_discovery_event_id
  JOIN dynamic_asset_variants AS variant ON variant.id = follow_event.variant_id
  WHERE signal.asset_snapshot->>'source' = 'historical_backfill'
), enriched AS (
  SELECT signal.id,
    jsonb_set(
      jsonb_set(
        jsonb_set(
          signal.asset_snapshot - 'snapshot_hash',
          '{name}', COALESCE(to_jsonb(COALESCE(
            NULLIF(btrim(signal.asset_snapshot->>'name'), ''),
            NULLIF(btrim(candidate.name), '')
          )), 'null'::jsonb), true
        ),
        '{symbol}', COALESCE(to_jsonb(COALESCE(
          NULLIF(btrim(signal.asset_snapshot->>'symbol'), ''),
          NULLIF(btrim(candidate.symbol), '')
        )), 'null'::jsonb), true
      ),
      '{source}', to_jsonb('historical_candidate_backfill'::text), true
    ) AS snapshot_without_hash
  FROM trade_signals AS signal
  JOIN exact_candidate AS candidate ON candidate.signal_id = signal.id
  WHERE (NULLIF(btrim(signal.asset_snapshot->>'name'), '') IS NULL
      OR NULLIF(btrim(signal.asset_snapshot->>'symbol'), '') IS NULL)
    AND (NULLIF(btrim(candidate.name), '') IS NOT NULL
      OR NULLIF(btrim(candidate.symbol), '') IS NOT NULL)
), updated_signal AS (
  UPDATE trade_signals AS signal
  SET asset_snapshot = enriched.snapshot_without_hash || jsonb_build_object(
        'snapshot_hash', md5(enriched.snapshot_without_hash::text)
      )
  FROM enriched
  WHERE signal.id = enriched.id
  RETURNING signal.id, signal.asset_snapshot
)
UPDATE positions AS position
SET asset_snapshot = updated_signal.asset_snapshot
FROM updated_signal
WHERE position.signal_id = updated_signal.id
  AND position.asset_snapshot->>'source' = 'historical_backfill';
