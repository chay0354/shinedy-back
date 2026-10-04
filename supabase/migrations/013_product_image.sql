-- Product photo path, served from the site (for example /catalog/RCV1702.jpg).
ALTER TABLE products ADD COLUMN IF NOT EXISTS image TEXT;
