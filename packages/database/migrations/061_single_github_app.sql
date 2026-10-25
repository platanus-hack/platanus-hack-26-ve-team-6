-- A legacy reader/writer pair cannot silently acquire single-App authority.
ALTER TABLE gotchu.github_installations
  ADD COLUMN connection_mode text NOT NULL DEFAULT 'legacy' CHECK(connection_mode IN ('legacy','single_app')),
  ADD COLUMN app_id text CHECK(app_id ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT github_connection_app_identity CHECK((connection_mode='single_app')=(app_id IS NOT NULL));
ALTER TABLE gotchu.github_oauth_states ADD COLUMN app_id text CHECK(app_id ~ '^[0-9]{1,20}$');
SET LOCAL gotchu.github_state_lookup='enabled';
DELETE FROM gotchu.github_oauth_states;
SET LOCAL gotchu.github_state_lookup='';
SET LOCAL gotchu.github_installation_lookup='enabled';
DO $$ DECLARE installation record; link record;
BEGIN
  FOR installation IN SELECT organization_id,installation_id FROM gotchu.github_installations LOOP
    PERFORM set_config('gotchu.organization_id',installation.organization_id::text,true);
    FOR link IN SELECT application_id,id FROM gotchu.application_repository_links
      WHERE organization_id=installation.organization_id AND installation_id=installation.installation_id LOOP
      PERFORM gotchu.invalidate_repository_write_actions(installation.organization_id,link.application_id,link.id);
    END LOOP;
    UPDATE gotchu.application_repository_links SET revoked=true,read_access='revoked',state='unknown',installation_id=NULL,
      write_access='not_granted',writer_installation_id=NULL,writer_verified_at=NULL,writer_verified_commit=NULL
      WHERE organization_id=installation.organization_id AND installation_id=installation.installation_id;
    UPDATE gotchu.github_installations SET state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE organization_id=installation.organization_id AND installation_id=installation.installation_id;
    INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,detail)
      VALUES(installation.organization_id,gen_random_uuid(),'system:migration','github.single_app_reconnection_required',
        jsonb_build_object('installationId',installation.installation_id));
  END LOOP;
  PERFORM set_config('gotchu.organization_id','',true);
END $$;
SET LOCAL gotchu.github_installation_lookup='';

