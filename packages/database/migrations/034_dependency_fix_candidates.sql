CREATE TABLE gotchu.customer_source_repository_bindings (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  source_id uuid NOT NULL,
  repository_link_id uuid NOT NULL,
  commit_sha text NOT NULL CHECK(commit_sha ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'),
  source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,application_id,source_id),
  FOREIGN KEY(organization_id,application_id,source_id) REFERENCES gotchu.customer_sources(organization_id,application_id,id),
  FOREIGN KEY(organization_id,application_id,repository_link_id) REFERENCES gotchu.application_repository_links(organization_id,application_id,id)
);
ALTER TABLE gotchu.customer_source_repository_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.customer_source_repository_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_source_repository_binding_tenant ON gotchu.customer_source_repository_bindings
  USING(organization_id=gotchu.tenant_id()) WITH CHECK(organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.customer_source_repository_bindings FROM PUBLIC;
GRANT SELECT ON gotchu.customer_source_repository_bindings TO gotchu_api;
CREATE FUNCTION gotchu.customer_source_repository_binding_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'customer_source_repository_binding_immutable'; END $$;
CREATE TRIGGER customer_source_repository_binding_no_change
  BEFORE UPDATE OR DELETE ON gotchu.customer_source_repository_bindings
  FOR EACH ROW EXECUTE FUNCTION gotchu.customer_source_repository_binding_immutable();

CREATE FUNCTION gotchu.bind_materialized_repository_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gotchu AS $$
DECLARE source_row gotchu.customer_sources; repository_id uuid; repository_count integer; source_commit text;
BEGIN
  IF NEW.job_id IS NULL OR NEW.repository_digest IS NULL OR OLD.repository_digest IS NOT NULL THEN RETURN NEW; END IF;
  SELECT s.* INTO source_row
    FROM gotchu.customer_requests q
    JOIN gotchu.customer_sources s ON s.organization_id=q.organization_id AND s.application_id=q.application_id AND s.id=q.source_id
    WHERE q.organization_id=NEW.organization_id AND q.application_id=NEW.application_id AND q.job_id=NEW.job_id
      AND s.digest=NEW.repository_digest AND s.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  source_commit:=source_row.body->>'revision';
  IF source_commit IS NULL OR source_commit !~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' THEN RETURN NEW; END IF;
  SELECT count(*) INTO repository_count
    FROM gotchu.operation_monitors m
    JOIN gotchu.application_repository_links l ON l.organization_id=m.organization_id AND l.application_id=m.application_id
      AND l.repository_key=m.repository_key AND NOT l.revoked AND l.read_access='granted' AND l.state='verified' AND l.installation_id IS NOT NULL
    JOIN gotchu.github_installations g ON g.organization_id=l.organization_id AND g.installation_id=l.installation_id AND g.state='active'
    WHERE m.organization_id=NEW.organization_id AND m.application_id=NEW.application_id;
  IF repository_count <> 1 THEN RETURN NEW; END IF;
  SELECT l.id INTO repository_id
    FROM gotchu.operation_monitors m
    JOIN gotchu.application_repository_links l ON l.organization_id=m.organization_id AND l.application_id=m.application_id
      AND l.repository_key=m.repository_key AND NOT l.revoked AND l.read_access='granted' AND l.state='verified' AND l.installation_id IS NOT NULL
    JOIN gotchu.github_installations g ON g.organization_id=l.organization_id AND g.installation_id=l.installation_id AND g.state='active'
    WHERE m.organization_id=NEW.organization_id AND m.application_id=NEW.application_id;
  INSERT INTO gotchu.customer_source_repository_bindings(organization_id,application_id,source_id,repository_link_id,commit_sha,source_digest)
    VALUES(NEW.organization_id,NEW.application_id,source_row.id,repository_id,source_commit,source_row.digest)
    ON CONFLICT(organization_id,application_id,source_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.bind_materialized_repository_source() FROM PUBLIC;
CREATE TRIGGER operation_materialized_repository_source_binding
  AFTER UPDATE OF job_id,repository_digest ON gotchu.operation_runs
  FOR EACH ROW EXECUTE FUNCTION gotchu.bind_materialized_repository_source();

CREATE TABLE gotchu.dependency_fix_candidates (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  candidate_source_id uuid NOT NULL,
  report_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  finding_ids jsonb NOT NULL CHECK(jsonb_typeof(finding_ids)='array' AND jsonb_array_length(finding_ids) BETWEEN 1 AND 20),
  base_source_id uuid NOT NULL,
  repository_link_id uuid NOT NULL,
  base_commit text NOT NULL CHECK(base_commit ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'),
  package_name text NOT NULL CHECK(length(package_name) BETWEEN 1 AND 214),
  dependency_section text NOT NULL CHECK(dependency_section IN ('dependencies','devDependencies','optionalDependencies')),
  from_version text NOT NULL CHECK(from_version ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'),
  to_version text NOT NULL CHECK(to_version ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'),
  advisory_ids jsonb NOT NULL CHECK(jsonb_typeof(advisory_ids)='array' AND jsonb_array_length(advisory_ids) BETWEEN 1 AND 20),
  package_json_path text NOT NULL CHECK(length(package_json_path) BETWEEN 1 AND 512),
  package_lock_path text NOT NULL CHECK(length(package_lock_path) BETWEEN 1 AND 512),
  base_digest text NOT NULL CHECK(base_digest ~ '^[a-f0-9]{64}$'),
  candidate_digest text NOT NULL CHECK(candidate_digest ~ '^[a-f0-9]{64}$'),
  lockfile_sha256 text NOT NULL CHECK(lockfile_sha256 ~ '^[a-f0-9]{64}$'),
  patch_sha256 text NOT NULL CHECK(patch_sha256 ~ '^[a-f0-9]{64}$'),
  validation_run_id uuid NOT NULL,
  created_by text NOT NULL CHECK(length(created_by) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,application_id,candidate_source_id),
  UNIQUE(organization_id,application_id,report_id,package_name,from_version),
  FOREIGN KEY(organization_id,application_id,candidate_source_id) REFERENCES gotchu.customer_sources(organization_id,application_id,id),
  FOREIGN KEY(organization_id,application_id,base_source_id) REFERENCES gotchu.customer_sources(organization_id,application_id,id),
  FOREIGN KEY(organization_id,application_id,report_id) REFERENCES gotchu.customer_reports(organization_id,application_id,id),
  FOREIGN KEY(organization_id,application_id,repository_link_id) REFERENCES gotchu.application_repository_links(organization_id,application_id,id),
  FOREIGN KEY(organization_id,application_id,validation_run_id) REFERENCES gotchu.validation_runs(organization_id,application_id,id),
  CHECK(from_version <> to_version),
  CHECK(candidate_source_id <> base_source_id)
);
ALTER TABLE gotchu.dependency_fix_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.dependency_fix_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY dependency_fix_candidate_tenant ON gotchu.dependency_fix_candidates
  USING(organization_id=gotchu.tenant_id()) WITH CHECK(organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.dependency_fix_candidates FROM PUBLIC;
GRANT SELECT,INSERT ON gotchu.dependency_fix_candidates TO gotchu_api;
GRANT SELECT ON gotchu.dependency_fix_candidates TO gotchu_executor;
CREATE FUNCTION gotchu.dependency_fix_candidate_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'dependency_fix_candidate_immutable'; END $$;
CREATE TRIGGER dependency_fix_candidate_no_change
  BEFORE UPDATE OR DELETE ON gotchu.dependency_fix_candidates
  FOR EACH ROW EXECUTE FUNCTION gotchu.dependency_fix_candidate_immutable();
CREATE INDEX dependency_fix_candidates_report ON gotchu.dependency_fix_candidates(organization_id,application_id,report_id,created_at DESC);

ALTER TABLE gotchu.validation_runs
  ADD COLUMN validation_mode text NOT NULL DEFAULT 'correction' CHECK(validation_mode IN ('correction','dependency')),
  ADD COLUMN target_finding_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK(jsonb_typeof(target_finding_ids)='array' AND jsonb_array_length(target_finding_ids)<=20),
  ADD COLUMN dependency_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK(jsonb_typeof(dependency_allowlist)='array' AND jsonb_array_length(dependency_allowlist)<=20);

GRANT SELECT(commit_message,tree_sha,base_commit,candidate_source_id,snapshot_sha256,patch_sha256,artifact_sha256,size_bytes,tree_complete,unsupported_reason)
  ON gotchu.execution_artifacts TO gotchu_api;
