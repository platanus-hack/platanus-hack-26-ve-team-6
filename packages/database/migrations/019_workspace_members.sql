ALTER TABLE gotchu.memberships ADD COLUMN joined_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE gotchu.memberships ADD COLUMN email text CHECK (email IS NULL OR (length(email) BETWEEN 3 AND 254 AND email=lower(email)));
ALTER TABLE gotchu.organizations ADD COLUMN owner_count integer NOT NULL DEFAULT 0 CHECK (owner_count>=0);
UPDATE gotchu.organizations o SET owner_count=(SELECT count(*)::int FROM gotchu.memberships m WHERE m.organization_id=o.id AND m.role='owner');

CREATE FUNCTION gotchu.track_workspace_owner_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE organization uuid; delta integer; previous_tenant text;
BEGIN
  organization := CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  delta := CASE
    WHEN TG_OP='INSERT' AND NEW.role='owner' THEN 1
    WHEN TG_OP='DELETE' AND OLD.role='owner' THEN -1
    WHEN TG_OP='UPDATE' AND OLD.role='owner' AND NEW.role<>'owner' THEN -1
    WHEN TG_OP='UPDATE' AND OLD.role<>'owner' AND NEW.role='owner' THEN 1
    ELSE 0 END;
  IF delta=0 THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  previous_tenant := current_setting('gotchu.organization_id',true);
  PERFORM set_config('gotchu.organization_id',organization::text,true);
  IF delta<0 THEN
    UPDATE gotchu.organizations SET owner_count=owner_count+delta WHERE id=organization AND owner_count>1;
    IF NOT FOUND THEN RAISE EXCEPTION 'workspace_last_owner' USING ERRCODE='P0001'; END IF;
  ELSE
    UPDATE gotchu.organizations SET owner_count=owner_count+delta WHERE id=organization;
    IF NOT FOUND THEN RAISE EXCEPTION 'workspace_missing'; END IF;
  END IF;
  PERFORM set_config('gotchu.organization_id',coalesce(previous_tenant,''),true);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_owner_count AFTER INSERT OR UPDATE OF role OR DELETE ON gotchu.memberships
  FOR EACH ROW EXECUTE FUNCTION gotchu.track_workspace_owner_count();

-- A per-member advisory lock makes the authorization and revocation lock order
-- consistent, including executor paths that lock an approval before membership.
CREATE OR REPLACE FUNCTION gotchu.lock_membership(p_organization uuid,p_user text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() THEN RETURN NULL; END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('workspace-member:'||p_organization::text||':'||p_user,0)) THEN RETURN NULL; END IF;
  SELECT role INTO result FROM gotchu.memberships WHERE organization_id=p_organization AND user_id=p_user FOR SHARE;
  RETURN result;
END $$;

CREATE TABLE gotchu.workspace_invitations (
  organization_id uuid NOT NULL REFERENCES gotchu.organizations(id),
  id uuid NOT NULL,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email=lower(email)),
  role text NOT NULL CHECK (role IN ('operator','viewer')),
  invited_by text NOT NULL CHECK (length(invited_by) BETWEEN 1 AND 256),
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY (organization_id,id),
  UNIQUE (token_hash),
  CHECK (expires_at > created_at),
  CHECK (NOT (revoked_at IS NOT NULL AND consumed_at IS NOT NULL))
);
CREATE INDEX workspace_invitations_pending ON gotchu.workspace_invitations(organization_id,expires_at)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;
ALTER TABLE gotchu.workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.workspace_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.workspace_invitations
  USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id());
CREATE POLICY invitation_token_lookup ON gotchu.workspace_invitations TO gotchu_owner
  USING (current_setting('gotchu.invitation_lookup',true)='enabled');
REVOKE ALL ON gotchu.workspace_invitations FROM PUBLIC,gotchu_api,gotchu_executor,gotchu_coordinator,gotchu_ingest;

-- Historical approvals are an audit ledger. They must outlive the membership
-- that created them; current membership is rechecked by executor claim and pre-I/O.
ALTER TABLE gotchu.approvals DROP CONSTRAINT approvals_organization_id_user_id_fkey;

