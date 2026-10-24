ALTER TABLE gotchu.applications ADD COLUMN archived boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX applications_unique_name ON gotchu.applications(organization_id, lower(name));

-- Discovery remains under FORCE RLS. Only these owner-executed functions can use
-- this additional SELECT policy; runtime logins cannot SET ROLE gotchu_owner.
CREATE POLICY identity_discovery ON gotchu.memberships FOR SELECT TO gotchu_owner
  USING (user_id = nullif(current_setting('gotchu.discovery_user', true), ''));
CREATE POLICY identity_discovery ON gotchu.organizations FOR SELECT TO gotchu_owner
  USING (EXISTS (SELECT 1 FROM gotchu.memberships m WHERE m.organization_id=id
    AND m.user_id=nullif(current_setting('gotchu.discovery_user', true), '')));
CREATE FUNCTION gotchu.customer_workspaces(p_user text) RETURNS TABLE(id uuid,name text,role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid
    OR p_user IS NULL OR length(p_user) NOT BETWEEN 1 AND 256 OR p_user='demo:controlled-assessment' THEN
    RAISE EXCEPTION 'invalid_customer_identity';
  END IF;
  PERFORM set_config('gotchu.discovery_user',p_user,true);
  RETURN QUERY SELECT o.id,o.name,m.role FROM gotchu.memberships m JOIN gotchu.organizations o ON o.id=m.organization_id
    WHERE m.user_id=p_user ORDER BY o.created_at,o.id LIMIT 100;
  PERFORM set_config('gotchu.discovery_user','',true);
END $$;
CREATE FUNCTION gotchu.customer_create_workspace(p_user text,p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE workspace_id uuid := gen_random_uuid(); result jsonb;
BEGIN
  IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid
    OR p_user IS NULL OR length(p_user) NOT BETWEEN 1 AND 256 OR p_user='demo:controlled-assessment'
    OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_customer_identity'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('customer-workspaces:'||p_user,0));
  PERFORM set_config('gotchu.discovery_user',p_user,true);
  IF EXISTS (SELECT 1 FROM gotchu.memberships m JOIN gotchu.organizations o ON o.id=m.organization_id WHERE m.user_id=p_user AND lower(o.name)=lower(btrim(p_name))) THEN
    result := jsonb_build_object('error','workspace_name_conflict');
  ELSIF (SELECT count(*) FROM gotchu.memberships WHERE user_id=p_user) >= 5 THEN
    result := jsonb_build_object('error','workspace_limit');
  ELSE
    PERFORM set_config('gotchu.organization_id',workspace_id::text,true);
    INSERT INTO gotchu.organizations(id,name) VALUES (workspace_id,btrim(p_name));
    INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES (workspace_id,p_user,'owner');
    INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id)
      VALUES (workspace_id,gen_random_uuid(),p_user,'workspace.created',workspace_id);
    result := jsonb_build_object('id',workspace_id,'name',btrim(p_name),'role','owner');
    PERFORM set_config('gotchu.organization_id','00000000-0000-0000-0000-000000000000',true);
  END IF;
  PERFORM set_config('gotchu.discovery_user','',true);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION gotchu.customer_workspaces(text),gotchu.customer_create_workspace(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.customer_workspaces(text),gotchu.customer_create_workspace(text,text) TO gotchu_api;
GRANT INSERT ON gotchu.applications TO gotchu_api;
GRANT UPDATE (name,archived) ON gotchu.applications TO gotchu_api;

-- Every admission and target/app change serializes on the organization. The
-- coordinator shares this lock for finalization without gaining app write access.
CREATE FUNCTION gotchu.lock_customer_organization(p_organization uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() THEN RETURN false; END IF;
  PERFORM 1 FROM gotchu.organizations WHERE id=p_organization FOR UPDATE;
  RETURN FOUND;
END $$;
CREATE FUNCTION gotchu.lock_customer_application(p_organization uuid,p_application uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('name',name,'archived',archived) INTO result FROM gotchu.applications
    WHERE organization_id=p_organization AND id=p_application FOR UPDATE;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION gotchu.lock_customer_organization(uuid),gotchu.lock_customer_application(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.lock_customer_organization(uuid),gotchu.lock_customer_application(uuid,uuid) TO gotchu_api,gotchu_coordinator;

CREATE TABLE gotchu.customer_targets (
  organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL,
  origin text NOT NULL CHECK (length(origin) BETWEEN 1 AND 300),
  version integer NOT NULL CHECK (version>0),
  status text NOT NULL CHECK (status IN ('pending','verified','revoked')),
  consent_actor text NOT NULL, consent_at timestamptz NOT NULL DEFAULT now(),
  challenge_hash text NOT NULL CHECK (challenge_hash ~ '^[a-f0-9]{64}$'),
  challenge_expires_at timestamptz NOT NULL,
  verified_at timestamptz, expires_at timestamptz,
  PRIMARY KEY (organization_id,application_id,id), UNIQUE (organization_id,application_id),
  FOREIGN KEY (organization_id,application_id) REFERENCES gotchu.applications(organization_id,id),
  CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at>verified_at))
);
-- SQL storage bounds mirror the exported CUSTOMER_MAX_SOURCE_* contract constants.
CREATE FUNCTION gotchu.customer_source_file_bounds(p_body jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(p_body->'files')='array' THEN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_body->'files') AS f
      WHERE jsonb_typeof(f->'content') IS DISTINCT FROM 'string' OR octet_length(f->>'content')>1048576
  ) ELSE false END
$$;
REVOKE ALL ON FUNCTION gotchu.customer_source_file_bounds(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.customer_source_file_bounds(jsonb) TO gotchu_api;
CREATE TABLE gotchu.customer_sources (
  organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  body jsonb CHECK (octet_length(body::text)<=4194304 AND gotchu.customer_source_file_bounds(body)),
  deleted_at timestamptz,
  consent_actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,application_id,id),
  CHECK ((deleted_at IS NULL) = (body IS NOT NULL)),
  FOREIGN KEY (organization_id,application_id) REFERENCES gotchu.applications(organization_id,id),
  CHECK (deleted_at IS NOT NULL OR (jsonb_typeof(body)='object' AND jsonb_typeof(body->'files')='array'
    AND jsonb_array_length(body->'files') BETWEEN 1 AND 1000 AND length(body->>'revision') BETWEEN 1 AND 200) IS TRUE)
);
CREATE UNIQUE INDEX customer_sources_active_digest ON gotchu.customer_sources(organization_id,application_id,digest) WHERE deleted_at IS NULL;
CREATE TABLE gotchu.customer_requests (
  organization_id uuid NOT NULL, application_id uuid NOT NULL, job_id uuid NOT NULL,
  source_id uuid, target_id uuid, input jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,application_id,job_id),
  FOREIGN KEY (organization_id,application_id,job_id) REFERENCES gotchu.jobs(organization_id,application_id,id),
  FOREIGN KEY (organization_id,application_id,source_id) REFERENCES gotchu.customer_sources(organization_id,application_id,id),
  FOREIGN KEY (organization_id,application_id,target_id) REFERENCES gotchu.customer_targets(organization_id,application_id,id),
  CHECK ((input->>'version'='2' AND input->>'organizationId'=organization_id::text
    AND input->>'applicationId'=application_id::text AND input->>'jobId'=job_id::text
    AND (input->'source'->>'id') IS NOT DISTINCT FROM source_id::text
    AND (input->'target'->>'id') IS NOT DISTINCT FROM target_id::text) IS TRUE)
);
CREATE INDEX customer_requests_recent ON gotchu.customer_requests(organization_id,created_at);
CREATE TABLE gotchu.customer_reports (
  organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL, job_id uuid NOT NULL,
  body jsonb NOT NULL CHECK (octet_length(body::text)<=1048576), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,application_id,id), UNIQUE (organization_id,application_id,job_id),
  FOREIGN KEY (organization_id,application_id,job_id) REFERENCES gotchu.customer_requests(organization_id,application_id,job_id),
  CHECK ((body->>'version'='2' AND body->>'organizationId'=organization_id::text
    AND body->>'applicationId'=application_id::text AND body->>'id'=id::text AND body->>'jobId'=job_id::text
    AND body->>'responseMode'='observation' AND body->'actionsPerformed'='[]'::jsonb) IS TRUE)
);
CREATE INDEX customer_reports_recent ON gotchu.customer_reports(organization_id,application_id,created_at DESC,id);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_targets','customer_sources','customer_requests','customer_reports'] LOOP
    EXECUTE format('ALTER TABLE gotchu.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE gotchu.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON gotchu.%I USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id())',t);
  END LOOP;
