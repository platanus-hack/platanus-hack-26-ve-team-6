-- Customer-selected monitoring. No runtime role gains cross-tenant table access.
CREATE TABLE gotchu.operation_monitors (
 organization_id uuid NOT NULL, application_id uuid NOT NULL,
 enabled boolean NOT NULL, interval_seconds integer NOT NULL CHECK(interval_seconds BETWEEN 3600 AND 86400),
 source_id uuid, target_id uuid, target_version integer, repository_key text CHECK(length(repository_key) BETWEEN 1 AND 128),
 providers jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(providers)='array' AND jsonb_array_length(providers)<=2 AND providers <@ '["cloudflare","railway"]'::jsonb),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), author_id text NOT NULL,
 next_due_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,application_id),
 FOREIGN KEY(organization_id,application_id) REFERENCES gotchu.applications(organization_id,id),
 FOREIGN KEY(organization_id,application_id,source_id) REFERENCES gotchu.customer_sources(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id,target_id) REFERENCES gotchu.customer_targets(organization_id,application_id,id),
 CHECK(NOT enabled OR source_id IS NOT NULL OR target_id IS NOT NULL OR repository_key IS NOT NULL OR providers<>'[]'::jsonb)
);
CREATE INDEX operation_monitors_due ON gotchu.operation_monitors(next_due_at,organization_id,application_id) WHERE enabled;
CREATE TABLE gotchu.operation_runs (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL,
 monitor_revision integer NOT NULL, lease_token uuid NOT NULL, lease_until timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','degraded','cancelled')),
 job_id uuid, repository_digest text CHECK(repository_digest ~ '^[a-f0-9]{64}$'), reason text CHECK(length(reason)<=2000), created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 PRIMARY KEY(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id) REFERENCES gotchu.operation_monitors(organization_id,application_id),
 FOREIGN KEY(organization_id,application_id,job_id) REFERENCES gotchu.customer_requests(organization_id,application_id,job_id)
);
CREATE UNIQUE INDEX operation_runs_active ON gotchu.operation_runs(organization_id,application_id) WHERE status='running';
CREATE INDEX operation_runs_recent ON gotchu.operation_runs(organization_id,application_id,created_at DESC);
CREATE TABLE gotchu.operation_observations (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), body jsonb NOT NULL CHECK(octet_length(body::text)<=32768),
 basis jsonb NOT NULL CHECK(octet_length(basis::text)<=8192), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,application_id,id), UNIQUE(organization_id,application_id,idempotency_key),
 FOREIGN KEY(organization_id,application_id) REFERENCES gotchu.applications(organization_id,id),
 CHECK((body->>'id'=id::text AND body->>'organizationId'=organization_id::text AND body->>'applicationId'=application_id::text
   AND body->>'verification'='trusted_observation') IS TRUE)
);
CREATE INDEX operation_observations_recent ON gotchu.operation_observations(organization_id,application_id,created_at DESC);
CREATE TABLE gotchu.operation_alerts (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL, observation_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','acknowledged','resolved')), resolution text CHECK(length(resolution)<=2000),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by text,
 PRIMARY KEY(organization_id,application_id,id), UNIQUE(organization_id,application_id,observation_id),
 FOREIGN KEY(organization_id,application_id,observation_id) REFERENCES gotchu.operation_observations(organization_id,application_id,id)
);
CREATE INDEX operation_alerts_recent ON gotchu.operation_alerts(organization_id,application_id,updated_at DESC);
CREATE TABLE gotchu.operation_plans (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), action_hash text NOT NULL CHECK(action_hash ~ '^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=32768), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,application_id,id), FOREIGN KEY(organization_id,application_id) REFERENCES gotchu.applications(organization_id,id),
 CHECK((body->>'id'=id::text AND body->>'organizationId'=organization_id::text AND body->>'applicationId'=application_id::text
   AND body->>'revision'=revision::text AND body->>'actionHash'=action_hash AND body->>'execution'='disabled'
   AND body->>'state' IN ('draft','preparation_requested')) IS TRUE)
);
CREATE INDEX operation_plans_recent ON gotchu.operation_plans(organization_id,application_id,updated_at DESC);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['operation_monitors','operation_runs','operation_observations','operation_alerts','operation_plans'] LOOP
  EXECUTE format('ALTER TABLE gotchu.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE gotchu.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON gotchu.%I USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id())',t);
  EXECUTE format('REVOKE ALL ON gotchu.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT ON gotchu.%I TO gotchu_api,gotchu_coordinator',t);
 END LOOP;
