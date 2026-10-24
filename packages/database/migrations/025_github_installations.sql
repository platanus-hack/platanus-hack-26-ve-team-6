CREATE TABLE gotchu.github_oauth_states (
  organization_id uuid NOT NULL REFERENCES gotchu.organizations(id),
  state_hash text NOT NULL CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 256),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, state_hash)
);
CREATE INDEX github_oauth_states_expiry ON gotchu.github_oauth_states(expires_at);
ALTER TABLE gotchu.github_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.github_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.github_oauth_states
  USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id());
CREATE POLICY state_hash_lookup ON gotchu.github_oauth_states TO gotchu_owner
  USING (current_setting('gotchu.github_state_lookup',true)='enabled');

CREATE TABLE gotchu.github_installations (
  organization_id uuid NOT NULL REFERENCES gotchu.organizations(id),
  installation_id text NOT NULL CHECK (installation_id ~ '^\d{1,20}$'),
  account_login text NOT NULL CHECK (length(account_login) BETWEEN 1 AND 100),
  connected_by text NOT NULL CHECK (length(connected_by) BETWEEN 1 AND 256),
  state text NOT NULL CHECK (state IN ('active','revoked')),
  connected_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (organization_id, installation_id)
);
CREATE UNIQUE INDEX github_installations_single_active_binding ON gotchu.github_installations(installation_id) WHERE state='active';
ALTER TABLE gotchu.github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.github_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.github_installations
  USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id());
CREATE POLICY installation_binding_lookup ON gotchu.github_installations TO gotchu_owner
  USING (current_setting('gotchu.github_installation_lookup',true)='enabled');
REVOKE ALL ON gotchu.github_installations FROM PUBLIC,gotchu_api,gotchu_executor,gotchu_coordinator,gotchu_ingest;
GRANT SELECT ON gotchu.github_installations TO gotchu_api;
ALTER TABLE gotchu.application_repository_links ADD COLUMN installation_id text;
ALTER TABLE gotchu.application_repository_links ADD CONSTRAINT application_repository_installation_fk
  FOREIGN KEY (organization_id,installation_id) REFERENCES gotchu.github_installations(organization_id,installation_id);
ALTER TABLE gotchu.application_repository_links ADD CONSTRAINT application_repository_installation_key CHECK
  (installation_id IS NULL OR repository_key LIKE 'gh-%');
ALTER TABLE gotchu.application_repository_links DROP CONSTRAINT application_repository_links_source_check;
ALTER TABLE gotchu.application_repository_links ADD CONSTRAINT application_repository_links_source_check
  CHECK (source IN ('customer_declared','signed_telemetry','operator','github_app'));

