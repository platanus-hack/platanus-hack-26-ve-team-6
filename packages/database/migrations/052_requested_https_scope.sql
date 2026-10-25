-- Replace domain-control verification with bounded authorization from the user's Analyze request.
-- Existing verified scopes retain their exact origin, version and expiry; pending scopes require a new request.
ALTER TABLE gotchu.customer_targets DROP CONSTRAINT customer_targets_status_check;
ALTER TABLE gotchu.customer_targets DROP CONSTRAINT customer_targets_check;
UPDATE gotchu.customer_targets SET status='revoked', verified_at=NULL, expires_at=NULL WHERE status='pending';
UPDATE gotchu.customer_targets SET status='authorized' WHERE status='verified';
ALTER TABLE gotchu.customer_targets RENAME COLUMN verified_at TO authorized_at;
ALTER TABLE gotchu.customer_targets RENAME COLUMN consent_actor TO requested_by;
ALTER TABLE gotchu.customer_targets RENAME COLUMN consent_at TO requested_at;
ALTER TABLE gotchu.customer_targets ADD CONSTRAINT customer_targets_status_check CHECK(status IN ('authorized','revoked'));
ALTER TABLE gotchu.customer_targets ADD CONSTRAINT customer_targets_authorization_check
  CHECK(status <> 'authorized' OR (authorized_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at > authorized_at));
