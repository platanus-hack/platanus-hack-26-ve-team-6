CREATE TABLE gotchu.self_host_setup_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gotchu.self_host_setup_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.self_host_setup_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_self_host_setup ON gotchu.self_host_setup_tokens TO gotchu_owner USING (true) WITH CHECK (true);
REVOKE ALL ON gotchu.self_host_setup_tokens FROM PUBLIC,gotchu_api,gotchu_ingest,gotchu_coordinator,gotchu_executor,gotchu_validator;
CREATE TABLE gotchu.self_host_bootstrap_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  account_id uuid NOT NULL REFERENCES gotchu.local_accounts(id),
  organization_id uuid NOT NULL REFERENCES gotchu.organizations(id),
  completed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gotchu.self_host_bootstrap_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.self_host_bootstrap_state FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_self_host_bootstrap ON gotchu.self_host_bootstrap_state TO gotchu_owner USING (true) WITH CHECK (true);
REVOKE ALL ON gotchu.self_host_bootstrap_state FROM PUBLIC,gotchu_api,gotchu_ingest,gotchu_coordinator,gotchu_executor,gotchu_validator;

CREATE FUNCTION gotchu.self_host_issue_setup_token(p_hash text,p_expires_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_hash !~ '^[a-f0-9]{64}$' OR p_expires_at<=clock_timestamp() OR p_expires_at>clock_timestamp()+interval '1 hour 1 minute' THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(612481954);
  IF EXISTS (SELECT 1 FROM gotchu.self_host_bootstrap_state WHERE singleton) THEN RETURN false; END IF;
  DELETE FROM gotchu.self_host_setup_tokens WHERE consumed_at IS NULL;
  INSERT INTO gotchu.self_host_setup_tokens(token_hash,expires_at) VALUES(p_hash,p_expires_at)
    ON CONFLICT(token_hash) DO NOTHING;
  RETURN FOUND;
END $$;

CREATE FUNCTION gotchu.self_host_complete_setup(p_hash text,p_id uuid,p_email text,p_password_hash text,p_workspace text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account_id uuid; organization_id uuid;
BEGIN
  IF p_hash !~ '^[a-f0-9]{64}$' OR p_email<>lower(p_email) OR length(p_email) NOT BETWEEN 3 AND 254
    OR length(p_password_hash) NOT BETWEEN 100 AND 300 OR length(trim(p_workspace)) NOT BETWEEN 1 AND 200 THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(612481954);
  IF EXISTS (SELECT 1 FROM gotchu.self_host_bootstrap_state WHERE singleton) THEN RETURN NULL; END IF;
  -- The row lock makes concurrent setup submissions single-use.
  UPDATE gotchu.self_host_setup_tokens SET consumed_at=clock_timestamp()
    WHERE token_hash=p_hash AND consumed_at IS NULL AND expires_at>clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO gotchu.local_accounts(id,email,password_hash) VALUES(p_id,p_email,p_password_hash)
    ON CONFLICT(email) DO NOTHING RETURNING id INTO account_id;
  IF account_id IS NULL THEN RETURN NULL; END IF;
  organization_id:=gen_random_uuid();
  PERFORM set_config('gotchu.organization_id',organization_id::text,true);
  INSERT INTO gotchu.organizations(id,name) VALUES(organization_id,trim(p_workspace));
  INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES(organization_id,'credentials:'||account_id::text,'owner');
  INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id)
    VALUES(organization_id,gen_random_uuid(),'credentials:'||account_id::text,'workspace.created',organization_id);
  PERFORM set_config('gotchu.organization_id','00000000-0000-0000-0000-000000000000',true);
  INSERT INTO gotchu.self_host_bootstrap_state(singleton,account_id,organization_id) VALUES(true,account_id,organization_id);
  RETURN account_id;
END $$;
REVOKE ALL ON FUNCTION gotchu.self_host_issue_setup_token(text,timestamptz),gotchu.self_host_complete_setup(text,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.self_host_complete_setup(text,uuid,text,text,text) TO gotchu_api;
