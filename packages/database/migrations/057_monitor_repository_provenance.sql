-- A key is an App repository because an App link created it, not because it looks like gh-<id>:
-- operator catalogs may use the same shape. A revoked App link never falls back to the catalog.
CREATE OR REPLACE FUNCTION gotchu.monitor_repository_current(p_org uuid,p_app uuid,p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT p_key IS NULL OR (p_org=gotchu.tenant_id() AND (
    NOT EXISTS(SELECT 1 FROM gotchu.application_repository_links l
      WHERE l.organization_id=p_org AND l.application_id=p_app AND l.repository_key=p_key AND l.source='github_app')
    OR EXISTS(SELECT 1 FROM gotchu.application_repository_links l
      JOIN gotchu.github_installations g ON g.organization_id=l.organization_id AND g.installation_id=l.installation_id
      WHERE l.organization_id=p_org AND l.application_id=p_app AND l.repository_key=p_key
        AND l.source='github_app' AND NOT l.revoked AND l.read_access='granted' AND g.state='active')))
$$;

-- 'github_app' (active App link), 'revoked' (App link no longer usable) or 'catalog' (no App link).
CREATE FUNCTION gotchu.monitor_repository_provenance(p_org uuid,p_app uuid,p_key text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT CASE
    WHEN p_org IS DISTINCT FROM gotchu.tenant_id() THEN 'revoked'
    WHEN NOT EXISTS(SELECT 1 FROM gotchu.application_repository_links l
      WHERE l.organization_id=p_org AND l.application_id=p_app AND l.repository_key=p_key AND l.source='github_app') THEN 'catalog'
    WHEN gotchu.monitor_repository_current(p_org,p_app,p_key) THEN 'github_app'
    ELSE 'revoked' END
$$;
REVOKE ALL ON FUNCTION gotchu.monitor_repository_provenance(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.monitor_repository_provenance(uuid,uuid,text) TO gotchu_coordinator;

-- Audits admitted before a revocation must not start afterwards.
CREATE OR REPLACE FUNCTION gotchu.operation_fence_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r gotchu.operation_runs; m gotchu.operation_monitors; reason_code text;
BEGIN
 IF NEW.state<>'running' THEN RETURN NEW; END IF;
 SELECT * INTO r FROM gotchu.operation_runs WHERE organization_id=NEW.organization_id AND application_id=NEW.application_id AND job_id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO m FROM gotchu.operation_monitors WHERE organization_id=r.organization_id AND application_id=r.application_id FOR SHARE;
 PERFORM 1 FROM gotchu.applications WHERE organization_id=r.organization_id AND id=r.application_id FOR SHARE;
 IF NOT m.enabled OR m.revision<>r.monitor_revision OR r.status<>'running'
  OR NOT EXISTS(SELECT 1 FROM gotchu.applications WHERE organization_id=r.organization_id AND id=r.application_id AND NOT archived)
  OR coalesce(gotchu.lock_membership(r.organization_id,m.author_id),'') NOT IN ('owner','operator')
  OR NOT gotchu.monitor_repository_current(r.organization_id,r.application_id,m.repository_key)
  OR (m.source_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gotchu.customer_sources
    WHERE organization_id=r.organization_id AND application_id=r.application_id AND id=m.source_id AND deleted_at IS NULL))
  OR (m.target_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gotchu.customer_targets
    WHERE organization_id=r.organization_id AND application_id=r.application_id AND id=m.target_id
      AND version=m.target_version AND status='authorized' AND expires_at>clock_timestamp()))
  OR EXISTS(SELECT 1 FROM gotchu.customer_requests q JOIN gotchu.customer_sources s
    ON s.organization_id=q.organization_id AND s.application_id=q.application_id AND s.id=q.source_id
    WHERE q.organization_id=r.organization_id AND q.application_id=r.application_id AND q.job_id=NEW.id AND s.deleted_at IS NOT NULL) THEN
  -- Only the pre-update state proves no worker ever received this job. An expired
  -- or requeued claim may still have I/O in flight and must retain quarantine.
  reason_code:=CASE WHEN OLD.state='queued' AND OLD.attempts=0
    THEN 'monitor_authorization_changed' ELSE 'assessment_reconciliation_required' END;
  NEW.state:='failed';
  NEW.result:=jsonb_build_object('reasonCode',reason_code,'reason','Scheduled assessment authorization or scope is no longer current.');
  NEW.completed_at:=clock_timestamp();
  NEW.lease_token:=NULL;
  NEW.lease_until:=NULL;
  NEW.attempts:=OLD.attempts;
  UPDATE gotchu.operation_runs SET status='degraded',reason=reason_code,finished_at=clock_timestamp()
    WHERE organization_id=r.organization_id AND application_id=r.application_id AND id=r.id AND status='running';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.operation_fence_job() FROM PUBLIC;