END $$;
GRANT INSERT,UPDATE ON gotchu.operation_monitors,gotchu.operation_plans TO gotchu_api;
GRANT UPDATE(state,resolution,updated_at,updated_by) ON gotchu.operation_alerts TO gotchu_api;
GRANT INSERT ON gotchu.operation_observations,gotchu.operation_alerts TO gotchu_coordinator;
GRANT UPDATE(status,reason,finished_at) ON gotchu.operation_runs TO gotchu_coordinator;

-- Only the narrow discovery function can use these owner-only policies. A runtime
-- caller setting this GUC still cannot read another tenant's rows.
CREATE POLICY operation_due_discovery ON gotchu.operation_monitors TO gotchu_owner
 USING(current_setting('gotchu.operation_discovery',true)='enabled')
 WITH CHECK(current_setting('gotchu.operation_discovery',true)='enabled');
CREATE POLICY operation_due_discovery ON gotchu.operation_runs TO gotchu_owner
 USING(current_setting('gotchu.operation_discovery',true)='enabled')
 WITH CHECK(current_setting('gotchu.operation_discovery',true)='enabled');
CREATE FUNCTION gotchu.operation_claim_due(p_limit integer,p_lease_ms integer) RETURNS SETOF gotchu.operation_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m gotchu.operation_monitors; r gotchu.operation_runs;
BEGIN
 IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
   OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 300000 THEN RAISE EXCEPTION 'invalid_monitor_discovery'; END IF;
 PERFORM set_config('gotchu.operation_discovery','enabled',true);
 FOR m IN SELECT * FROM gotchu.operation_monitors c WHERE c.enabled AND
   ((c.next_due_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM gotchu.operation_runs x WHERE x.organization_id=c.organization_id AND x.application_id=c.application_id AND x.status='running'))
    OR EXISTS(SELECT 1 FROM gotchu.operation_runs x WHERE x.organization_id=c.organization_id AND x.application_id=c.application_id AND x.status='running' AND x.lease_until<=clock_timestamp()))
   ORDER BY c.next_due_at,c.organization_id,c.application_id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  SELECT * INTO r FROM gotchu.operation_runs WHERE organization_id=m.organization_id AND application_id=m.application_id AND status='running' FOR UPDATE;
  IF FOUND THEN
   UPDATE gotchu.operation_runs SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond' WHERE organization_id=r.organization_id AND application_id=r.application_id AND id=r.id RETURNING * INTO r;
  ELSE
   IF (SELECT count(*) FROM gotchu.operation_runs WHERE organization_id=m.organization_id AND application_id=m.application_id)>=1000 THEN
    UPDATE gotchu.operation_monitors SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE organization_id=m.organization_id AND application_id=m.application_id;
    CONTINUE;
   END IF;
   INSERT INTO gotchu.operation_runs(organization_id,application_id,id,monitor_revision,lease_token,lease_until)
    VALUES(m.organization_id,m.application_id,gen_random_uuid(),m.revision,gen_random_uuid(),clock_timestamp()+p_lease_ms*interval '1 millisecond') RETURNING * INTO r;
   UPDATE gotchu.operation_monitors SET next_due_at=clock_timestamp()+interval_seconds*interval '1 second' WHERE organization_id=m.organization_id AND application_id=m.application_id;
  END IF;
  RETURN NEXT r;
 END LOOP;
 PERFORM set_config('gotchu.operation_discovery','',true);
END $$;
REVOKE ALL ON FUNCTION gotchu.operation_claim_due(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.operation_claim_due(integer,integer) TO gotchu_coordinator;

-- Serializes scope and permission changes with all trusted work. The function
-- returns only an error code; it does not grant the coordinator membership reads.
CREATE FUNCTION gotchu.operation_check_claim(p_org uuid,p_app uuid,p_run uuid,p_token uuid) RETURNS text
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
 IF m.target_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gotchu.customer_targets WHERE organization_id=p_org AND application_id=p_app AND id=m.target_id AND version=m.target_version AND status='verified' AND expires_at>clock_timestamp()) THEN RETURN 'target_not_verified'; END IF;
 RETURN 'ok';
