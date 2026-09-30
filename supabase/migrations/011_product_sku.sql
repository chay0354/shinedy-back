-- Model number (מק״ט דגם) stored on the product so every admin sees the same code.
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT;

UPDATE products SET sku = id WHERE sku IS NULL OR sku = '';

CREATE UNIQUE INDEX IF NOT EXISTS products_sku_unique ON products (upper(sku));
