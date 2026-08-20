-- Signup legal: national ID, electronic signature, acceptance timestamps, IP.
-- Safe to re-run: IF NOT EXISTS / additive columns only.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS national_id TEXT,
  ADD COLUMN IF NOT EXISTS signature_data TEXT,
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notices_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signup_ip TEXT;
