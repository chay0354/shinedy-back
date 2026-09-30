-- Customer favorites per model, so staff can see demand per product.
CREATE TABLE IF NOT EXISTS favorites (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS favorites_product_idx ON favorites (product_id);

-- Only the server (service role) reads or writes favorites.
ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;
