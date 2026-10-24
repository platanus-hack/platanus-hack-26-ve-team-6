-- Operator-owned opaque target keys. No caller-supplied origins or source paths.
CREATE TABLE gotchu.assessment_targets (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  target_key text NOT NULL CHECK (target_key ~ '^[a-z0-9][a-z0-9_-]{0,127}$'),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, application_id, target_key),
  FOREIGN KEY (organization_id, application_id) REFERENCES gotchu.applications(organization_id, id)
);
CREATE UNIQUE INDEX assessment_one_enabled_target ON gotchu.assessment_targets(organization_id, application_id) WHERE enabled;

CREATE TABLE gotchu.assessment_requests (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  job_id uuid NOT NULL,
  target_key text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('internal', 'external', 'both')),
  revision text NOT NULL CHECK (revision IN ('vulnerable', 'corrected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, application_id, job_id),
  UNIQUE (organization_id, application_id, job_id, target_key, mode, revision),
  FOREIGN KEY (organization_id, application_id, job_id) REFERENCES gotchu.jobs(organization_id, application_id, id),
  FOREIGN KEY (organization_id, application_id, target_key) REFERENCES gotchu.assessment_targets(organization_id, application_id, target_key)
);

CREATE TABLE gotchu.assessment_reports (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  id uuid NOT NULL,
  job_id uuid NOT NULL,
  target_key text NOT NULL,
  mode text NOT NULL,
  revision text NOT NULL,
  body jsonb NOT NULL CHECK (octet_length(body::text) <= 1048576),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, application_id, id),
  UNIQUE (organization_id, application_id, job_id),
  FOREIGN KEY (organization_id, application_id, job_id, target_key, mode, revision)
    REFERENCES gotchu.assessment_requests(organization_id, application_id, job_id, target_key, mode, revision),
  CHECK ((jsonb_typeof(body) = 'object' AND body->>'version' = '1'
    AND body->>'organizationId' = organization_id::text AND body->>'applicationId' = application_id::text
    AND body->>'id' = id::text AND body->>'jobId' = job_id::text
    AND body->>'mode' = mode AND body->>'revision' = revision
    AND body->>'responseMode' = 'observation' AND body->'actionsPerformed' = '[]'::jsonb) IS TRUE)
);
CREATE INDEX assessment_reports_recent ON gotchu.assessment_reports(organization_id, application_id, created_at DESC, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assessment_targets','assessment_requests','assessment_reports'] LOOP
    EXECUTE format('ALTER TABLE gotchu.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE gotchu.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_scope ON gotchu.%I USING (organization_id = gotchu.tenant_id()) WITH CHECK (organization_id = gotchu.tenant_id())', t);
  END LOOP;
END $$;
REVOKE ALL ON gotchu.assessment_targets, gotchu.assessment_requests, gotchu.assessment_reports FROM PUBLIC;
GRANT SELECT ON gotchu.assessment_targets, gotchu.assessment_requests, gotchu.assessment_reports TO gotchu_api, gotchu_coordinator;
GRANT INSERT ON gotchu.assessment_requests TO gotchu_api;
GRANT INSERT ON gotchu.assessment_reports TO gotchu_coordinator;

-- Serialize target revocation against queue/finalize without granting target writes.
CREATE FUNCTION gotchu.lock_assessment_target(p_organization uuid, p_application uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result text;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() THEN RETURN NULL; END IF;
  SELECT target_key INTO result FROM gotchu.assessment_targets
    WHERE organization_id=p_organization AND application_id=p_application AND enabled FOR UPDATE;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION gotchu.lock_assessment_target(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.lock_assessment_target(uuid,uuid) TO gotchu_api, gotchu_coordinator;
