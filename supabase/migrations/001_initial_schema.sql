-- Shinedy production schema
-- Apply via Supabase SQL editor or: supabase db push

-- Plans (catalog)
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price INT NOT NULL,
  points INT NOT NULL,
  max_items INT NOT NULL,
  exchanges INT NOT NULL,
  shipping BOOLEAN NOT NULL DEFAULT false,
  tagline TEXT
);

-- Products (catalog)
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  metal TEXT,
  stone TEXT,
  points INT NOT NULL,
  price INT NOT NULL
);

-- Inventory units
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES products(id),
  status TEXT NOT NULL DEFAULT 'זמין',
  demo_only BOOLEAN NOT NULL DEFAULT false,
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Customer profiles (extends auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin', 'warehouse')),
  registration_step INT NOT NULL DEFAULT 0,
  phone_verified BOOLEAN NOT NULL DEFAULT false,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  id_document_url TEXT,
  signature_completed BOOLEAN NOT NULL DEFAULT false,
  payment_method_added BOOLEAN NOT NULL DEFAULT false,
  plan_id TEXT REFERENCES plans(id),
  subscribed BOOLEAN NOT NULL DEFAULT false,
  points_balance INT NOT NULL DEFAULT 0,
  credits INT NOT NULL DEFAULT 180,
  cart JSONB NOT NULL DEFAULT '[]'::jsonb,
  exchange_returns JSONB NOT NULL DEFAULT '[]'::jsonb,
  exchange_cart JSONB NOT NULL DEFAULT '[]'::jsonb,
  my_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  flash TEXT,
  last_pouch_id TEXT,
  order_counter INT NOT NULL DEFAULT 1043,
  pouch_counter INT NOT NULL DEFAULT 9002,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'הזמנה',
  customer_name TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  return_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  new_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  order_date TEXT,
  qr TEXT,
  pouch_id TEXT
);

-- Return pouches
CREATE TABLE IF NOT EXISTS return_pouches (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  qr TEXT NOT NULL,
  order_id TEXT,
  customer_name TEXT,
  return_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  new_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'in_transit',
  scanned BOOLEAN NOT NULL DEFAULT false,
  created_at_label TEXT,
  demo_customer BOOLEAN NOT NULL DEFAULT true,
  pending_points INT NOT NULL DEFAULT 0,
  points_credited BOOLEAN NOT NULL DEFAULT false,
  inventory_cleared BOOLEAN NOT NULL DEFAULT false
);

-- Seed catalog
INSERT INTO plans (id, name, price, points, max_items, exchanges, shipping, tagline) VALUES
  ('essentials', 'Essentials', 249, 400, 2, 1, false, 'להתחיל להתנסות'),
  ('signature', 'Signature', 449, 800, 4, 2, true, 'הבחירה הפופולרית'),
  ('prestige', 'Prestige', 749, 1400, 6, 4, true, 'לגרדרובה עשירה')
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, name, category, metal, stone, points, price) VALUES
  ('R21', 'טבעת אמה', 'טבעות', 'זהב צהוב', 'זירקון', 220, 1200),
  ('R34', 'טבעת נועה', 'טבעות', 'כסף', 'אבן ירח', 150, 780),
  ('N14', 'שרשרת ליה', 'שרשראות', 'זהב רוזה', 'פנינה', 300, 1600),
  ('N08', 'שרשרת תמר', 'שרשראות', 'כסף', 'ללא אבן', 180, 950),
  ('E08', 'עגילי מאיה', 'עגילים', 'זהב צהוב', 'יהלום', 260, 1450),
  ('E19', 'עגילי רון', 'עגילים', 'כסף', 'אבן חן כחולה', 140, 690),
  ('B33', 'צמיד שני', 'צמידים', 'זהב רוזה', 'זירקון', 200, 1100),,
  ('B12', 'צמיד עדן', 'צמידים', 'כסף', 'ללא אבן', 130, 620)
ON CONFLICT (id) DO NOTHING;

-- Fix typo in B33 metal if re-run
UPDATE products SET metal = 'זהב רוזה' WHERE id = 'B33';

INSERT INTO units (id, model_id, status, demo_only) VALUES
  ('R21-1', 'R21', 'זמין', false), ('R21-2', 'R21', 'אצל לקוחה', false), ('R21-3', 'R21', 'בניקוי', false),
  ('R34-1', 'R34', 'זמין', false), ('R34-2', 'R34', 'זמין', false), ('R34-3', 'R34', 'בתיקון', false),
  ('N14-1', 'N14', 'זמין', false), ('N14-2', 'N14', 'שמור', false), ('N14-3', 'N14', 'אצל לקוחה', false),
  ('N08-1', 'N08', 'זמין', false), ('N08-2', 'N08', 'זמין', false), ('N08-3', 'N08', 'בדרך ללקוחה', false),
  ('E08-1', 'E08', 'זמין', false), ('E08-2', 'E08', 'בניקוי', false), ('E08-3', 'E08', 'זמין', false),
  ('E19-1', 'E19', 'זמין', false), ('E19-2', 'E19', 'אצל לקוחה', false), ('E19-3', 'E19', 'זמין', false),
  ('B33-1', 'B33', 'זמין', false), ('B33-2', 'B33', 'זמין', false), ('B33-3', 'B33', 'בדרך חזרה', false),
  ('B12-1', 'B12', 'זמין', false), ('B12-2', 'B12', 'זמין', false), ('B12-3', 'B12', 'שמור', false)
ON CONFLICT (id) DO NOTHING;

-- Seed demo warehouse return pouch (no user)
INSERT INTO return_pouches (id, user_id, qr, order_id, customer_name, return_items, status, created_at_label, demo_customer, pending_points)
VALUES ('POUCH-9001', NULL, 'QR-9001', 'ORD-SEED', 'נועה כהן', '["B33-3"]'::jsonb, 'in_transit', 'לפני יום', false, 200)
ON CONFLICT (id) DO NOTHING;

INSERT INTO orders (id, user_id, type, customer_name, items, status, order_date)
VALUES ('ORD-1041', NULL, 'הזמנה', 'נועה כהן', '["N08-3"]'::jsonb, 'אריזה', 'לפני 2 ימים')
ON CONFLICT (id) DO NOTHING;

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, phone)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_pouches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users read own orders" ON orders FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users read own pouches" ON return_pouches FOR SELECT USING (auth.uid() = user_id);

-- Catalog is public read
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE units ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read plans" ON plans FOR SELECT USING (true);
CREATE POLICY "Public read products" ON products FOR SELECT USING (true);
CREATE POLICY "Public read units" ON units FOR SELECT USING (true);