CREATE FUNCTION gotchu.workspace_members(p_organization uuid) RETURNS TABLE(user_id text,email text,role text,joined_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT m.user_id,coalesce(m.email,a.email),m.role,m.joined_at FROM gotchu.memberships m
  LEFT JOIN gotchu.local_accounts a ON m.user_id='credentials:'||a.id::text
  WHERE p_organization=gotchu.tenant_id() AND m.organization_id=p_organization
  ORDER BY m.joined_at,m.user_id LIMIT 100
$$;

CREATE FUNCTION gotchu.workspace_invitations_list(p_organization uuid)
RETURNS TABLE(id uuid,email text,role text,invited_by text,created_at timestamptz,expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT i.id,i.email,i.role,i.invited_by,i.created_at,i.expires_at
  FROM gotchu.workspace_invitations i
  WHERE p_organization=gotchu.tenant_id() AND i.organization_id=p_organization
    AND i.revoked_at IS NULL AND i.consumed_at IS NULL AND i.expires_at>clock_timestamp()
  ORDER BY i.created_at,i.id LIMIT 50
$$;

CREATE FUNCTION gotchu.workspace_invitation_organization(p_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE organization uuid;
BEGIN
  IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid OR p_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  PERFORM set_config('gotchu.invitation_lookup','enabled',true);
  SELECT organization_id INTO organization FROM gotchu.workspace_invitations WHERE token_hash=p_hash;
  PERFORM set_config('gotchu.invitation_lookup','',true);
  RETURN organization;
END
$$;

CREATE FUNCTION gotchu.workspace_invite(p_organization uuid,p_id uuid,p_actor text,p_email text,p_role text,p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pending_count integer; member_count integer; daily_count integer; created gotchu.workspace_invitations%ROWTYPE;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR p_email<>lower(p_email) OR p_role NOT IN ('operator','viewer') OR p_hash !~ '^[a-f0-9]{64}$'
    OR length(p_actor) NOT BETWEEN 1 AND 256 THEN RETURN jsonb_build_object('error','invalid_input'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-members:'||p_organization::text,0));
  IF gotchu.lock_membership(p_organization,p_actor) IS DISTINCT FROM 'owner' THEN RETURN jsonb_build_object('error','forbidden'); END IF;
  SELECT count(*) INTO pending_count FROM gotchu.workspace_invitations WHERE organization_id=p_organization
    AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>clock_timestamp();
  SELECT count(*) INTO member_count FROM gotchu.memberships WHERE organization_id=p_organization;
  SELECT count(*) INTO daily_count FROM gotchu.workspace_invitations WHERE organization_id=p_organization
    AND created_at>=clock_timestamp()-interval '1 day';
  IF pending_count>=50 THEN RETURN jsonb_build_object('error','pending_invitation_limit'); END IF;
  IF daily_count>=20 THEN RETURN jsonb_build_object('error','daily_invitation_limit'); END IF;
  IF member_count>=100 THEN RETURN jsonb_build_object('error','member_limit'); END IF;
  IF EXISTS (SELECT 1 FROM gotchu.memberships m LEFT JOIN gotchu.local_accounts a ON m.user_id='credentials:'||a.id::text
    WHERE m.organization_id=p_organization AND lower(coalesce(m.email,a.email,''))=p_email)
    OR EXISTS (SELECT 1 FROM gotchu.workspace_invitations i WHERE i.organization_id=p_organization AND i.email=p_email
      AND i.revoked_at IS NULL AND i.consumed_at IS NULL AND i.expires_at>clock_timestamp()) THEN
    RETURN jsonb_build_object('error','invitation_conflict');
  END IF;
  INSERT INTO gotchu.workspace_invitations(organization_id,id,email,role,invited_by,token_hash,expires_at)
    VALUES(p_organization,p_id,p_email,p_role,p_actor,p_hash,clock_timestamp()+interval '7 days') RETURNING * INTO created;
  INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail)
    VALUES(p_organization,gen_random_uuid(),p_actor,'member.invitation_created',p_id,jsonb_build_object('email',p_email,'role',p_role));
  RETURN jsonb_build_object('invitation',jsonb_build_object('id',created.id,'email',created.email,'role',created.role,
    'invitedBy',created.invited_by,'createdAt',created.created_at,'expiresAt',created.expires_at));
END $$;

CREATE FUNCTION gotchu.workspace_invitation_revoke(p_organization uuid,p_id uuid,p_actor text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() THEN RETURN 'not_found'; END IF;
  IF gotchu.lock_membership(p_organization,p_actor) IS DISTINCT FROM 'owner' THEN RETURN 'forbidden'; END IF;
  UPDATE gotchu.workspace_invitations SET revoked_at=clock_timestamp()
    WHERE organization_id=p_organization AND id=p_id AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>clock_timestamp();
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id)
    VALUES(p_organization,gen_random_uuid(),p_actor,'member.invitation_revoked',p_id);
  RETURN 'ok';
END $$;

CREATE FUNCTION gotchu.workspace_invitation_accept(p_hash text,p_user text,p_email text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE invitation gotchu.workspace_invitations%ROWTYPE; member_count integer;
BEGIN
  IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid
    OR p_hash !~ '^[a-f0-9]{64}$' OR length(p_user) NOT BETWEEN 1 AND 256
    OR p_email IS NULL OR length(p_email) NOT BETWEEN 3 AND 254 THEN RETURN jsonb_build_object('error','invalid_input'); END IF;
  PERFORM set_config('gotchu.invitation_lookup','enabled',true);
  SELECT * INTO invitation FROM gotchu.workspace_invitations WHERE token_hash=p_hash FOR UPDATE;
  PERFORM set_config('gotchu.invitation_lookup','',true);
  IF NOT FOUND THEN RETURN jsonb_build_object('error','invitation_invalid'); END IF;
  PERFORM set_config('gotchu.organization_id',invitation.organization_id::text,true);
  IF invitation.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error','invitation_revoked'); END IF;
  IF invitation.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('error','invitation_expired'); END IF;
  IF invitation.consumed_at IS NOT NULL THEN RETURN jsonb_build_object('error','invitation_used'); END IF;
  IF lower(p_email)<>invitation.email THEN RETURN jsonb_build_object('error','invitation_email_mismatch'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-members:'||invitation.organization_id::text,0));
  IF EXISTS (SELECT 1 FROM gotchu.memberships WHERE organization_id=invitation.organization_id AND user_id=p_user)
    THEN RETURN jsonb_build_object('error','already_member'); END IF;
  SELECT count(*) INTO member_count FROM gotchu.memberships WHERE organization_id=invitation.organization_id;
  IF member_count>=100 THEN RETURN jsonb_build_object('error','member_limit'); END IF;
  UPDATE gotchu.workspace_invitations SET consumed_at=clock_timestamp()
    WHERE organization_id=invitation.organization_id AND id=invitation.id AND consumed_at IS NULL AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','invitation_used'); END IF;
  INSERT INTO gotchu.memberships(organization_id,user_id,role,email) VALUES(invitation.organization_id,p_user,invitation.role,lower(p_email));
  INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail)
    VALUES(invitation.organization_id,gen_random_uuid(),p_user,'member.invitation_accepted',invitation.id,jsonb_build_object('role',invitation.role));
  RETURN jsonb_build_object('organizationId',invitation.organization_id,'role',invitation.role);
END $$;

CREATE FUNCTION gotchu.workspace_member_change_role(p_organization uuid,p_user text,p_role text,p_actor text)
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

CREATE FUNCTION gotchu.workspace_member_remove(p_organization uuid,p_user text,p_actor text)
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
  DELETE FROM gotchu.step_up_recovery_codes WHERE organization_id=p_organization AND user_id=p_user;
  DELETE FROM gotchu.step_up_proofs WHERE organization_id=p_organization AND user_id=p_user;
  DELETE FROM gotchu.step_up_challenges WHERE organization_id=p_organization AND user_id=p_user;
  DELETE FROM gotchu.step_up_factors WHERE organization_id=p_organization AND user_id=p_user;
  DELETE FROM gotchu.memberships WHERE organization_id=p_organization AND user_id=p_user;
  INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail)
    VALUES(p_organization,gen_random_uuid(),p_actor,'member.removed',NULL,jsonb_build_object('userId',p_user,'role',current_role));
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION gotchu.workspace_members(uuid),gotchu.workspace_invitations_list(uuid),gotchu.workspace_invitation_organization(text),gotchu.workspace_invite(uuid,uuid,text,text,text,text),gotchu.workspace_invitation_revoke(uuid,uuid,text),gotchu.workspace_invitation_accept(text,text,text),gotchu.workspace_member_change_role(uuid,text,text,text),gotchu.workspace_member_remove(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.workspace_members(uuid),gotchu.workspace_invitations_list(uuid),gotchu.workspace_invitation_organization(text),gotchu.workspace_invite(uuid,uuid,text,text,text,text),gotchu.workspace_invitation_revoke(uuid,uuid,text),gotchu.workspace_invitation_accept(text,text,text),gotchu.workspace_member_change_role(uuid,text,text,text),gotchu.workspace_member_remove(uuid,text,text) TO gotchu_api;
