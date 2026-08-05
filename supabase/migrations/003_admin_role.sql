-- Add role column for admin / warehouse access (safe if already exists)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'customer';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_role_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('customer', 'admin', 'warehouse'));
  END IF;
END $$;

UPDATE public.profiles
SET role = 'admin',
    subscribed = false,
    plan_id = NULL,
    points_balance = 0,
    cart = '[]'::jsonb,
    exchange_returns = '[]'::jsonb,
    exchange_cart = '[]'::jsonb,
    my_items = '[]'::jsonb
WHERE lower(email) = 'admin@gmail.com';
