-- P20: names and symbols create candidates but never prove project identity.
-- Split legacy implicit families while preserving provider-evidenced family keys.

INSERT INTO dynamic_asset_families
  (identity_key, canonical_name, canonical_symbol, evidence)
SELECT
  'variant:' || variant.chain_id || ':' || variant.contract_address,
  COALESCE(NULLIF(variant.name, ''), legacy.canonical_name),
  COALESCE(NULLIF(variant.symbol, ''), legacy.canonical_symbol),
  legacy.evidence || jsonb_build_object(
    'split_by', '035_p20_split_implicit_asset_families',
    'previous_identity_key', legacy.identity_key
  )
FROM dynamic_asset_variants AS variant
JOIN dynamic_asset_families AS legacy ON legacy.id = variant.asset_family_id
WHERE legacy.identity_key LIKE 'symbol:%'
   OR legacy.identity_key LIKE 'name:%'
   OR legacy.identity_key LIKE 'ca:%'
ON CONFLICT (identity_key) DO UPDATE SET
  canonical_name = COALESCE(
    NULLIF(EXCLUDED.canonical_name, ''), dynamic_asset_families.canonical_name
  ),
  canonical_symbol = COALESCE(
    NULLIF(EXCLUDED.canonical_symbol, ''), dynamic_asset_families.canonical_symbol
  ),
  evidence = dynamic_asset_families.evidence || EXCLUDED.evidence,
  updated_at = NOW();

UPDATE dynamic_asset_variants AS variant
SET asset_family_id = split.id,
    updated_at = NOW()
FROM dynamic_asset_families AS legacy,
     dynamic_asset_families AS split
WHERE variant.asset_family_id = legacy.id
  AND (
    legacy.identity_key LIKE 'symbol:%'
    OR legacy.identity_key LIKE 'name:%'
    OR legacy.identity_key LIKE 'ca:%'
  )
  AND split.identity_key = 'variant:' || variant.chain_id || ':' || variant.contract_address;

DELETE FROM dynamic_asset_families AS legacy
WHERE (
    legacy.identity_key LIKE 'symbol:%'
    OR legacy.identity_key LIKE 'name:%'
    OR legacy.identity_key LIKE 'ca:%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM dynamic_asset_variants AS variant
    WHERE variant.asset_family_id = legacy.id
  );
