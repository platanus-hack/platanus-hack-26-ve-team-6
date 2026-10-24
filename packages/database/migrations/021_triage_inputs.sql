-- Structured triage evidence is separate from the alert text shown to users.
CREATE TABLE gotchu.triage_inputs (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('provider_status','https_probe')),
 observed_at timestamptz NOT NULL, payload jsonb NOT NULL CHECK(octet_length(payload::text)<=4096),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id) REFERENCES gotchu.applications(organization_id,id),
 CHECK((kind='provider_status' AND payload->>'provider' IN ('cloudflare','railway') AND payload->>'scope' IN ('global','regional','component'))
   OR (kind='https_probe' AND payload->>'route' IS NOT NULL AND payload->>'service' IS NOT NULL))
);
CREATE INDEX triage_inputs_recent ON gotchu.triage_inputs(organization_id,application_id,observed_at DESC);
GRANT SELECT ON gotchu.application_environments,gotchu.application_services,gotchu.application_deployments,gotchu.application_dependencies TO gotchu_coordinator;
ALTER TABLE gotchu.triage_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.triage_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.triage_inputs USING(organization_id=gotchu.tenant_id()) WITH CHECK(organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.triage_inputs FROM PUBLIC;
GRANT SELECT ON gotchu.triage_inputs TO gotchu_coordinator;

CREATE FUNCTION gotchu.triage_record_input(p_org uuid,p_app uuid,p_run uuid,p_token uuid,p_id uuid,p_kind text,p_observed timestamptz,p_payload jsonb) RETURNS boolean
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
     AND t.status='verified' AND t.expires_at>clock_timestamp() AND (r.route='/' OR t.scan_profile='public_surface')
     AND s.name=p_payload->>'service' AND d.provider IS NOT DISTINCT FROM p_payload->>'dependsOnProvider' AND r.role=p_payload->>'role') THEN RAISE EXCEPTION 'triage_probe_not_configured'; END IF;
 INSERT INTO gotchu.triage_inputs(organization_id,application_id,id,kind,observed_at,payload)
 VALUES(p_org,p_app,p_id,p_kind,p_observed,p_payload)
 ON CONFLICT(organization_id,application_id,id) DO NOTHING;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION gotchu.triage_record_input(uuid,uuid,uuid,uuid,uuid,text,timestamptz,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.triage_record_input(uuid,uuid,uuid,uuid,uuid,text,timestamptz,jsonb) TO gotchu_coordinator;

-- Declared paths stay within the verified target's existing scan profile.
CREATE TABLE gotchu.triage_probe_routes (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, route text NOT NULL CHECK(route IN ('/','/.well-known/security.txt','/security.txt','/robots.txt','/sitemap.xml')),
 service_id uuid NOT NULL, dependency_id uuid, role text NOT NULL CHECK(role IN ('application','control')),
 declared_by text NOT NULL, declared_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,application_id,route),
 FOREIGN KEY(organization_id,application_id,service_id) REFERENCES gotchu.application_services(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id,dependency_id) REFERENCES gotchu.application_dependencies(organization_id,application_id,id),
 CHECK(role<>'control' OR dependency_id IS NULL)
);
ALTER TABLE gotchu.triage_probe_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.triage_probe_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.triage_probe_routes USING(organization_id=gotchu.tenant_id()) WITH CHECK(organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.triage_probe_routes FROM PUBLIC;
GRANT SELECT ON gotchu.triage_probe_routes TO gotchu_api,gotchu_coordinator;

CREATE FUNCTION gotchu.triage_declare_probe_route(p_org uuid,p_app uuid,p_user text,p_route text,p_service uuid,p_dependency uuid,p_role text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE app jsonb;
BEGIN
 IF p_org IS DISTINCT FROM gotchu.tenant_id() OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RETURN false; END IF;
 IF NOT gotchu.lock_customer_organization(p_org) THEN RETURN false; END IF;
 app:=gotchu.lock_customer_application(p_org,p_app);
 IF app IS NULL OR (app->>'archived')::boolean OR p_role NOT IN ('application','control')
   OR p_route NOT IN ('/','/.well-known/security.txt','/security.txt','/robots.txt','/sitemap.xml') THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM gotchu.operation_monitors m JOIN gotchu.customer_targets t ON t.organization_id=m.organization_id AND t.application_id=m.application_id AND t.id=m.target_id
   WHERE m.organization_id=p_org AND m.application_id=p_app AND m.enabled AND t.status='verified' AND t.expires_at>clock_timestamp()
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
GRANT EXECUTE ON FUNCTION gotchu.triage_declare_probe_route(uuid,uuid,text,text,uuid,uuid,text) TO gotchu_api;

CREATE OR REPLACE FUNCTION gotchu.reject_triage_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user='gotchu_owner' AND current_setting('gotchu.triage_retention',true)='enabled' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'triage_revision_immutable';
END $$;
DROP TRIGGER triage_revision_immutable ON gotchu.triage_revisions;
CREATE TRIGGER triage_revision_immutable BEFORE UPDATE OR DELETE ON gotchu.triage_revisions FOR EACH ROW EXECUTE FUNCTION gotchu.reject_triage_revision_mutation();
REVOKE DELETE ON gotchu.triage_revisions FROM PUBLIC,gotchu_api,gotchu_coordinator;
CREATE POLICY triage_retention ON gotchu.triage_incidents TO gotchu_owner USING(current_setting('gotchu.triage_retention',true)='enabled');
CREATE POLICY triage_retention ON gotchu.triage_revisions TO gotchu_owner USING(current_setting('gotchu.triage_retention',true)='enabled');

CREATE TABLE gotchu.triage_retention_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, application_id uuid NOT NULL,
 incident_id uuid NOT NULL, revisions_deleted integer NOT NULL CHECK(revisions_deleted>0),
 incident_created_at timestamptz NOT NULL, pruned_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE gotchu.triage_retention_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.triage_retention_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY triage_retention_audit ON gotchu.triage_retention_audit TO gotchu_owner
 USING(current_setting('gotchu.triage_retention',true)='enabled') WITH CHECK(current_setting('gotchu.triage_retention',true)='enabled');
REVOKE ALL ON gotchu.triage_retention_audit FROM PUBLIC,gotchu_api,gotchu_coordinator,gotchu_ingest,gotchu_executor;
GRANT SELECT,INSERT ON gotchu.triage_retention_audit TO gotchu_owner;

-- Projection capacity is an observability boundary: it must never roll back
-- accepted telemetry. The original immutable revisions remain unchanged.
CREATE OR REPLACE FUNCTION gotchu.triage_insert_revision(p_org uuid,p_app uuid,p_incident uuid,p_revision uuid,p_environment text,p_started timestamptz,p_ended timestamptz,p_body jsonb,p_evidence jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_incident gotchu.triage_incidents; latest gotchu.triage_revisions; next_revision integer;
BEGIN
 IF p_org IS DISTINCT FROM gotchu.tenant_id() OR p_body->>'rulesVersion' IS NULL OR p_body->>'inputDigest' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_triage_revision'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('triage:'||p_org::text||':'||p_app::text,0));
 SELECT * INTO current_incident FROM gotchu.triage_incidents WHERE organization_id=p_org AND application_id=p_app AND id=p_incident FOR UPDATE;
 IF NOT FOUND THEN
  IF (SELECT count(*) FROM gotchu.triage_incidents WHERE organization_id=p_org AND application_id=p_app)>=500 THEN
   INSERT INTO gotchu.coverage(organization_id,application_id,capability,state,reason,checked_at) VALUES(p_org,p_app,'triage_projection','degraded','Incident projection is at capacity; accepted detections remain stored.',clock_timestamp())
    ON CONFLICT(organization_id,application_id,capability) DO UPDATE SET state='degraded',reason=EXCLUDED.reason,checked_at=EXCLUDED.checked_at;
   RETURN false;
  END IF;
  INSERT INTO gotchu.triage_incidents(organization_id,application_id,id,environment,window_started_at,window_ended_at,last_evidence_at) VALUES(p_org,p_app,p_incident,p_environment,p_started,p_ended,clock_timestamp());
  next_revision:=1;
 ELSE
  SELECT * INTO latest FROM gotchu.triage_revisions WHERE organization_id=p_org AND application_id=p_app AND incident_id=p_incident ORDER BY revision DESC LIMIT 1;
  IF latest.input_digest=p_body->>'inputDigest' AND latest.rules_version=p_body->>'rulesVersion' THEN RETURN false; END IF;
  IF latest.revision>=200 THEN
   INSERT INTO gotchu.coverage(organization_id,application_id,capability,state,reason,checked_at) VALUES(p_org,p_app,'triage_projection','degraded','Incident revision history is at capacity; accepted detections remain stored.',clock_timestamp())
    ON CONFLICT(organization_id,application_id,capability) DO UPDATE SET state='degraded',reason=EXCLUDED.reason,checked_at=EXCLUDED.checked_at;
   RETURN false;
  END IF;
  next_revision:=latest.revision+1;
 END IF;
 p_body:=jsonb_set(jsonb_set(p_body,'{revision}',to_jsonb(next_revision)),'{previousRevisionId}',CASE WHEN next_revision=1 THEN 'null'::jsonb ELSE to_jsonb(latest.body->>'id') END);
 INSERT INTO gotchu.triage_revisions(organization_id,application_id,incident_id,id,revision,rules_version,input_digest,body,evidence_refs,previous_revision_id)
 VALUES(p_org,p_app,p_incident,p_revision,next_revision,p_body->>'rulesVersion',p_body->>'inputDigest',p_body,p_evidence,CASE WHEN next_revision=1 THEN NULL ELSE latest.id END);
 UPDATE gotchu.triage_incidents SET window_started_at=LEAST(window_started_at,p_started),window_ended_at=GREATEST(window_ended_at,p_ended),last_evidence_at=clock_timestamp(),updated_at=clock_timestamp() WHERE organization_id=p_org AND application_id=p_app AND id=p_incident;
 RETURN true;
END $$;

CREATE FUNCTION gotchu.triage_prune_old_incidents(p_keep_per_application integer DEFAULT 450,p_batch integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item record; removed integer:=0; revision_count integer;
BEGIN
 IF p_keep_per_application IS NULL OR p_keep_per_application NOT BETWEEN 1 AND 500
   OR p_batch IS NULL OR p_batch NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_triage_retention_bound'; END IF;
 PERFORM set_config('gotchu.triage_retention','enabled',true);
 FOR item IN
  SELECT organization_id,application_id,id,created_at FROM (
   SELECT organization_id,application_id,id,created_at,
     row_number() OVER(PARTITION BY organization_id,application_id ORDER BY last_evidence_at DESC,created_at DESC,id) AS position
   FROM gotchu.triage_incidents
  ) ranked WHERE position>p_keep_per_application
  ORDER BY created_at,id LIMIT p_batch
 LOOP
  SELECT count(*)::integer INTO revision_count FROM gotchu.triage_revisions
   WHERE organization_id=item.organization_id AND application_id=item.application_id AND incident_id=item.id;
  IF revision_count=0 THEN CONTINUE; END IF;
  INSERT INTO gotchu.triage_retention_audit(organization_id,application_id,incident_id,revisions_deleted,incident_created_at)
   VALUES(item.organization_id,item.application_id,item.id,revision_count,item.created_at);
  DELETE FROM gotchu.triage_revisions WHERE organization_id=item.organization_id AND application_id=item.application_id AND incident_id=item.id;
  DELETE FROM gotchu.triage_incidents WHERE organization_id=item.organization_id AND application_id=item.application_id AND id=item.id;
  removed:=removed+1;
 END LOOP;
 PERFORM set_config('gotchu.triage_retention','',true);
 RETURN removed;
END $$;
ALTER FUNCTION gotchu.triage_prune_old_incidents(integer,integer) OWNER TO gotchu_owner;
REVOKE ALL ON FUNCTION gotchu.triage_prune_old_incidents(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.triage_prune_old_incidents(integer,integer) TO gotchu_owner;

DROP FUNCTION gotchu.triage_update_status(uuid,uuid,uuid,text);
CREATE FUNCTION gotchu.triage_update_status(p_org uuid,p_app uuid,p_user text,p_incident uuid,p_status text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_org IS DISTINCT FROM gotchu.tenant_id() OR p_status NOT IN ('open','monitoring','closed')
   OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RAISE EXCEPTION 'invalid_triage_status'; END IF;
 UPDATE gotchu.triage_incidents SET status=p_status,updated_at=clock_timestamp() WHERE organization_id=p_org AND application_id=p_app AND id=p_incident;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION gotchu.triage_update_status(uuid,uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.triage_update_status(uuid,uuid,text,uuid,text) TO gotchu_api;
