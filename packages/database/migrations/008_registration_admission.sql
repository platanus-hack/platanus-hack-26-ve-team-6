-- Admission is committed before expensive password hashing by the auth service.
-- This narrow insertion primitive remains private to the trusted API role.
CREATE OR REPLACE FUNCTION gotchu.auth_create_account(p_id uuid,p_email text,p_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE created_id uuid;
BEGIN
  INSERT INTO gotchu.local_accounts(id,email,password_hash) VALUES(p_id,p_email,p_hash)
    ON CONFLICT(email) DO NOTHING RETURNING id INTO created_id;
  RETURN created_id;
END $$;
