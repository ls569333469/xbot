WITH duplicates AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY buy_order_id ORDER BY id ASC) AS row_number
  FROM position_lots
  WHERE buy_order_id IS NOT NULL
)
DELETE FROM position_lots AS lot
USING duplicates
WHERE lot.id = duplicates.id
  AND duplicates.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_position_lots_buy_order
  ON position_lots(buy_order_id)
  WHERE buy_order_id IS NOT NULL;
