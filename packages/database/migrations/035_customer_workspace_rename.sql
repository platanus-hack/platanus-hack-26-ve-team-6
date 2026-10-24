CREATE FUNCTION gotchu.customer_rename_workspace(p_user text,p_organization uuid,p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid
    OR p_user IS NULL OR length(p_user) NOT BETWEEN 1 AND 256 OR p_user='demo:controlled-assessment'
    OR p_organization IS NULL OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_customer_identity';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('customer-workspaces:'||p_user,0));
  PERFORM set_config('gotchu.discovery_user',p_user,true);
  IF NOT EXISTS (SELECT 1 FROM gotchu.memberships WHERE organization_id=p_organization AND user_id=p_user AND role IN ('owner','operator')) THEN
    result := jsonb_build_object('error','workspace_not_found');
  ELSIF EXISTS (SELECT 1 FROM gotchu.memberships m JOIN gotchu.organizations o ON o.id=m.organization_id
      WHERE m.user_id=p_user AND m.organization_id<>p_organization AND lower(o.name)=lower(btrim(p_name))) THEN
    result := jsonb_build_object('error','workspace_name_conflict');
  ELSE
    PERFORM set_config('gotchu.organization_id',p_organization::text,true);
    UPDATE gotchu.organizations SET name=btrim(p_name) WHERE id=p_organization;
    INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail)
      VALUES (p_organization,gen_random_uuid(),p_user,'workspace.updated',p_organization,jsonb_build_object('name',btrim(p_name)));
    SELECT jsonb_build_object('id',p_organization,'name',btrim(p_name),'role',m.role) INTO result
      FROM gotchu.memberships m WHERE m.organization_id=p_organization AND m.user_id=p_user;
    PERFORM set_config('gotchu.organization_id','00000000-0000-0000-0000-000000000000',true);
  END IF;
  PERFORM set_config('gotchu.discovery_user','',true);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION gotchu.customer_rename_workspace(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.customer_rename_workspace(text,uuid,text) TO gotchu_api;
