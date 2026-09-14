-- Private ID-document vault + access log + lock sensitive profile columns.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'id-documents',
  'id-documents',
  false,
  5000000,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET
  public = false,
  file_size_limit = 5000000,
  allowed_mime_types = ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];

DROP POLICY IF EXISTS "id docs public read" ON storage.objects;
DROP POLICY IF EXISTS "id docs auth read" ON storage.objects;
DROP POLICY IF EXISTS "id docs auth write" ON storage.objects;

-- No authenticated/anon policies: only the service role can read or write.

CREATE TABLE IF NOT EXISTS id_document_access_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL DEFAULT 'view',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE id_document_access_log ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION protect_sensitive_profile_cols()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF coalesce(auth.role(), '') = 'authenticated' THEN
    NEW.id_document_url := OLD.id_document_url;
    NEW.national_id := OLD.national_id;
    NEW.signature_data := OLD.signature_data;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_sensitive_profile_cols ON profiles;
CREATE TRIGGER protect_sensitive_profile_cols
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION protect_sensitive_profile_cols();
