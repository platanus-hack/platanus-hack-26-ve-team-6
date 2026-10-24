-- Membership changes invalidate workspace-bound authorization state only.
-- Authentication factors and recovery codes belong to users across workspaces.
CREATE FUNCTION gotchu.auth_lookup_email(p_id uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT lower(a.email) FROM gotchu.local_accounts a WHERE a.id=p_id AND NOT a.disabled
$$;
REVOKE ALL ON FUNCTION gotchu.auth_lookup_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.auth_lookup_email(uuid) TO gotchu_api;

CREATE OR REPLACE FUNCTION gotchu.lock_membership(p_organization uuid,p_user text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() THEN RETURN NULL; END IF;
  BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('workspace-member:'||p_organization::text||':'||p_user,0));
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'workspace_membership_lock_timeout' USING ERRCODE='P0001';
  END;
  SELECT role INTO result FROM gotchu.memberships WHERE organization_id=p_organization AND user_id=p_user FOR SHARE;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION gotchu.workspace_member_change_role(p_organization uuid,p_user text,p_role text,p_actor text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_role text; owners integer;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() THEN RETURN 'not_found'; END IF;
  IF p_role NOT IN ('owner','operator','viewer') THEN RETURN 'invalid_role'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-members:'||p_organization::text,0));
  IF gotchu.lock_membership(p_organization,p_actor) IS DISTINCT FROM 'owner' THEN RETURN 'forbidden'; END IF;
  SELECT role INTO current_role FROM gotchu.memberships WHERE organization_id=p_organization AND user_id=p_user;
  IF current_role IS NULL THEN RETURN 'not_found'; END IF;
  IF current_role='owner' AND p_role<>'owner' THEN
    SELECT owner_count INTO owners FROM gotchu.organizations WHERE id=p_organization;
    IF owners<=1 THEN RETURN 'last_owner'; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-member:'||p_organization::text||':'||p_user,0));
  IF p_role='viewer' THEN
    UPDATE gotchu.step_up_challenges SET consumed_at=clock_timestamp() WHERE organization_id=p_organization AND user_id=p_user AND consumed_at IS NULL;
    UPDATE gotchu.step_up_proofs SET consumed_at=clock_timestamp() WHERE organization_id=p_organization AND user_id=p_user AND consumed_at IS NULL;
    UPDATE gotchu.approvals SET consumed_at=clock_timestamp() WHERE organization_id=p_organization AND user_id=p_user AND consumed_at IS NULL;
  END IF;
  UPDATE gotchu.memberships SET role=p_role WHERE organization_id=p_organization AND user_id=p_user;
  INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail)
    VALUES(p_organization,gen_random_uuid(),p_actor,'member.role_changed',NULL,jsonb_build_object('userId',p_user,'from',current_role,'to',p_role));
  RETURN 'ok';
END $$;

CREATE OR REPLACE FUNCTION gotchu.workspace_member_remove(p_organization uuid,p_user text,p_actor text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_role text; owners integer;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() THEN RETURN 'not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-members:'||p_organization::text,0));
  IF p_actor<>p_user AND gotchu.lock_membership(p_organization,p_actor) IS DISTINCT FROM 'owner' THEN RETURN 'forbidden'; END IF;
  SELECT role INTO current_role FROM gotchu.memberships WHERE organization_id=p_organization AND user_id=p_user;
  IF current_role IS NULL THEN RETURN 'not_found'; END IF;
  IF p_actor=p_user AND current_role='owner' THEN RETURN 'cannot_leave_as_owner'; END IF;
  IF current_role='owner' THEN
    SELECT owner_count INTO owners FROM gotchu.organizations WHERE id=p_organization;
    IF owners<=1 THEN RETURN 'last_owner'; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-member:'||p_organization::text||':'||p_user,0));
  UPDATE gotchu.step_up_challenges SET consumed_at=clock_timestamp() WHERE organization_id=p_organization AND user_id=p_user AND consumed_at IS NULL;
  UPDATE gotchu.step_up_proofs SET consumed_at=clock_timestamp() WHERE organization_id=p_organization AND user_id=p_user AND consumed_at IS NULL;
  UPDATE gotchu.approvals SET consumed_at=clock_timestamp() WHERE organization_id=p_organization AND user_id=p_user AND consumed_at IS NULL;
  DELETE FROM gotchu.memberships WHERE organization_id=p_organization AND user_id=p_user;
  INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail)
    VALUES(p_organization,gen_random_uuid(),p_actor,'member.removed',NULL,jsonb_build_object('userId',p_user,'role',current_role));
  RETURN 'ok';
END $$;
