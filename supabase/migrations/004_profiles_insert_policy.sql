-- Allow authenticated users to insert their own profile (backup if trigger lags)
CREATE POLICY "Users insert own profile" ON profiles
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id);

-- Units: allow authenticated updates only for units they own (server still uses secret key)
CREATE POLICY "Users update own units" ON units
  FOR UPDATE TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY "Users insert own units" ON units
  FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = auth.uid());
