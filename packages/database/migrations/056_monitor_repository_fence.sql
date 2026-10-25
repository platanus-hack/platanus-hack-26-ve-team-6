-- Revoking a GitHub installation or link must stop a monitor run that already started,
-- not only the next one: every heartbeat, observation and assessment admission rechecks it.
CREATE FUNCTION gotchu.monitor_repository_current(p_org uuid,p_app uuid,p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT p_key IS NULL OR p_key !~ '^gh-[0-9]{1,20}$' OR EXISTS(
    SELECT 1 FROM gotchu.application_repository_links l
    JOIN gotchu.github_installations g ON g.organization_id=l.organization_id AND g.installation_id=l.installation_id
    WHERE p_org=gotchu.tenant_id() AND l.organization_id=p_org AND l.application_id=p_app AND l.repository_key=p_key
      AND l.source='github_app' AND NOT l.revoked AND l.read_access='granted' AND g.state='active')
$$;
REVOKE ALL ON FUNCTION gotchu.monitor_repository_current(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.monitor_repository_current(uuid,uuid,text) TO gotchu_api,gotchu_coordinator;

CREATE OR REPLACE FUNCTION gotchu.operation_check_claim(p_org uuid,p_app uuid,p_run uuid,p_token uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m gotchu.operation_monitors; r gotchu.operation_runs; a jsonb;
BEGIN
 IF p_org IS DISTINCT FROM gotchu.tenant_id() THEN RETURN 'forbidden'; END IF;
 IF NOT gotchu.lock_customer_organization(p_org) THEN RETURN 'not_found'; END IF;
 a:=gotchu.lock_customer_application(p_org,p_app);
 IF a IS NULL THEN RETURN 'not_found'; END IF;
 IF (a->>'archived')::boolean THEN RETURN 'application_archived'; END IF;
 SELECT * INTO m FROM gotchu.operation_monitors WHERE organization_id=p_org AND application_id=p_app FOR UPDATE;
 IF NOT FOUND OR NOT m.enabled THEN RETURN 'monitor_disabled'; END IF;
 IF gotchu.lock_membership(p_org,m.author_id) IS NULL OR gotchu.lock_membership(p_org,m.author_id) NOT IN ('owner','operator') THEN RETURN 'monitor_authorization_revoked'; END IF;
 SELECT * INTO r FROM gotchu.operation_runs WHERE organization_id=p_org AND application_id=p_app AND id=p_run FOR UPDATE;
 IF NOT FOUND OR r.status<>'running' OR r.lease_token<>p_token OR r.lease_until<=clock_timestamp() THEN RETURN 'stale_lease'; END IF;
 IF r.monitor_revision<>m.revision THEN RETURN 'monitor_changed'; END IF;
 IF NOT gotchu.monitor_repository_current(p_org,p_app,m.repository_key) THEN RETURN 'repository_access_revoked'; END IF;
 IF m.source_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gotchu.customer_sources WHERE organization_id=p_org AND application_id=p_app AND id=m.source_id AND deleted_at IS NULL) THEN RETURN 'source_unavailable'; END IF;
 IF m.target_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gotchu.customer_targets WHERE organization_id=p_org AND application_id=p_app AND id=m.target_id AND version=m.target_version AND status='authorized' AND expires_at>clock_timestamp()) THEN RETURN 'target_not_authorized'; END IF;
 RETURN 'ok';
END $$;
REVOKE ALL ON FUNCTION gotchu.operation_check_claim(uuid,uuid,uuid,uuid) FROM PUBLIC;
