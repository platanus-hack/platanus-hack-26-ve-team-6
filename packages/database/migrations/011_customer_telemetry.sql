ALTER TABLE gotchu.integrations ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE FUNCTION gotchu.customer_connect_events(p_org uuid,p_app uuid,p_user text,p_id uuid,p_ref text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE app jsonb;
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() OR p_user='demo:controlled-assessment'
    OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RETURN false; END IF;
  IF NOT gotchu.lock_customer_organization(p_org) THEN RETURN false; END IF;
  app:=gotchu.lock_customer_application(p_org,p_app);
  IF app IS NULL OR (app->>'archived')::boolean THEN RETURN false; END IF;
  IF p_ref IS DISTINCT FROM 'local-event:'||p_id::text THEN RETURN false; END IF;
  IF (SELECT count(*) FROM gotchu.integrations WHERE organization_id=p_org AND kind='signed_events'
    AND created_at>clock_timestamp()-interval '1 day')>=20 THEN RAISE EXCEPTION 'event_integration_limit'; END IF;
  UPDATE gotchu.integrations SET status='disabled' WHERE organization_id=p_org AND application_id=p_app AND kind='signed_events';
  INSERT INTO gotchu.integrations(organization_id,application_id,id,kind) VALUES(p_org,p_app,p_id,'signed_events');
  INSERT INTO gotchu.integration_credentials(organization_id,integration_id,credential_ref) VALUES(p_org,p_id,p_ref);
  RETURN true;
END $$;

CREATE FUNCTION gotchu.customer_disable_events(p_org uuid,p_app uuid,p_user text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() OR p_user='demo:controlled-assessment'
    OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RETURN false; END IF;
  IF NOT gotchu.lock_customer_organization(p_org) THEN RETURN false; END IF;
  PERFORM gotchu.lock_customer_application(p_org,p_app);
  UPDATE gotchu.integrations SET status='disabled'
    WHERE organization_id=p_org AND application_id=p_app AND id=p_id AND kind='signed_events';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION gotchu.customer_connect_events(uuid,uuid,text,uuid,text),gotchu.customer_disable_events(uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.customer_connect_events(uuid,uuid,text,uuid,text),gotchu.customer_disable_events(uuid,uuid,text,uuid) TO gotchu_api;
