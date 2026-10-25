-- Disconnect revokes independent write consent and pending exact-action approvals atomically.
CREATE OR REPLACE FUNCTION gotchu.github_revoke_installation(p_org uuid,p_user text,p_installation text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE link record;
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RETURN false; END IF;
  IF NOT gotchu.lock_customer_organization(p_org) THEN RETURN false; END IF;
  UPDATE gotchu.github_installations SET state='revoked',revoked_at=clock_timestamp()
    WHERE organization_id=p_org AND installation_id=p_installation AND state='active';
  IF NOT FOUND THEN RETURN false; END IF;
  FOR link IN SELECT application_id,id FROM gotchu.application_repository_links
    WHERE organization_id=p_org AND installation_id=p_installation FOR UPDATE LOOP
    PERFORM gotchu.invalidate_repository_write_actions(p_org,link.application_id,link.id);
  END LOOP;
  UPDATE gotchu.application_repository_links SET revoked=true,read_access='revoked',state='unknown',installation_id=NULL,
    write_access='not_granted',writer_installation_id=NULL,writer_verified_at=NULL,writer_verified_commit=NULL
    WHERE organization_id=p_org AND installation_id=p_installation;
  RETURN true;
END $$;

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
    IF existing_revoked THEN
      PERFORM gotchu.invalidate_repository_write_actions(p_org,p_app,existing_id);
      UPDATE gotchu.application_repository_links SET write_access='not_granted',writer_installation_id=NULL,
        writer_verified_at=NULL,writer_verified_commit=NULL
        WHERE organization_id=p_org AND application_id=p_app AND id=existing_id;
    END IF;
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