END $$;
REVOKE ALL ON FUNCTION gotchu.operation_check_claim(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.operation_check_claim(uuid,uuid,uuid,uuid) TO gotchu_coordinator;

CREATE FUNCTION gotchu.operation_materialize(p_org uuid,p_app uuid,p_run uuid,p_token uuid,p_snapshot jsonb,p_digest text) RETURNS jsonb
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
  target:=jsonb_build_object('id',t.id,'origin',t.origin,'version',t.version,'verifiedAt',to_char(t.verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(t.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
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
GRANT EXECUTE ON FUNCTION gotchu.operation_materialize(uuid,uuid,uuid,uuid,jsonb,text) TO gotchu_coordinator;

-- Config mutation cancels undispatched work. An active adapter lease or scanner
-- cannot be declared stopped merely by toggling a customer setting.
CREATE FUNCTION gotchu.operation_fence_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid; app uuid;
BEGIN
 IF TG_TABLE_NAME='operation_monitors' THEN
  IF (NEW.enabled,NEW.source_id,NEW.target_id,NEW.repository_key,NEW.providers,NEW.interval_seconds,NEW.revision)
   IS NOT DISTINCT FROM (OLD.enabled,OLD.source_id,OLD.target_id,OLD.repository_key,OLD.providers,OLD.interval_seconds,OLD.revision) THEN RETURN NEW; END IF;
  org:=NEW.organization_id; app:=NEW.application_id;
 ELSIF TG_TABLE_NAME='applications' THEN
  IF NOT NEW.archived OR OLD.archived THEN RETURN NEW; END IF;
  org:=NEW.organization_id; app:=NEW.id;
 ELSE RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM gotchu.operation_runs r LEFT JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.id=r.job_id
  WHERE r.organization_id=org AND r.application_id=app AND
  ((r.status='running' AND r.lease_until>clock_timestamp()) OR j.state='running' OR (j.state='failed' AND j.result->>'reasonCode'='assessment_reconciliation_required'))) THEN
  RAISE EXCEPTION 'monitor_work_in_progress' USING ERRCODE='P0001';
 END IF;
 UPDATE gotchu.jobs j SET state='failed',result='{"reasonCode":"monitor_configuration_changed"}'::jsonb,completed_at=clock_timestamp()
  WHERE j.organization_id=org AND j.application_id=app AND j.state='queued'
  AND EXISTS(SELECT 1 FROM gotchu.operation_runs r WHERE r.organization_id=org AND r.application_id=app AND r.job_id=j.id);
 UPDATE gotchu.operation_runs SET status='cancelled',reason='monitor_configuration_changed',finished_at=clock_timestamp()
  WHERE organization_id=org AND application_id=app AND status='running';
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.operation_fence_change() FROM PUBLIC;
CREATE TRIGGER operation_config_fence BEFORE UPDATE ON gotchu.operation_monitors FOR EACH ROW EXECUTE FUNCTION gotchu.operation_fence_change();
CREATE TRIGGER operation_archive_fence BEFORE UPDATE OF archived ON gotchu.applications FOR EACH ROW EXECUTE FUNCTION gotchu.operation_fence_change();

-- A queued scheduled scan is not a transferable authorization after its scope or
-- author permission changes. Generic jobs.claim must obey the same boundary.
CREATE FUNCTION gotchu.operation_fence_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r gotchu.operation_runs; m gotchu.operation_monitors;
BEGIN
 IF NEW.state<>'running' THEN RETURN NEW; END IF;
 SELECT * INTO r FROM gotchu.operation_runs WHERE organization_id=NEW.organization_id AND application_id=NEW.application_id AND job_id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO m FROM gotchu.operation_monitors WHERE organization_id=r.organization_id AND application_id=r.application_id FOR SHARE;
 PERFORM 1 FROM gotchu.applications WHERE organization_id=r.organization_id AND id=r.application_id FOR SHARE;
 IF NOT m.enabled OR m.revision<>r.monitor_revision OR r.status<>'running'
  OR NOT EXISTS(SELECT 1 FROM gotchu.applications WHERE organization_id=r.organization_id AND id=r.application_id AND NOT archived)
  OR coalesce(gotchu.lock_membership(r.organization_id,m.author_id),'') NOT IN ('owner','operator') THEN
  RAISE EXCEPTION 'monitor_authorization_changed' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.operation_fence_job() FROM PUBLIC;
CREATE TRIGGER operation_job_fence BEFORE UPDATE OF state ON gotchu.jobs FOR EACH ROW EXECUTE FUNCTION gotchu.operation_fence_job();

CREATE FUNCTION gotchu.operation_heartbeat(p_org uuid,p_app uuid,p_run uuid,p_token uuid,p_lease_ms integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
 IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 300000 THEN RETURN 'invalid_input'; END IF;
 result:=gotchu.operation_check_claim(p_org,p_app,p_run,p_token);
 IF result<>'ok' THEN RETURN result; END IF;
 UPDATE gotchu.operation_runs SET lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond'
  WHERE organization_id=p_org AND application_id=p_app AND id=p_run AND lease_token=p_token AND lease_until>clock_timestamp();
 IF NOT FOUND THEN RETURN 'stale_lease'; END IF;
 RETURN 'ok';
END $$;
REVOKE ALL ON FUNCTION gotchu.operation_heartbeat(uuid,uuid,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.operation_heartbeat(uuid,uuid,uuid,uuid,integer) TO gotchu_coordinator;
