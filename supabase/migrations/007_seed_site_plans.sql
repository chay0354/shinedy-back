-- Public catalog packs (SILVER / DUO / GOLD) plus legacy ids still referenced by older rows.
-- Safe to re-run: ON CONFLICT upsert / DO NOTHING.

INSERT INTO plans (id, name, price, points, max_items, exchanges, shipping, tagline) VALUES
  ('silver', 'מסלול כסף', 199, 100, 2, 99, true, 'כסף וכסף מצופה זהב · אבני מויסנייט'),
  ('combined', 'מסלול משולב', 299, 170, 4, 99, true, 'כסף וזהב · יהלומי מעבדה קטנים'),
  ('gold', 'מסלול זהב', 499, 280, 6, 99, true, 'זהב · יהלומי מעבדה גדולים'),
  ('essentials', 'Essentials', 249, 400, 2, 1, false, 'להתחיל להתנסות'),
  ('signature', 'Signature', 449, 800, 4, 2, true, 'הבחירה הפופולרית'),
  ('prestige', 'Prestige', 749, 1400, 6, 4, true, 'לגרדרובה עשירה')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price = EXCLUDED.price,
  points = EXCLUDED.points,
  max_items = EXCLUDED.max_items,
  exchanges = EXCLUDED.exchanges,
  shipping = EXCLUDED.shipping,
  tagline = EXCLUDED.tagline;

INSERT INTO products (id, name, category, metal, stone, points, price) VALUES
  ('R21', 'טבעת אמה', 'טבעות', 'זהב צהוב', 'זירקון', 220, 1200),
  ('R34', 'טבעת נועה', 'טבעות', 'כסף', 'אבן ירח', 150, 780),
  ('N14', 'שרשרת ליה', 'שרשראות', 'זהב רוזה', 'פנינה', 300, 1600),
  ('N08', 'שרשרת תמר', 'שרשראות', 'כסף', 'ללא אבן', 180, 950),
  ('E08', 'עגילי מאיה', 'עגילים', 'זהב צהוב', 'יהלום מעבדה', 260, 1450),
  ('E19', 'עגילי רון', 'עגילים', 'כסף', 'אבן חן כחולה', 140, 690),
  ('B33', 'צמיד שני', 'צמידים', 'זהב רוזה', 'זירקון', 200, 1100),
  ('B12', 'צמיד עדן', 'צמידים', 'כסף', 'ללא אבן', 130, 620)
ON CONFLICT (id) DO NOTHING;
