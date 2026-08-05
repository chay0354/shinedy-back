-- Allow authenticated users to create and update their own orders and return pouches
CREATE POLICY "Users insert own orders" ON orders
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own orders" ON orders
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own pouches" ON return_pouches
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own pouches" ON return_pouches
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