CREATE OR REPLACE FUNCTION gotchu.github_create_state(p_org uuid,p_user text,p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RETURN false; END IF;
  IF NOT gotchu.lock_customer_organization(p_org) THEN RETURN false; END IF;
  DELETE FROM gotchu.github_oauth_states WHERE organization_id=p_org AND expires_at<=clock_timestamp();
  INSERT INTO gotchu.github_oauth_states(organization_id,state_hash,user_id,expires_at) VALUES(p_org,p_hash,p_user,clock_timestamp()+interval '10 minutes');
  RETURN true;
END $$;
CREATE FUNCTION gotchu.github_consume_state(p_hash text,p_user text)
RETURNS TABLE(organization_id uuid,user_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE consumed_org uuid; previous_tenant text;
BEGIN
  PERFORM set_config('gotchu.github_state_lookup','enabled',true);
  DELETE FROM gotchu.github_oauth_states s WHERE s.state_hash=p_hash AND s.user_id=p_user
    AND s.expires_at>clock_timestamp() RETURNING s.organization_id,s.user_id INTO consumed_org,user_id;
  IF consumed_org IS NOT NULL THEN
    previous_tenant:=current_setting('gotchu.organization_id',true);
    PERFORM set_config('gotchu.organization_id',consumed_org::text,true);
    INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,detail) VALUES(consumed_org,gen_random_uuid(),p_user,'github.oauth_state_consumed','{}'::jsonb);
    PERFORM set_config('gotchu.organization_id',coalesce(previous_tenant,''),true);
    organization_id:=consumed_org;
    RETURN NEXT;
  END IF;
  PERFORM set_config('gotchu.github_state_lookup','',true);
END $$;
CREATE OR REPLACE FUNCTION gotchu.github_bind_installation(p_org uuid,p_user text,p_installation text,p_login text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing_org uuid; previous_org uuid; existing_role text;
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() THEN RETURN 'forbidden'; END IF;
  existing_role:=gotchu.lock_membership(p_org,p_user);
  IF coalesce(existing_role,'') NOT IN ('owner','operator') THEN RETURN 'forbidden'; END IF;
  IF NOT gotchu.lock_customer_organization(p_org) THEN RETURN 'not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('github-installation:'||p_installation,0));
  PERFORM set_config('gotchu.github_installation_lookup','enabled',true);
  SELECT organization_id INTO existing_org FROM gotchu.github_installations WHERE installation_id=p_installation AND state='active' FOR UPDATE;
  IF existing_org IS NULL THEN
    SELECT organization_id INTO previous_org FROM gotchu.github_installations WHERE installation_id=p_installation AND state='revoked' ORDER BY revoked_at DESC LIMIT 1;
  END IF;
  PERFORM set_config('gotchu.github_installation_lookup','',true);
  IF existing_org IS NOT NULL AND existing_org<>p_org THEN RETURN 'already_bound'; END IF;
  IF previous_org IS NOT NULL AND previous_org<>p_org AND existing_role<>'owner' THEN RETURN 'owner_required_to_move'; END IF;
  BEGIN
    INSERT INTO gotchu.github_installations(organization_id,installation_id,account_login,connected_by,state,revoked_at)
      VALUES(p_org,p_installation,p_login,p_user,'active',NULL)
      ON CONFLICT (organization_id,installation_id) DO UPDATE SET account_login=EXCLUDED.account_login,connected_by=EXCLUDED.connected_by,state='active',revoked_at=NULL;
  EXCEPTION WHEN unique_violation THEN
    RETURN 'already_bound';
  END;
  RETURN 'bound';
END $$;
CREATE OR REPLACE FUNCTION gotchu.github_revoke_installation(p_org uuid,p_user text,p_installation text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RETURN false; END IF;
  IF NOT gotchu.lock_customer_organization(p_org) THEN RETURN false; END IF;
  UPDATE gotchu.github_installations SET state='revoked',revoked_at=clock_timestamp() WHERE organization_id=p_org AND installation_id=p_installation AND state='active';
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE gotchu.application_repository_links SET revoked=true,read_access='revoked',state='unknown',installation_id=NULL
    WHERE organization_id=p_org AND installation_id=p_installation AND NOT revoked;
  RETURN true;
END $$;
CREATE OR REPLACE FUNCTION gotchu.github_create_repository_link(p_org uuid,p_app uuid,p_user text,p_installation text,p_id uuid,p_key text,p_branch text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing_id uuid; existing_installation text;
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RETURN NULL; END IF;
  IF NOT gotchu.lock_customer_organization(p_org) OR gotchu.lock_customer_application(p_org,p_app) IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM gotchu.github_installations WHERE organization_id=p_org AND installation_id=p_installation AND state='active') THEN RETURN NULL; END IF;
  SELECT id,installation_id INTO existing_id,existing_installation FROM gotchu.application_repository_links WHERE organization_id=p_org AND application_id=p_app AND repository_key=p_key FOR UPDATE;
  IF existing_id IS NOT NULL THEN
    IF existing_installation IS DISTINCT FROM p_installation THEN RETURN NULL; END IF;
    UPDATE gotchu.application_repository_links SET default_branch=p_branch,read_access='granted',revoked=false,state='declared'
      WHERE organization_id=p_org AND application_id=p_app AND id=existing_id;
    RETURN existing_id;
  END IF;
  IF (SELECT count(*) FROM gotchu.application_repository_links WHERE organization_id=p_org AND application_id=p_app)>=20 THEN RAISE EXCEPTION 'context_repository_limit'; END IF;
  INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,revoked,state,source,installation_id)
    VALUES(p_org,p_app,p_id,p_key,p_branch,'granted','not_granted',false,'declared','github_app',p_installation) RETURNING id INTO existing_id;
  RETURN existing_id;
END $$;
REVOKE ALL ON FUNCTION gotchu.github_create_state(uuid,text,text),gotchu.github_consume_state(text,text),gotchu.github_bind_installation(uuid,text,text,text),gotchu.github_revoke_installation(uuid,text,text),gotchu.github_create_repository_link(uuid,uuid,text,text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.github_create_state(uuid,text,text),gotchu.github_consume_state(text,text),gotchu.github_bind_installation(uuid,text,text,text),gotchu.github_revoke_installation(uuid,text,text),gotchu.github_create_repository_link(uuid,uuid,text,text,uuid,text,text) TO gotchu_api;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gotchu_owner') THEN
    GRANT SELECT,INSERT,DELETE ON gotchu.github_oauth_states TO gotchu_owner;
    GRANT SELECT,INSERT,UPDATE ON gotchu.github_installations TO gotchu_owner;
    GRANT UPDATE ON gotchu.application_repository_links TO gotchu_owner;
  END IF;
END $$;