END $$;
REVOKE ALL ON gotchu.customer_targets,gotchu.customer_sources,gotchu.customer_requests,gotchu.customer_reports FROM PUBLIC;
GRANT SELECT ON gotchu.customer_targets,gotchu.customer_sources,gotchu.customer_requests,gotchu.customer_reports TO gotchu_api,gotchu_coordinator;
GRANT INSERT,UPDATE ON gotchu.customer_targets TO gotchu_api;
GRANT INSERT ON gotchu.customer_sources,gotchu.customer_requests TO gotchu_api;
GRANT INSERT ON gotchu.customer_reports TO gotchu_coordinator;

-- The durable request remains the authority even for direct coordinator inserts.
CREATE FUNCTION gotchu.check_customer_report_subject() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE request jsonb; expected jsonb;
BEGIN
  SELECT input INTO request FROM gotchu.customer_requests WHERE organization_id=NEW.organization_id
    AND application_id=NEW.application_id AND job_id=NEW.job_id;
  expected := jsonb_build_object('sourceSnapshotId',request->'source'->'id','sourceDigest',request->'source'->'digest',
    'targetId',request->'target'->'id','targetVersion',request->'target'->'version','origin',request->'target'->'origin');
  IF request IS NULL OR NEW.body->'subject' IS DISTINCT FROM expected
    OR NEW.body->'mode' IS DISTINCT FROM request->'mode'
    OR NEW.body->'applicationName' IS DISTINCT FROM request->'applicationName' THEN
    RAISE EXCEPTION 'Customer report differs from durable request' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.check_customer_report_subject() FROM PUBLIC;
