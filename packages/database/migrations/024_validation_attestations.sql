CREATE TABLE gotchu.validation_suite_definitions (
  organization_id uuid NOT NULL, application_id uuid NOT NULL, repository_link_id uuid NOT NULL,
  id uuid NOT NULL, version integer NOT NULL CHECK(version>0), profile text NOT NULL CHECK(profile='node24-npm-test'),
  script_name text NOT NULL CHECK(script_name ~ '^[A-Za-z0-9:_-]{1,64}$'), suite_name text NOT NULL CHECK(length(suite_name) BETWEEN 1 AND 128),
  required_count integer NOT NULL CHECK(required_count BETWEEN 1 AND 10000), regression_test_path text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL CHECK(length(created_by) BETWEEN 1 AND 256),
  PRIMARY KEY(organization_id,application_id,repository_link_id,id,version),
  FOREIGN KEY(organization_id,application_id,repository_link_id) REFERENCES gotchu.application_repository_links(organization_id,application_id,id),
  CHECK(regression_test_path IS NULL OR (length(regression_test_path) BETWEEN 1 AND 256 AND regression_test_path !~ '(^/|\\|(^|/)\.\.?(/|$))'))
);
CREATE TABLE gotchu.validation_runs (
  organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL, action_ref uuid NOT NULL, target_finding_id uuid NOT NULL,
  candidate_source_id uuid NOT NULL, base_source_id uuid NOT NULL, suite_repository_link_id uuid, suite_definition_id uuid, suite_version integer,
  base_snapshot_digest text NOT NULL CHECK(base_snapshot_digest ~ '^[a-f0-9]{64}$'),
  candidate_tree_digest text NOT NULL CHECK(candidate_tree_digest ~ '^[a-f0-9]{64}$'), patch_digest text NOT NULL CHECK(patch_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','passed','failed','inconclusive','quarantined','expired')),
  reason text CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 160),
  runner_profile text NOT NULL CHECK(runner_profile='node24-npm-test'), sandbox_kind text NOT NULL CHECK(sandbox_kind='bwrap+systemd-scope'),
  runner_digest text CHECK(runner_digest IS NULL OR runner_digest ~ '^[a-f0-9]{64}$'),
  firecracker_digest text CHECK(firecracker_digest IS NULL OR firecracker_digest ~ '^[a-f0-9]{64}$'),
  kernel_digest text CHECK(kernel_digest IS NULL OR kernel_digest ~ '^[a-f0-9]{64}$'),
  rootfs_digest text CHECK(rootfs_digest IS NULL OR rootfs_digest ~ '^[a-f0-9]{64}$'),
  limits jsonb NOT NULL CHECK(jsonb_typeof(limits)='object' AND octet_length(limits::text)<=1024),
  lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  queued_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  PRIMARY KEY(organization_id,application_id,id),
  UNIQUE(organization_id,application_id,action_ref),
  FOREIGN KEY(organization_id,application_id,candidate_source_id) REFERENCES gotchu.customer_sources(organization_id,application_id,id),
  FOREIGN KEY(organization_id,application_id,base_source_id) REFERENCES gotchu.customer_sources(organization_id,application_id,id),
  FOREIGN KEY(organization_id,application_id,suite_repository_link_id,suite_definition_id,suite_version) REFERENCES gotchu.validation_suite_definitions(organization_id,application_id,repository_link_id,id,version),
  CHECK((state IN ('running','quarantined'))=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK(state NOT IN ('passed','failed','inconclusive','expired') OR finished_at IS NOT NULL)
);
CREATE INDEX validation_runs_claimable ON gotchu.validation_runs(queued_at,id) WHERE state='queued';
CREATE TABLE gotchu.validation_keys (
  id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'), public_key text NOT NULL CHECK(length(public_key) BETWEEN 1 AND 256), created_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz
);
CREATE TABLE gotchu.validation_attestations (
  organization_id uuid NOT NULL, application_id uuid NOT NULL, run_id uuid NOT NULL, id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('base_reproduction','candidate_regression','functional_suite','independent_rescan')),
  body jsonb NOT NULL CHECK(octet_length(body::text)<=65536), key_id text NOT NULL REFERENCES gotchu.validation_keys(id),
  signature text NOT NULL CHECK(length(signature) BETWEEN 80 AND 100), created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY(organization_id,application_id,run_id,id), UNIQUE(organization_id,application_id,run_id,kind),
  FOREIGN KEY(organization_id,application_id,run_id) REFERENCES gotchu.validation_runs(organization_id,application_id,id),
  CHECK(body->>'id'=id::text AND body->>'runId'=run_id::text AND body->>'organizationId'=organization_id::text AND body->>'applicationId'=application_id::text)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['validation_suite_definitions','validation_runs','validation_attestations'] LOOP
    EXECUTE format('ALTER TABLE gotchu.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE gotchu.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON gotchu.%I USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id())',t);
  END LOOP;
END $$;
ALTER TABLE gotchu.validation_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.validation_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY validation_key_public_read ON gotchu.validation_keys TO gotchu_api,gotchu_validator USING(true) WITH CHECK(true);
CREATE POLICY validation_key_owner ON gotchu.validation_keys TO gotchu_owner USING(true) WITH CHECK(true);
CREATE POLICY owner_validation_claim ON gotchu.validation_runs TO gotchu_owner USING(true) WITH CHECK(true);
REVOKE ALL ON gotchu.validation_suite_definitions,gotchu.validation_runs,gotchu.validation_attestations,gotchu.validation_keys FROM PUBLIC;
GRANT SELECT,INSERT ON gotchu.validation_suite_definitions TO gotchu_api;
GRANT SELECT,INSERT ON gotchu.validation_runs TO gotchu_api;
GRANT SELECT ON gotchu.validation_suite_definitions,gotchu.validation_runs,gotchu.validation_attestations,gotchu.validation_keys TO gotchu_api,gotchu_validator;
GRANT SELECT ON gotchu.customer_sources,gotchu.application_repository_links TO gotchu_validator;
GRANT SELECT ON gotchu.customer_reports TO gotchu_validator;
GRANT UPDATE(state,reason,lease_token,lease_until,attempts,started_at,finished_at,runner_digest,firecracker_digest,kernel_digest,rootfs_digest) ON gotchu.validation_runs TO gotchu_validator;
GRANT INSERT ON gotchu.validation_attestations,gotchu.validation_keys TO gotchu_validator;

CREATE FUNCTION gotchu.validation_claim(p_token uuid,p_lease_ms integer) RETURNS TABLE(organization_id uuid,application_id uuid,run_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gotchu AS $$
BEGIN
  IF p_token IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 300000 THEN RAISE EXCEPTION 'invalid_validation_claim'; END IF;
  UPDATE gotchu.validation_runs SET state='quarantined',reason='lease_expired',finished_at=NULL
    WHERE state='running' AND lease_until<=clock_timestamp();
  IF EXISTS(SELECT 1 FROM gotchu.validation_runs WHERE state='quarantined') THEN RETURN; END IF;
  RETURN QUERY WITH next_run AS (
    SELECT v.organization_id,v.application_id,v.id FROM gotchu.validation_runs v
    WHERE v.state='queued' AND v.expires_at>clock_timestamp()
    ORDER BY v.queued_at,v.id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE gotchu.validation_runs v SET state='running',lease_token=p_token,
    lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond',attempts=v.attempts+1,
    started_at=coalesce(v.started_at,clock_timestamp())
    FROM next_run n WHERE v.organization_id=n.organization_id AND v.application_id=n.application_id AND v.id=n.id
    RETURNING v.organization_id,v.application_id,v.id;
END $$;
REVOKE ALL ON FUNCTION gotchu.validation_claim(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.validation_claim(uuid,integer) TO gotchu_validator;

CREATE FUNCTION gotchu.validation_attestation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'validation_attestations_are_immutable' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION gotchu.validation_attestation_immutable() FROM PUBLIC;
CREATE TRIGGER validation_attestation_immutable BEFORE UPDATE OR DELETE ON gotchu.validation_attestations
  FOR EACH ROW EXECUTE FUNCTION gotchu.validation_attestation_immutable();

GRANT USAGE ON SCHEMA gotchu TO gotchu_validator;
GRANT EXECUTE ON FUNCTION gotchu.tenant_id() TO gotchu_validator;
