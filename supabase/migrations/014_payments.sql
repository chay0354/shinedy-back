-- Card payments through Hyp: pending payment-page checkouts and saved-card charges.
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'page',
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  intent JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_trans_id TEXT,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payments_trans_idx ON payments (provider_trans_id)
  WHERE provider_trans_id IS NOT NULL;

-- Only the server (service role) reads or writes payments.
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
