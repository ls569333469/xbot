-- Queue shared GMGN metadata only when the immutable signal snapshot is
-- incomplete. Existing complete fixed-CA metadata remains provider-call free.

CREATE OR REPLACE FUNCTION p27_enqueue_signal_asset_metadata()
RETURNS trigger AS $$
DECLARE
  selected_chain text;
  selected_address text;
  selected_key text;
BEGIN
  IF NULLIF(btrim(NEW.asset_snapshot->>'name'), '') IS NOT NULL
      AND NULLIF(btrim(NEW.asset_snapshot->>'symbol'), '') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  selected_chain := lower(NULLIF(btrim(NEW.asset_snapshot->>'chain_id'), ''));
  selected_address := NULLIF(btrim(NEW.asset_snapshot->>'contract_address'), '');

  IF selected_chain IS NULL OR selected_address IS NULL THEN
    SELECT lower(whitelist.chain_id), NULLIF(btrim(whitelist.contract_address), '')
      INTO selected_chain, selected_address
    FROM ca_whitelist AS whitelist WHERE whitelist.id = NEW.whitelist_id;
  END IF;

  IF selected_chain NOT IN ('sol','bsc','base','eth','robinhood')
      OR selected_address IS NULL THEN
    RETURN NEW;
  END IF;

  selected_key := CASE WHEN selected_chain = 'sol'
    THEN selected_address ELSE lower(selected_address) END;
  INSERT INTO asset_metadata
    (chain_id, contract_address, contract_address_key, provider)
  VALUES (selected_chain, selected_address, selected_key, 'gmgn')
  ON CONFLICT (chain_id, contract_address_key) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
