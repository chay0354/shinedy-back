-- Optional profile fields for plan-change, credits, saved checkout details.
-- Safe to re-run: IF NOT EXISTS / additive columns only.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS credits_used INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subscribed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS address JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS payment JSONB;

UPDATE products SET stone = 'יהלום מעבדה' WHERE id = 'E08' AND stone = 'יהלום';

UPDATE profiles
  SET subscribed_at = created_at
  WHERE subscribed IS TRUE AND subscribed_at IS NULL;