CREATE FUNCTION gotchu.github_create_single_app_state(p_org uuid,p_user text,p_hash text,p_verifier text,p_installation text,p_purpose text,p_app_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_app_id IS NULL OR p_app_id !~ '^[0-9]{1,20}$' THEN RETURN false; END IF;
  IF NOT gotchu.github_create_state(p_org,p_user,p_hash,p_verifier,p_installation,p_purpose) THEN RETURN false; END IF;
  UPDATE gotchu.github_oauth_states SET app_id=p_app_id WHERE organization_id=p_org AND state_hash=p_hash AND user_id=p_user;
  RETURN true;
END $$;

-- Internal shared implementation; only wrappers with fixed permissions are callable.
CREATE FUNCTION gotchu.github_consume_app_state(p_hash text,p_user text,p_app_id text,p_allow_oauth boolean)
RETURNS TABLE(organization_id uuid,user_id text,pkce_verifier text,installation_id text,purpose text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE consumed_org uuid; previous_tenant text;
BEGIN
  PERFORM set_config('gotchu.github_state_lookup','enabled',true);
  SELECT s.organization_id INTO consumed_org FROM gotchu.github_oauth_states s
    WHERE s.state_hash=p_hash AND s.user_id=p_user AND s.app_id IS NOT DISTINCT FROM p_app_id
      AND (p_app_id IS NULL OR p_allow_oauth OR s.purpose<>'authorize') AND s.expires_at>clock_timestamp();
  PERFORM set_config('gotchu.github_state_lookup','',true);
  IF consumed_org IS NULL THEN RETURN; END IF;
  previous_tenant:=current_setting('gotchu.organization_id',true);
  PERFORM set_config('gotchu.organization_id',consumed_org::text,true);
  IF coalesce(gotchu.lock_membership(consumed_org,p_user),'') IN ('owner','operator')
    AND gotchu.lock_customer_organization(consumed_org) THEN
    DELETE FROM gotchu.github_oauth_states s WHERE s.organization_id=consumed_org AND s.state_hash=p_hash AND s.user_id=p_user
      AND s.app_id IS NOT DISTINCT FROM p_app_id AND s.expires_at>clock_timestamp()
      AND (p_app_id IS NULL OR p_allow_oauth OR s.purpose<>'authorize')
      RETURNING s.organization_id,s.user_id,s.pkce_verifier,s.installation_id,s.purpose
      INTO organization_id,user_id,pkce_verifier,installation_id,purpose;
    IF FOUND THEN
      INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,detail)
        VALUES(consumed_org,gen_random_uuid(),p_user,'github.oauth_state_consumed',jsonb_build_object('appId',p_app_id));
      RETURN NEXT;
    END IF;
  END IF;
  PERFORM set_config('gotchu.organization_id',coalesce(previous_tenant,''),true);
END $$;
CREATE OR REPLACE FUNCTION gotchu.github_consume_state(p_hash text,p_user text)
RETURNS TABLE(organization_id uuid,user_id text,pkce_verifier text,installation_id text,purpose text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT * FROM gotchu.github_consume_app_state(p_hash,p_user,NULL,false)
$$;
CREATE FUNCTION gotchu.github_consume_public_state(p_hash text,p_user text,p_app_id text)
RETURNS TABLE(organization_id uuid,user_id text,pkce_verifier text,installation_id text,purpose text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT * FROM gotchu.github_consume_app_state(p_hash,p_user,p_app_id,false) WHERE p_app_id IS NOT NULL
$$;
CREATE FUNCTION gotchu.github_consume_single_app_state(p_hash text,p_user text,p_app_id text)
RETURNS TABLE(organization_id uuid,user_id text,pkce_verifier text,installation_id text,purpose text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT * FROM gotchu.github_consume_app_state(p_hash,p_user,p_app_id,true) WHERE p_app_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION gotchu.github_consume_app_state(text,text,text,boolean),gotchu.github_create_single_app_state(uuid,text,text,text,text,text,text),
  gotchu.github_consume_public_state(text,text,text),gotchu.github_consume_single_app_state(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.github_create_single_app_state(uuid,text,text,text,text,text,text),gotchu.github_consume_public_state(text,text,text) TO gotchu_api;
GRANT EXECUTE ON FUNCTION gotchu.github_consume_single_app_state(text,text,text) TO gotchu_executor;

-- Reuse the installation advisory lock, exclusive binding and Owner-only move rule.
ALTER FUNCTION gotchu.github_bind_installation(uuid,text,text,text) RENAME TO github_bind_legacy_installation;
REVOKE ALL ON FUNCTION gotchu.github_bind_legacy_installation(uuid,text,text,text) FROM PUBLIC,gotchu_api;
CREATE FUNCTION gotchu.github_bind_installation(p_org uuid,p_user text,p_installation text,p_login text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() THEN RETURN 'forbidden'; END IF;
  IF coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator')
    OR NOT gotchu.lock_customer_organization(p_org) THEN RETURN 'forbidden'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('github-installation:'||p_installation,0));
  PERFORM set_config('gotchu.github_installation_lookup','enabled',true);
  IF EXISTS(SELECT 1 FROM gotchu.github_installations WHERE installation_id=p_installation AND connection_mode='single_app') THEN
    PERFORM set_config('gotchu.github_installation_lookup','',true);
    RETURN 'reconnection_required';
  END IF;
  PERFORM set_config('gotchu.github_installation_lookup','',true);
  RETURN gotchu.github_bind_legacy_installation(p_org,p_user,p_installation,p_login);
END $$;
CREATE FUNCTION gotchu.github_bind_single_app(p_org uuid,p_user text,p_installation text,p_login text,p_app_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() OR p_app_id IS NULL OR p_app_id !~ '^[0-9]{1,20}$' THEN RETURN 'forbidden'; END IF;
  IF coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator')
    OR NOT gotchu.lock_customer_organization(p_org) THEN RETURN 'forbidden'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('github-installation:'||p_installation,0));
  IF EXISTS(SELECT 1 FROM gotchu.github_installations WHERE organization_id=p_org AND installation_id=p_installation
    AND state='active' AND (connection_mode<>'single_app' OR app_id IS DISTINCT FROM p_app_id)) THEN RETURN 'reconnection_required'; END IF;
  result:=gotchu.github_bind_legacy_installation(p_org,p_user,p_installation,p_login);
  IF result='bound' THEN
    UPDATE gotchu.github_installations SET connection_mode='single_app',app_id=p_app_id
      WHERE organization_id=p_org AND installation_id=p_installation;
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION gotchu.github_bind_installation(uuid,text,text,text),gotchu.github_bind_single_app(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.github_bind_installation(uuid,text,text,text) TO gotchu_api;
GRANT EXECUTE ON FUNCTION gotchu.github_bind_single_app(uuid,text,text,text,text) TO gotchu_executor;
GRANT SELECT(connection_mode,app_id) ON gotchu.github_installations TO gotchu_executor;

-- LIST is authorized before a repository link exists; status may omit application.
CREATE FUNCTION gotchu.github_single_app_installation(p_org uuid,p_application uuid,p_installation text,p_app_id text)
RETURNS TABLE(installation_id text,app_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE application jsonb;
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() OR NOT gotchu.lock_customer_organization(p_org) THEN RETURN; END IF;
  IF p_application IS NOT NULL THEN
    application:=gotchu.lock_customer_application(p_org,p_application);
    IF application IS NULL OR (application->>'archived')::boolean THEN RETURN; END IF;
  END IF;
  RETURN QUERY SELECT g.installation_id,g.app_id FROM gotchu.github_installations g
    WHERE g.organization_id=p_org AND g.installation_id=p_installation AND g.state='active'
      AND g.connection_mode='single_app' AND g.app_id=p_app_id FOR SHARE;
END $$;
CREATE FUNCTION gotchu.github_single_app_repository(p_org uuid,p_application uuid,p_link uuid,p_app_id text)
RETURNS TABLE(repository_link_id uuid,repository_id text,repository_key text,default_branch text,installation_id text,app_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE linked_installation text;
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() THEN RETURN; END IF;
  SELECT l.installation_id INTO linked_installation FROM gotchu.application_repository_links l
    WHERE l.organization_id=p_org AND l.application_id=p_application AND l.id=p_link;
  IF linked_installation IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM gotchu.github_single_app_installation(p_org,p_application,linked_installation,p_app_id);
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT l.id,substr(l.repository_key,4),l.repository_key,l.default_branch,g.installation_id,g.app_id
    FROM gotchu.application_repository_links l JOIN gotchu.github_installations g
      ON g.organization_id=l.organization_id AND g.installation_id=l.installation_id
    WHERE l.organization_id=p_org AND l.application_id=p_application AND l.id=p_link AND NOT l.revoked
      AND l.read_access='granted' AND l.source='github_app' AND l.repository_key ~ '^gh-[0-9]{1,20}$'
      AND g.installation_id=linked_installation AND g.state='active' AND g.connection_mode='single_app' AND g.app_id=p_app_id
    FOR SHARE OF l;
END $$;
REVOKE ALL ON FUNCTION gotchu.github_single_app_installation(uuid,uuid,text,text),gotchu.github_single_app_repository(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.github_single_app_installation(uuid,uuid,text,text),gotchu.github_single_app_repository(uuid,uuid,uuid,text) TO gotchu_api,gotchu_executor;

ALTER TABLE gotchu.customer_source_repository_bindings
  ADD COLUMN app_id text CHECK(app_id ~ '^[0-9]{1,20}$'),
  ADD COLUMN installation_id text CHECK(installation_id ~ '^[0-9]{1,20}$'),
  ADD COLUMN repository_id text CHECK(repository_id ~ '^[0-9]{1,20}$'),
  ADD COLUMN tree_sha text CHECK(tree_sha ~ '^[a-f0-9]{40}$'),
  ADD CONSTRAINT captured_source_identity_complete CHECK(
    (app_id IS NULL AND installation_id IS NULL AND repository_id IS NULL AND tree_sha IS NULL) OR
    (app_id IS NOT NULL AND installation_id IS NOT NULL AND repository_id IS NOT NULL AND tree_sha IS NOT NULL));

-- Called only after the trusted API service validates canonical stored source bytes.
CREATE FUNCTION gotchu.github_import_captured_source(p_org uuid,p_application uuid,p_user text,p_link uuid,p_source uuid,
  p_app_id text,p_installation text,p_repository text,p_commit text,p_tree text,p_digest text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE repository record; source_row gotchu.customer_sources; binding gotchu.customer_source_repository_bindings;
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RETURN false; END IF;
  SELECT * INTO repository FROM gotchu.github_single_app_repository(p_org,p_application,p_link,p_app_id);
  IF NOT FOUND OR repository.installation_id IS DISTINCT FROM p_installation OR repository.repository_id IS DISTINCT FROM p_repository THEN RETURN false; END IF;
  SELECT * INTO source_row FROM gotchu.customer_sources WHERE organization_id=p_org AND application_id=p_application AND id=p_source FOR UPDATE;
  IF NOT FOUND OR source_row.deleted_at IS NOT NULL OR source_row.body IS NULL OR source_row.digest IS DISTINCT FROM p_digest
    OR source_row.body->>'revision' IS DISTINCT FROM p_commit THEN RETURN false; END IF;
  INSERT INTO gotchu.customer_source_repository_bindings(organization_id,application_id,source_id,repository_link_id,commit_sha,source_digest,app_id,installation_id,repository_id,tree_sha)
    VALUES(p_org,p_application,p_source,p_link,p_commit,p_digest,p_app_id,p_installation,p_repository,p_tree)
    ON CONFLICT(organization_id,application_id,source_id) DO NOTHING;
  SELECT * INTO binding FROM gotchu.customer_source_repository_bindings WHERE organization_id=p_org AND application_id=p_application AND source_id=p_source;
  IF binding.repository_link_id IS DISTINCT FROM p_link OR binding.commit_sha IS DISTINCT FROM p_commit OR binding.source_digest IS DISTINCT FROM p_digest
    OR binding.app_id IS DISTINCT FROM p_app_id OR binding.installation_id IS DISTINCT FROM p_installation
    OR binding.repository_id IS DISTINCT FROM p_repository OR binding.tree_sha IS DISTINCT FROM p_tree THEN RETURN false; END IF;
  UPDATE gotchu.application_repository_links SET state='verified' WHERE organization_id=p_org AND application_id=p_application AND id=p_link;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION gotchu.github_import_captured_source(uuid,uuid,text,uuid,uuid,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.github_import_captured_source(uuid,uuid,text,uuid,uuid,text,text,text,text,text,text) TO gotchu_api;
GRANT SELECT(app_id,installation_id,repository_id,tree_sha) ON gotchu.customer_source_repository_bindings TO gotchu_executor;
