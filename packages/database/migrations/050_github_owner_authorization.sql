-- Installation visibility did not prove authority to delegate all installed repositories.
-- Discard legacy handshakes and require fresh owner consent for existing connections.
SET LOCAL gotchu.github_state_lookup = 'enabled';
DELETE FROM gotchu.github_oauth_states;
SET LOCAL gotchu.github_state_lookup = '';
SET LOCAL gotchu.github_installation_lookup = 'enabled';
CREATE POLICY github_reauthorization_audit ON gotchu.audit_records
  FOR INSERT TO gotchu_owner WITH CHECK (true);
INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,detail)
SELECT organization_id,gen_random_uuid(),'system:migration','github.reauthorization_required',
  jsonb_build_object('installationId',installation_id)
FROM gotchu.github_installations WHERE state='active';
DROP POLICY github_reauthorization_audit ON gotchu.audit_records;
UPDATE gotchu.github_installations SET state='revoked',revoked_at=clock_timestamp() WHERE state='active';
SET LOCAL gotchu.github_installation_lookup = '';

CREATE POLICY github_reauthorization_migration ON gotchu.application_repository_links
  TO gotchu_owner USING (true) WITH CHECK (true);
UPDATE gotchu.proposals p SET state='invalidated',invalidated_at=clock_timestamp(),
  invalidation_reason='github_reauthorization_required',
  blocking_reasons='["Vuelve a autorizar GitHub y prepara una propuesta nueva."]'::jsonb
WHERE p.state IN ('proposed','eligible','ineligible','approved') AND EXISTS (
  SELECT 1 FROM gotchu.application_repository_links l
  WHERE l.organization_id=p.organization_id AND l.application_id=p.application_id AND l.source='github_app');
CREATE POLICY github_reauthorization_approvals ON gotchu.approvals
  TO gotchu_owner USING (true) WITH CHECK (true);
UPDATE gotchu.approvals a SET consumed_at=coalesce(consumed_at,clock_timestamp())
WHERE EXISTS (SELECT 1 FROM gotchu.proposals p WHERE p.organization_id=a.organization_id
  AND p.id=a.proposal_id AND p.invalidation_reason='github_reauthorization_required');
DROP POLICY github_reauthorization_approvals ON gotchu.approvals;
UPDATE gotchu.application_repository_links SET revoked=true,read_access='revoked',state='unknown',
  installation_id=NULL,write_access='not_granted',writer_installation_id=NULL,
  writer_verified_at=NULL,writer_verified_commit=NULL WHERE source='github_app';
DROP POLICY github_reauthorization_migration ON gotchu.application_repository_links;

ALTER TABLE gotchu.github_oauth_states
  ADD COLUMN pkce_verifier text CHECK (pkce_verifier ~ '^[A-Za-z0-9_-]{43}$'),
  ADD COLUMN installation_id text CHECK (installation_id ~ '^[0-9]{1,20}$'),
  ADD COLUMN purpose text NOT NULL DEFAULT 'install' CHECK (purpose IN ('install','authorize','choose')),
  ADD CONSTRAINT github_pkce_required CHECK (purpose<>'authorize' OR pkce_verifier IS NOT NULL);

CREATE FUNCTION gotchu.github_create_state(p_org uuid,p_user text,p_hash text,p_verifier text,p_installation text,p_purpose text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_purpose NOT IN ('install','authorize','choose') OR (p_purpose='authorize' AND p_verifier IS NULL) THEN RETURN false; END IF;
  IF NOT gotchu.github_create_state(p_org,p_user,p_hash) THEN RETURN false; END IF;
  UPDATE gotchu.github_oauth_states SET pkce_verifier=p_verifier,installation_id=p_installation,purpose=p_purpose
    WHERE organization_id=p_org AND state_hash=p_hash AND user_id=p_user;
  RETURN true;
END $$;
DROP FUNCTION gotchu.github_consume_state(text,text);
CREATE FUNCTION gotchu.github_consume_state(p_hash text,p_user text)
RETURNS TABLE(organization_id uuid,user_id text,pkce_verifier text,installation_id text,purpose text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE consumed_org uuid; previous_tenant text;
BEGIN
  PERFORM set_config('gotchu.github_state_lookup','enabled',true);
  DELETE FROM gotchu.github_oauth_states s WHERE s.state_hash=p_hash AND s.user_id=p_user
    AND s.expires_at>clock_timestamp()
    RETURNING s.organization_id,s.user_id,s.pkce_verifier,s.installation_id,s.purpose
    INTO consumed_org,user_id,pkce_verifier,installation_id,purpose;
  IF consumed_org IS NOT NULL THEN
    previous_tenant:=current_setting('gotchu.organization_id',true);
    PERFORM set_config('gotchu.organization_id',consumed_org::text,true);
    INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,detail)
      VALUES(consumed_org,gen_random_uuid(),p_user,'github.oauth_state_consumed','{}'::jsonb);
    PERFORM set_config('gotchu.organization_id',coalesce(previous_tenant,''),true);
    organization_id:=consumed_org;
    RETURN NEXT;
  END IF;
  PERFORM set_config('gotchu.github_state_lookup','',true);
END $$;
REVOKE ALL ON FUNCTION gotchu.github_create_state(uuid,text,text,text,text,text),gotchu.github_consume_state(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.github_create_state(uuid,text,text,text,text,text),gotchu.github_consume_state(text,text) TO gotchu_api;

-- Reconnecting may restore a previously revoked GitHub link, never its write grants.
CREATE OR REPLACE FUNCTION gotchu.github_create_repository_link(p_org uuid,p_app uuid,p_user text,p_installation text,p_id uuid,p_key text,p_branch text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing_id uuid; existing_installation text; existing_revoked boolean; existing_source text;
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RETURN NULL; END IF;
  IF NOT gotchu.lock_customer_organization(p_org) OR gotchu.lock_customer_application(p_org,p_app) IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM gotchu.github_installations WHERE organization_id=p_org AND installation_id=p_installation AND state='active' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT id,installation_id,revoked,source INTO existing_id,existing_installation,existing_revoked,existing_source
    FROM gotchu.application_repository_links WHERE organization_id=p_org AND application_id=p_app AND repository_key=p_key FOR UPDATE;
  IF existing_id IS NOT NULL THEN
    IF existing_installation IS DISTINCT FROM p_installation
      AND NOT (existing_installation IS NULL AND existing_revoked AND existing_source='github_app') THEN RETURN NULL; END IF;
    UPDATE gotchu.application_repository_links SET installation_id=p_installation,default_branch=p_branch,
      read_access='granted',revoked=false,state='declared'
      WHERE organization_id=p_org AND application_id=p_app AND id=existing_id;
    RETURN existing_id;
  END IF;
  IF (SELECT count(*) FROM gotchu.application_repository_links WHERE organization_id=p_org AND application_id=p_app)>=20 THEN RAISE EXCEPTION 'context_repository_limit'; END IF;
  INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,revoked,state,source,installation_id)
    VALUES(p_org,p_app,p_id,p_key,p_branch,'granted','not_granted',false,'declared','github_app',p_installation) RETURNING id INTO existing_id;
  RETURN existing_id;
END $$;
