-- Global identity data is private, never selected through customer routes.
CREATE TABLE gotchu.local_accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254 AND email=lower(email)),
  password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 100 AND 300),
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch>0),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gotchu.local_auth_limits (
  bucket text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK(attempts>=0)
);
ALTER TABLE gotchu.local_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.local_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE gotchu.local_auth_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.local_auth_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_identity ON gotchu.local_accounts TO gotchu_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_auth_limits ON gotchu.local_auth_limits TO gotchu_owner USING (true) WITH CHECK (true);
REVOKE ALL ON gotchu.local_accounts,gotchu.local_auth_limits FROM PUBLIC,gotchu_api,gotchu_ingest,gotchu_coordinator,gotchu_executor;

CREATE FUNCTION gotchu.auth_admit(p_bucket text,p_limit integer,p_window integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE count_now integer;
BEGIN
  IF p_bucket !~ '^(login|register):(global|[a-f0-9]{64})$' OR p_limit NOT BETWEEN 1 AND 100 OR p_window NOT BETWEEN 1 AND 3600 THEN RETURN false; END IF;
  INSERT INTO gotchu.local_auth_limits(bucket,started_at,attempts) VALUES(p_bucket,clock_timestamp(),1)
  ON CONFLICT(bucket) DO UPDATE SET
    started_at=CASE WHEN gotchu.local_auth_limits.started_at<=clock_timestamp()-make_interval(secs=>p_window) THEN clock_timestamp() ELSE gotchu.local_auth_limits.started_at END,
    attempts=CASE WHEN gotchu.local_auth_limits.started_at<=clock_timestamp()-make_interval(secs=>p_window) THEN 1 ELSE LEAST(gotchu.local_auth_limits.attempts+1,1000000) END
  RETURNING attempts INTO count_now;
  -- Delete only expired limiter state; retained accounts and sessions are unaffected.
  DELETE FROM gotchu.local_auth_limits WHERE started_at<clock_timestamp()-interval '2 hours';
  RETURN count_now<=p_limit;
END $$;
CREATE FUNCTION gotchu.auth_create_account(p_id uuid,p_email text,p_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE created_id uuid;
BEGIN
  -- Registration admission is enforced in addition to the application boundary.
  IF NOT gotchu.auth_admit('register:global',10,3600) THEN RETURN NULL; END IF;
  INSERT INTO gotchu.local_accounts(id,email,password_hash) VALUES(p_id,p_email,p_hash)
    ON CONFLICT(email) DO NOTHING RETURNING id INTO created_id;
  RETURN created_id;
END $$;
CREATE FUNCTION gotchu.auth_lookup(p_email text) RETURNS TABLE(id uuid,password_hash text,epoch integer)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT a.id,a.password_hash,a.epoch FROM gotchu.local_accounts a WHERE a.email=p_email AND NOT a.disabled
$$;
CREATE FUNCTION gotchu.auth_epoch(p_id uuid) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT a.epoch FROM gotchu.local_accounts a WHERE a.id=p_id AND NOT a.disabled
$$;
REVOKE ALL ON FUNCTION gotchu.auth_admit(text,integer,integer),gotchu.auth_create_account(uuid,text,text),gotchu.auth_lookup(text),gotchu.auth_epoch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.auth_admit(text,integer,integer),gotchu.auth_create_account(uuid,text,text),gotchu.auth_lookup(text),gotchu.auth_epoch(uuid) TO gotchu_api;
