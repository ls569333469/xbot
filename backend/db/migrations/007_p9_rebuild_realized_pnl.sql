WITH confirmed_sell AS (
  SELECT attempt.id AS attempt_id,
         orders.id AS order_id,
         orders.output_amount_raw::numeric
           / power(10::numeric, orders.output_decimals) AS output_display
  FROM trade_attempts AS attempt
  JOIN trade_orders AS orders ON orders.attempt_id = attempt.id
  WHERE attempt.side = 'sell'
    AND attempt.status = 'confirmed'
    AND orders.normalized_status = 'confirmed'
    AND orders.output_amount_raw ~ '^\d+$'
    AND orders.output_decimals IS NOT NULL
)
UPDATE trade_attempts AS attempt
SET output_amount_display = confirmed_sell.output_display,
    updated_at = NOW()
FROM confirmed_sell
WHERE attempt.id = confirmed_sell.attempt_id;

WITH confirmed_sell AS (
  SELECT orders.id AS order_id,
         orders.output_amount_raw::numeric
           / power(10::numeric, orders.output_decimals) AS output_display
  FROM trade_orders AS orders
  JOIN trade_attempts AS attempt ON attempt.id = orders.attempt_id
  WHERE attempt.side = 'sell'
    AND attempt.status = 'confirmed'
    AND orders.normalized_status = 'confirmed'
    AND orders.output_amount_raw ~ '^\d+$'
    AND orders.output_decimals IS NOT NULL
)
UPDATE trade_orders AS orders
SET output_amount_display = confirmed_sell.output_display,
    updated_at = NOW()
FROM confirmed_sell
WHERE orders.id = confirmed_sell.order_id;

WITH sell_totals AS (
  SELECT attempt.position_id,
         SUM(attempt.input_amount_raw::numeric) AS sold_raw,
         SUM(orders.output_amount_raw::numeric
           / power(10::numeric, orders.output_decimals)) AS proceeds_native
  FROM trade_attempts AS attempt
  JOIN trade_orders AS orders ON orders.attempt_id = attempt.id
  WHERE attempt.side = 'sell'
    AND attempt.status = 'confirmed'
    AND orders.normalized_status = 'confirmed'
    AND attempt.position_id IS NOT NULL
    AND attempt.input_amount_raw ~ '^\d+$'
    AND orders.output_amount_raw ~ '^\d+$'
    AND orders.output_decimals IS NOT NULL
  GROUP BY attempt.position_id
), lot_realized AS (
  SELECT lot.id,
         COALESCE(lot.cost_native, 0)
           * (lot.opened_amount_raw::numeric - lot.remaining_amount_raw::numeric)
           / NULLIF(lot.opened_amount_raw::numeric, 0) AS realized_cost,
         totals.proceeds_native
           * (lot.opened_amount_raw::numeric - lot.remaining_amount_raw::numeric)
           / NULLIF(totals.sold_raw, 0) AS realized_proceeds
  FROM position_lots AS lot
  JOIN sell_totals AS totals ON totals.position_id = lot.position_id
)
UPDATE position_lots AS lot
SET realized_cost_native = lot_realized.realized_cost,
    realized_proceeds_native = lot_realized.realized_proceeds,
    updated_at = NOW()
FROM lot_realized
WHERE lot.id = lot_realized.id;

WITH totals AS (
  SELECT position_id,
         COALESCE(SUM(realized_cost_native), 0) AS cost,
         COALESCE(SUM(realized_proceeds_native), 0) AS proceeds
  FROM position_lots
  GROUP BY position_id
)
UPDATE positions AS position
SET pnl = totals.proceeds - totals.cost,
    pnl_pct = CASE WHEN totals.cost > 0
      THEN (totals.proceeds - totals.cost) / totals.cost * 100
      ELSE NULL
    END,
    updated_at = NOW()
FROM totals
WHERE position.id = totals.position_id
  AND position.execution_mode = 'live';
