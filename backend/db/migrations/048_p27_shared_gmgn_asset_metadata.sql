-- P27 shared GMGN asset metadata. Network work is performed by an execution
-- worker; signal creation only enqueues one row per chain and contract.

CREATE TABLE IF NOT EXISTS asset_metadata (
  id bigserial PRIMARY KEY,
  chain_id text NOT NULL CHECK(chain_id IN ('sol','bsc','base','eth','robinhood')),
  contract_address text NOT NULL,
  contract_address_key text NOT NULL,
  provider text NOT NULL DEFAULT 'gmgn' CHECK(provider = 'gmgn'),
  name text,
  symbol text,
  logo_url text,
  decimals int CHECK(decimals IS NULL OR (decimals >= 0 AND decimals <= 36)),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','completed','failed')),
  attempt_count int NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT (NOW() + INTERVAL '30 seconds'),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT NOW(),
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(chain_id, contract_address_key)
);

CREATE INDEX IF NOT EXISTS idx_asset_metadata_claim
  ON asset_metadata(status, next_attempt_at, locked_at, id)
  WHERE status IN ('pending','processing','failed');

CREATE OR REPLACE FUNCTION p27_enqueue_signal_asset_metadata()
RETURNS trigger AS $$
DECLARE
  selected_chain text;
  selected_address text;
  selected_key text;
BEGIN
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

DROP TRIGGER IF EXISTS trg_p27_enqueue_signal_asset_metadata ON trade_signals;
CREATE TRIGGER trg_p27_enqueue_signal_asset_metadata
AFTER INSERT ON trade_signals
FOR EACH ROW EXECUTE FUNCTION p27_enqueue_signal_asset_metadata();

-- Only historical assets whose display metadata is incomplete are queued.
-- The worker processes one asset at a time, so this cannot create a burst.
INSERT INTO asset_metadata
  (chain_id, contract_address, contract_address_key, provider, next_attempt_at)
SELECT DISTINCT
  lower(whitelist.chain_id),
  whitelist.contract_address,
  CASE WHEN lower(whitelist.chain_id) = 'sol'
    THEN whitelist.contract_address ELSE lower(whitelist.contract_address) END,
  'gmgn',
  NOW() + INTERVAL '30 seconds'
FROM trade_signals AS signal
JOIN ca_whitelist AS whitelist ON whitelist.id = signal.whitelist_id
WHERE lower(whitelist.chain_id) IN ('sol','bsc','base','eth','robinhood')
  AND NULLIF(btrim(whitelist.contract_address), '') IS NOT NULL
  AND (
    NULLIF(btrim(signal.asset_snapshot->>'name'), '') IS NULL
    OR NULLIF(btrim(signal.asset_snapshot->>'symbol'), '') IS NULL
    OR EXISTS (
      SELECT 1 FROM positions AS position
      WHERE position.signal_id = signal.id
        AND (
          NULLIF(btrim(position.asset_snapshot->>'name'), '') IS NULL
          OR NULLIF(btrim(position.asset_snapshot->>'symbol'), '') IS NULL
        )
    )
  )
ON CONFLICT (chain_id, contract_address_key) DO NOTHING;