ALTER TABLE gotchu.customer_targets DROP COLUMN challenge_hash;
ALTER TABLE gotchu.customer_targets DROP COLUMN challenge_expires_at;


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
 IF m.source_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gotchu.customer_sources WHERE organization_id=p_org AND application_id=p_app AND id=m.source_id AND deleted_at IS NULL) THEN RETURN 'source_unavailable'; END IF;
 IF m.target_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gotchu.customer_targets WHERE organization_id=p_org AND application_id=p_app AND id=m.target_id AND version=m.target_version AND status='authorized' AND expires_at>clock_timestamp()) THEN RETURN 'target_not_authorized'; END IF;
 RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION gotchu.operation_check_claim(uuid,uuid,uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION gotchu.operation_materialize(p_org uuid,p_app uuid,p_run uuid,p_token uuid,p_snapshot jsonb,p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m gotchu.operation_monitors; r gotchu.operation_runs; s gotchu.customer_sources; t gotchu.customer_targets;
 source jsonb:=NULL; target jsonb:=NULL; request jsonb; j uuid; check_result text; mode text; source_id uuid;
BEGIN
 check_result:=gotchu.operation_check_claim(p_org,p_app,p_run,p_token);
 IF check_result<>'ok' THEN RETURN jsonb_build_object('error',check_result); END IF;
 SELECT * INTO m FROM gotchu.operation_monitors WHERE organization_id=p_org AND application_id=p_app;
 SELECT * INTO r FROM gotchu.operation_runs WHERE organization_id=p_org AND application_id=p_app AND id=p_run;
 IF r.job_id IS NOT NULL THEN
  IF p_snapshot IS NOT NULL AND p_digest IS DISTINCT FROM r.repository_digest THEN RETURN jsonb_build_object('error','idempotency_conflict'); END IF;
  RETURN jsonb_build_object('jobId',r.job_id);
 END IF;
 IF p_snapshot IS NOT NULL AND m.repository_key IS NULL THEN RETURN jsonb_build_object('error','repository_not_configured'); END IF;
 source_id:=m.source_id;
 IF p_snapshot IS NOT NULL THEN
  SELECT * INTO s FROM gotchu.customer_sources WHERE organization_id=p_org AND application_id=p_app AND digest=p_digest AND deleted_at IS NULL;
  IF NOT FOUND THEN
   IF (SELECT count(*) FROM gotchu.customer_sources WHERE organization_id=p_org AND application_id=p_app AND deleted_at IS NULL)>=10
     OR (SELECT count(*) FROM gotchu.customer_sources WHERE organization_id=p_org AND created_at>clock_timestamp()-interval '1 day')>=100 THEN RETURN jsonb_build_object('error','source_capacity_exceeded'); END IF;
   INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor) VALUES(p_org,p_app,gen_random_uuid(),p_digest,p_snapshot,m.author_id) RETURNING * INTO s;
  END IF;
  source_id:=s.id;
 END IF;
 IF source_id IS NOT NULL THEN
  SELECT * INTO s FROM gotchu.customer_sources WHERE organization_id=p_org AND application_id=p_app AND id=source_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','source_unavailable'); END IF;
  source:=jsonb_build_object('id',s.id,'digest',s.digest,'revision',s.body->>'revision');
 END IF;
 IF m.target_id IS NOT NULL THEN
  SELECT * INTO t FROM gotchu.customer_targets WHERE organization_id=p_org AND application_id=p_app AND id=m.target_id;
  target:=jsonb_build_object('id',t.id,'origin',t.origin,'version',t.version,'authorizedAt',to_char(t.authorized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(t.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF to_jsonb(t)->>'scan_profile' IS NOT NULL THEN target:=target||jsonb_build_object('scanProfile',to_jsonb(t)->>'scan_profile'); END IF;
 END IF;
 IF source IS NULL AND target IS NULL THEN RETURN jsonb_build_object('jobId',NULL); END IF;
 IF (SELECT count(*) FROM gotchu.customer_requests q JOIN gotchu.jobs j ON j.organization_id=q.organization_id AND j.id=q.job_id WHERE q.organization_id=p_org AND q.application_id=p_app AND j.state IN ('queued','running'))>=3
   OR (SELECT count(*) FROM gotchu.customer_requests WHERE organization_id=p_org AND created_at>clock_timestamp()-interval '1 day')>=20 THEN RETURN jsonb_build_object('error','assessment_capacity_exceeded'); END IF;
 mode:=CASE WHEN source IS NULL THEN 'external' WHEN target IS NULL THEN 'internal' ELSE 'both' END;
 j:=gen_random_uuid();
 request:=jsonb_build_object('version',2,'organizationId',p_org,'applicationId',p_app,'jobId',j,'applicationName',(SELECT name FROM gotchu.applications WHERE organization_id=p_org AND id=p_app),'mode',mode,'source',source,'target',target);
 INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key,payload) VALUES(p_org,p_app,j,'audit','monitor:'||p_run::text,request);
 INSERT INTO gotchu.customer_requests(organization_id,application_id,job_id,source_id,target_id,input) VALUES(p_org,p_app,j,source_id,m.target_id,request);
 INSERT INTO gotchu.outbox(organization_id,id,job_id,envelope) VALUES(p_org,gen_random_uuid(),j,jsonb_build_object('version',1,'organizationId',p_org,'applicationId',p_app,'id',j,'kind','audit'));
 UPDATE gotchu.operation_runs SET job_id=j,repository_digest=p_digest WHERE organization_id=p_org AND application_id=p_app AND id=p_run;
 INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail) VALUES(p_org,gen_random_uuid(),'coordinator','monitor.materialized',p_run,jsonb_build_object('jobId',j,'authorId',m.author_id));
 RETURN jsonb_build_object('jobId',j);
END $$;

REVOKE ALL ON FUNCTION gotchu.operation_materialize(uuid,uuid,uuid,uuid,jsonb,text) FROM PUBLIC;

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

CREATE OR REPLACE FUNCTION gotchu.triage_record_input(p_org uuid,p_app uuid,p_run uuid,p_token uuid,p_id uuid,p_kind text,p_observed timestamptz,p_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_kind NOT IN ('provider_status','https_probe') OR p_payload IS NULL OR octet_length(p_payload::text)>4096
   OR p_observed IS NULL OR p_observed>clock_timestamp()+interval '30 seconds'
   OR p_observed<clock_timestamp()-interval '7 days' THEN RAISE EXCEPTION 'invalid_triage_input'; END IF;
 IF gotchu.operation_check_claim(p_org,p_app,p_run,p_token)<>'ok' THEN RAISE EXCEPTION 'stale_triage_input_claim'; END IF;
 IF p_kind='provider_status' AND NOT EXISTS(SELECT 1 FROM gotchu.operation_monitors m
   WHERE m.organization_id=p_org AND m.application_id=p_app AND m.providers @> jsonb_build_array(p_payload->>'provider')) THEN RAISE EXCEPTION 'triage_provider_not_configured'; END IF;
 IF p_kind='https_probe' AND NOT EXISTS(SELECT 1 FROM gotchu.triage_probe_routes r
   JOIN gotchu.operation_monitors m ON m.organization_id=r.organization_id AND m.application_id=r.application_id
   JOIN gotchu.customer_targets t ON t.organization_id=m.organization_id AND t.application_id=m.application_id AND t.id=m.target_id
   JOIN gotchu.application_services s ON s.organization_id=r.organization_id AND s.application_id=r.application_id AND s.id=r.service_id
   LEFT JOIN gotchu.application_dependencies d ON d.organization_id=r.organization_id AND d.application_id=r.application_id AND d.id=r.dependency_id
   WHERE r.organization_id=p_org AND r.application_id=p_app AND r.route=p_payload->>'route' AND m.enabled
     AND t.status='authorized' AND t.expires_at>clock_timestamp() AND (r.route='/' OR t.scan_profile='public_surface')
     AND s.name=p_payload->>'service' AND d.provider IS NOT DISTINCT FROM p_payload->>'dependsOnProvider' AND r.role=p_payload->>'role') THEN RAISE EXCEPTION 'triage_probe_not_configured'; END IF;
 INSERT INTO gotchu.triage_inputs(organization_id,application_id,id,kind,observed_at,payload)
 VALUES(p_org,p_app,p_id,p_kind,p_observed,p_payload)
 ON CONFLICT(organization_id,application_id,id) DO NOTHING;
 RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION gotchu.triage_record_input(uuid,uuid,uuid,uuid,uuid,text,timestamptz,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION gotchu.triage_declare_probe_route(p_org uuid,p_app uuid,p_user text,p_route text,p_service uuid,p_dependency uuid,p_role text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE app jsonb;
BEGIN
 IF p_org IS DISTINCT FROM gotchu.tenant_id() OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RETURN false; END IF;
 IF NOT gotchu.lock_customer_organization(p_org) THEN RETURN false; END IF;
 app:=gotchu.lock_customer_application(p_org,p_app);
 IF app IS NULL OR (app->>'archived')::boolean OR p_role NOT IN ('application','control')
   OR p_route NOT IN ('/','/.well-known/security.txt','/security.txt','/robots.txt','/sitemap.xml') THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM gotchu.operation_monitors m JOIN gotchu.customer_targets t ON t.organization_id=m.organization_id AND t.application_id=m.application_id AND t.id=m.target_id
   WHERE m.organization_id=p_org AND m.application_id=p_app AND m.enabled AND t.status='authorized' AND t.expires_at>clock_timestamp()
     AND (p_route='/' OR t.scan_profile='public_surface')) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM gotchu.application_services s JOIN gotchu.application_environments e ON e.organization_id=s.organization_id AND e.application_id=s.application_id AND e.id=s.environment_id
   WHERE s.organization_id=p_org AND s.application_id=p_app AND s.id=p_service AND NOT e.archived) THEN RETURN false; END IF;
 IF p_dependency IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gotchu.application_dependencies d WHERE d.organization_id=p_org AND d.application_id=p_app AND d.id=p_dependency AND d.service_id=p_service) THEN RETURN false; END IF;
 IF p_role='control' AND p_dependency IS NOT NULL THEN RETURN false; END IF;
 INSERT INTO gotchu.triage_probe_routes(organization_id,application_id,route,service_id,dependency_id,role,declared_by)
 VALUES(p_org,p_app,p_route,p_service,p_dependency,p_role,p_user)
 ON CONFLICT(organization_id,application_id,route) DO UPDATE SET service_id=EXCLUDED.service_id,dependency_id=EXCLUDED.dependency_id,role=EXCLUDED.role,declared_by=EXCLUDED.declared_by,declared_at=clock_timestamp();
 RETURN true;
END $$;

REVOKE ALL ON FUNCTION gotchu.triage_declare_probe_route(uuid,uuid,text,text,uuid,uuid,text) FROM PUBLIC;
