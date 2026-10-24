CREATE TABLE gotchu.triage_incidents (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL,
 environment text NOT NULL CHECK(length(environment) BETWEEN 1 AND 128), status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','monitoring','closed')),
 window_started_at timestamptz NOT NULL, window_ended_at timestamptz NOT NULL, last_evidence_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,application_id,id), FOREIGN KEY(organization_id,application_id) REFERENCES gotchu.applications(organization_id,id),
 CHECK(window_started_at < window_ended_at)
);
CREATE INDEX triage_incidents_recent ON gotchu.triage_incidents(organization_id,application_id,updated_at DESC);
CREATE TABLE gotchu.triage_revisions (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, incident_id uuid NOT NULL, id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 200), rules_version text NOT NULL CHECK(length(rules_version) BETWEEN 1 AND 64),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'), body jsonb NOT NULL CHECK(octet_length(body::text)<=131072),
 evidence_refs jsonb NOT NULL CHECK(jsonb_typeof(evidence_refs)='array' AND jsonb_array_length(evidence_refs)<=500),
 previous_revision_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,application_id,incident_id,id), UNIQUE(organization_id,application_id,incident_id,revision),
 UNIQUE(organization_id,application_id,incident_id,input_digest,rules_version),
 FOREIGN KEY(organization_id,application_id,incident_id) REFERENCES gotchu.triage_incidents(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id,incident_id,previous_revision_id) REFERENCES gotchu.triage_revisions(organization_id,application_id,incident_id,id),
 CHECK(body->>'revision'=revision::text AND body->>'rulesVersion'=rules_version AND body->>'inputDigest'=input_digest)
);
CREATE INDEX triage_revisions_history ON gotchu.triage_revisions(organization_id,application_id,incident_id,revision DESC);
CREATE FUNCTION gotchu.reject_triage_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'triage_revision_immutable'; END $$;
CREATE TRIGGER triage_revision_immutable BEFORE UPDATE OR DELETE ON gotchu.triage_revisions FOR EACH ROW EXECUTE FUNCTION gotchu.reject_triage_revision_mutation();
ALTER TABLE gotchu.triage_incidents ENABLE ROW LEVEL SECURITY; ALTER TABLE gotchu.triage_incidents FORCE ROW LEVEL SECURITY;
ALTER TABLE gotchu.triage_revisions ENABLE ROW LEVEL SECURITY; ALTER TABLE gotchu.triage_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.triage_incidents USING(organization_id=gotchu.tenant_id()) WITH CHECK(organization_id=gotchu.tenant_id());
CREATE POLICY tenant_scope ON gotchu.triage_revisions USING(organization_id=gotchu.tenant_id()) WITH CHECK(organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.triage_incidents,gotchu.triage_revisions FROM PUBLIC;
GRANT SELECT ON gotchu.triage_incidents,gotchu.triage_revisions TO gotchu_api,gotchu_coordinator;
CREATE FUNCTION gotchu.triage_insert_revision(p_org uuid,p_app uuid,p_incident uuid,p_revision uuid,p_environment text,p_started timestamptz,p_ended timestamptz,p_body jsonb,p_evidence jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_incident gotchu.triage_incidents; latest gotchu.triage_revisions; next_revision integer;
BEGIN
 IF p_org IS DISTINCT FROM gotchu.tenant_id() OR p_body->>'rulesVersion' IS NULL OR p_body->>'inputDigest' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_triage_revision'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('triage:'||p_org::text||':'||p_app::text,0));
 SELECT * INTO current_incident FROM gotchu.triage_incidents WHERE organization_id=p_org AND application_id=p_app AND id=p_incident FOR UPDATE;
 IF NOT FOUND THEN
  IF (SELECT count(*) FROM gotchu.triage_incidents WHERE organization_id=p_org AND application_id=p_app)>=500 THEN RAISE EXCEPTION 'triage_incident_limit'; END IF;
  INSERT INTO gotchu.triage_incidents(organization_id,application_id,id,environment,window_started_at,window_ended_at,last_evidence_at) VALUES(p_org,p_app,p_incident,p_environment,p_started,p_ended,clock_timestamp());
  next_revision:=1;
 ELSE
  SELECT * INTO latest FROM gotchu.triage_revisions WHERE organization_id=p_org AND application_id=p_app AND incident_id=p_incident ORDER BY revision DESC LIMIT 1;
  IF latest.input_digest=p_body->>'inputDigest' AND latest.rules_version=p_body->>'rulesVersion' THEN RETURN false; END IF;
  IF latest.revision>=200 THEN RAISE EXCEPTION 'triage_revision_limit'; END IF;
  next_revision:=latest.revision+1;
 END IF;
 p_body:=jsonb_set(jsonb_set(p_body,'{revision}',to_jsonb(next_revision)),'{previousRevisionId}',CASE WHEN next_revision=1 THEN 'null'::jsonb ELSE to_jsonb(latest.body->>'id') END);
 INSERT INTO gotchu.triage_revisions(organization_id,application_id,incident_id,id,revision,rules_version,input_digest,body,evidence_refs,previous_revision_id)
 VALUES(p_org,p_app,p_incident,p_revision,next_revision,p_body->>'rulesVersion',p_body->>'inputDigest',p_body,p_evidence,CASE WHEN next_revision=1 THEN NULL ELSE latest.id END);
 UPDATE gotchu.triage_incidents SET window_started_at=LEAST(window_started_at,p_started),window_ended_at=GREATEST(window_ended_at,p_ended),last_evidence_at=clock_timestamp(),updated_at=clock_timestamp() WHERE organization_id=p_org AND application_id=p_app AND id=p_incident;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION gotchu.triage_insert_revision(uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.triage_insert_revision(uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb,jsonb) TO gotchu_coordinator;
CREATE FUNCTION gotchu.triage_update_status(p_org uuid,p_app uuid,p_incident uuid,p_status text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_org IS DISTINCT FROM gotchu.tenant_id() OR p_status NOT IN ('open','monitoring','closed') THEN RAISE EXCEPTION 'invalid_triage_status'; END IF;
 UPDATE gotchu.triage_incidents SET status=p_status,updated_at=clock_timestamp() WHERE organization_id=p_org AND application_id=p_app AND id=p_incident;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION gotchu.triage_update_status(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.triage_update_status(uuid,uuid,uuid,text) TO gotchu_api;

ALTER POLICY customer_pending_discovery ON gotchu.jobs TO gotchu_owner
 USING(current_setting('gotchu.pending_discovery',true)='enabled' AND state IN ('queued','running')
   AND ((kind='audit' AND payload->>'version'='2') OR kind IN ('events.aggregate','investigation')
     OR (kind='notification' AND payload->>'kind' IN ('assessment_observation','triage_evaluation'))));
CREATE OR REPLACE FUNCTION gotchu.customer_pending_organizations(p_limit integer DEFAULT 100) RETURNS TABLE(organization_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_customer_discovery'; END IF;
 PERFORM set_config('gotchu.pending_discovery','enabled',true);
 RETURN QUERY SELECT j.organization_id FROM gotchu.jobs j WHERE j.state IN ('queued','running')
   AND ((j.kind='audit' AND j.payload->>'version'='2') OR j.kind IN ('events.aggregate','investigation')
     OR (j.kind='notification' AND j.payload->>'kind' IN ('assessment_observation','triage_evaluation')))
   GROUP BY j.organization_id ORDER BY min(j.created_at),j.organization_id LIMIT p_limit;
 PERFORM set_config('gotchu.pending_discovery','',true);
END $$;
