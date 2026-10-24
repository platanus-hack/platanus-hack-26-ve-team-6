-- Invalid scheduled authorization must settle durably, not roll back every claim.
-- Retain the existing monitor/application/membership lock order and role boundary.
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
  OR (m.source_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gotchu.customer_sources
    WHERE organization_id=r.organization_id AND application_id=r.application_id AND id=m.source_id AND deleted_at IS NULL))
  OR (m.target_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gotchu.customer_targets
    WHERE organization_id=r.organization_id AND application_id=r.application_id AND id=m.target_id
      AND version=m.target_version AND status='verified' AND expires_at>clock_timestamp()))
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