CREATE TRIGGER customer_report_subject BEFORE INSERT ON gotchu.customer_reports
  FOR EACH ROW EXECUTE FUNCTION gotchu.check_customer_report_subject();

-- A narrow deletion capability retains the digest/FK tombstone but erases the
-- canonical raw source. No runtime UPDATE privilege is granted on source rows.
CREATE FUNCTION gotchu.customer_delete_source(p_organization uuid,p_application uuid,p_source uuid,p_user text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE deleted timestamptz;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() OR p_user='demo:controlled-assessment'
    OR coalesce(gotchu.lock_membership(p_organization,p_user) NOT IN ('owner','operator'),true) THEN RETURN 'forbidden'; END IF;
  IF NOT gotchu.lock_customer_organization(p_organization) THEN RETURN 'not_found'; END IF;
  SELECT deleted_at INTO deleted FROM gotchu.customer_sources WHERE organization_id=p_organization AND application_id=p_application AND id=p_source FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF deleted IS NOT NULL THEN RETURN 'deleted'; END IF;
  IF EXISTS (SELECT 1 FROM gotchu.customer_requests r JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.id=r.job_id
    WHERE r.organization_id=p_organization AND r.application_id=p_application AND r.source_id=p_source AND j.state IN ('queued','running')) THEN RETURN 'in_use'; END IF;
  UPDATE gotchu.customer_sources SET body=NULL,deleted_at=clock_timestamp() WHERE organization_id=p_organization AND application_id=p_application AND id=p_source;
  INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id) VALUES (p_organization,gen_random_uuid(),p_user,'source.deleted',p_source);
  RETURN 'deleted';
END $$;
REVOKE ALL ON FUNCTION gotchu.customer_delete_source(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.customer_delete_source(uuid,uuid,uuid,text) TO gotchu_api;

-- Dynamic customer assignment is opt-in at the host. This owner-only RLS policy
-- exposes only pending version 2 audit jobs inside the coordinator discovery call.
CREATE POLICY customer_pending_discovery ON gotchu.jobs FOR SELECT TO gotchu_owner
  USING (current_setting('gotchu.pending_discovery',true)='enabled'
    AND kind='audit' AND payload->>'version'='2' AND state IN ('queued','running'));
CREATE FUNCTION gotchu.customer_pending_organizations(p_limit integer DEFAULT 100) RETURNS TABLE(organization_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_customer_discovery'; END IF;
  PERFORM set_config('gotchu.pending_discovery','enabled',true);
  RETURN QUERY SELECT j.organization_id FROM gotchu.jobs j
    WHERE j.kind='audit' AND j.payload->>'version'='2' AND j.state IN ('queued','running')
    GROUP BY j.organization_id ORDER BY min(j.created_at),j.organization_id LIMIT p_limit;
  PERFORM set_config('gotchu.pending_discovery','',true);
END $$;
REVOKE ALL ON FUNCTION gotchu.customer_pending_organizations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.customer_pending_organizations(integer) TO gotchu_coordinator;
CREATE INDEX customer_pending_jobs ON gotchu.jobs(created_at,organization_id)
  WHERE kind='audit' AND payload->>'version'='2' AND state IN ('queued','running');
