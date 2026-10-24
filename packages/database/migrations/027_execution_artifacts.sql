ALTER TABLE gotchu.validation_runs
  ADD COLUMN cleanup_verified boolean NOT NULL DEFAULT false;
ALTER TABLE gotchu.validation_runs
  DROP CONSTRAINT validation_runs_sandbox_kind_check,
  ADD CONSTRAINT validation_runs_sandbox_kind_check CHECK(sandbox_kind IN ('bwrap+systemd-scope','jailer'));
GRANT UPDATE(cleanup_verified) ON gotchu.validation_runs TO gotchu_validator;
GRANT SELECT ON gotchu.validation_runs,gotchu.validation_attestations,gotchu.validation_keys TO gotchu_executor;
CREATE POLICY validation_key_executor_read ON gotchu.validation_keys TO gotchu_executor USING(true) WITH CHECK(true);

CREATE UNIQUE INDEX proposals_org_app_id_unique ON gotchu.proposals(organization_id,application_id,id);
CREATE TABLE gotchu.execution_artifacts (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  candidate_source_id uuid NOT NULL,
  base_commit text NOT NULL CHECK(base_commit ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'),
  files jsonb NOT NULL CHECK(jsonb_typeof(files)='array' AND octet_length(files::text)<=5600000),
  candidate_tree_sha text NOT NULL CHECK(candidate_tree_sha ~ '^[a-f0-9]{40}$'),
  tree_sha text CHECK(tree_sha IS NULL OR tree_sha ~ '^[a-f0-9]{40}$'),
  tree_complete boolean NOT NULL DEFAULT false,
  unsupported_reason text CHECK(unsupported_reason IS NULL OR unsupported_reason IN ('source_snapshot_completeness_unknown','artifact_patch_unsupported','repository_tree_truncated','repository_tree_unavailable')),
  commit_message text NOT NULL CHECK(length(commit_message) BETWEEN 1 AND 512),
  snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  patch_sha256 text NOT NULL CHECK(patch_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 0 AND 4194304),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,application_id,proposal_id),
  UNIQUE(organization_id,application_id,candidate_source_id),
  FOREIGN KEY(organization_id,application_id,proposal_id) REFERENCES gotchu.proposals(organization_id,application_id,id),
  FOREIGN KEY(organization_id,application_id,candidate_source_id) REFERENCES gotchu.customer_sources(organization_id,application_id,id),
  CHECK(artifact_sha256=snapshot_sha256),
  CHECK(jsonb_array_length(files) BETWEEN 0 AND 1000),
  CHECK((tree_complete AND tree_sha IS NOT NULL AND unsupported_reason IS NULL)
    OR (NOT tree_complete AND tree_sha IS NULL AND unsupported_reason IS NOT NULL))
);
ALTER TABLE gotchu.execution_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.execution_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_artifacts_tenant ON gotchu.execution_artifacts
  USING(organization_id=gotchu.tenant_id()) WITH CHECK(organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.execution_artifacts FROM PUBLIC;
GRANT INSERT ON gotchu.execution_artifacts TO gotchu_api;
GRANT SELECT(organization_id,application_id,proposal_id,candidate_source_id,base_commit,candidate_tree_sha,tree_sha,tree_complete,unsupported_reason,snapshot_sha256,patch_sha256,artifact_sha256,size_bytes)
  ON gotchu.execution_artifacts TO gotchu_api;
GRANT SELECT ON gotchu.execution_artifacts TO gotchu_executor;

CREATE FUNCTION gotchu.execution_artifact_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,gotchu AS $$
BEGIN
  RAISE EXCEPTION 'execution_artifacts_are_immutable';
END $$;
CREATE TRIGGER execution_artifact_no_change
  BEFORE UPDATE OR DELETE ON gotchu.execution_artifacts
  FOR EACH ROW EXECUTE FUNCTION gotchu.execution_artifact_immutable();

CREATE TABLE gotchu.workflow_policy_exceptions (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  repository_link_id uuid NOT NULL,
  exception_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  workflow_path text NOT NULL CHECK(workflow_path ~ '^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$'),
  rule text NOT NULL CHECK(rule IN ('invalid_yaml','invalid_document','pull_request_target','push_without_branch_filter','push_to_gotchu_branch','forbidden_pull_request_secret')),
  justification text NOT NULL CHECK(length(btrim(justification)) BETWEEN 12 AND 1000),
  exception_hash text NOT NULL CHECK(exception_hash ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK(length(created_by) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by text,
  PRIMARY KEY(organization_id,application_id,repository_link_id,exception_id,version),
  UNIQUE(organization_id,application_id,repository_link_id,workflow_path,rule,version),
  FOREIGN KEY(organization_id,application_id,repository_link_id) REFERENCES gotchu.application_repository_links(organization_id,application_id,id),
  CHECK((removed_at IS NULL)=(removed_by IS NULL))
);
ALTER TABLE gotchu.workflow_policy_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.workflow_policy_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_policy_exceptions_tenant ON gotchu.workflow_policy_exceptions
  USING(organization_id=gotchu.tenant_id()) WITH CHECK(organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.workflow_policy_exceptions FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE(removed_at,removed_by) ON gotchu.workflow_policy_exceptions TO gotchu_api;
GRANT SELECT(organization_id,application_id,repository_link_id,workflow_path,rule,removed_at) ON gotchu.workflow_policy_exceptions TO gotchu_executor;
CREATE INDEX workflow_policy_exceptions_active ON gotchu.workflow_policy_exceptions(organization_id,application_id,repository_link_id,workflow_path,rule) WHERE removed_at IS NULL;
