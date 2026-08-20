-- Timestamp for courier confirmation of an order/return transfer.
-- Used to open a warehouse alert if previous items are not scanned within 5 days.

ALTER TABLE return_pouches
  ADD COLUMN IF NOT EXISTS courier_confirmed_at TIMESTAMPTZ;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS courier_confirmed_at TIMESTAMPTZ;
