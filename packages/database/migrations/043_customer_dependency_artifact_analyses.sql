-- Keep exact published-package analysis searchable and tenant-bound alongside its report.
CREATE TABLE gotchu.customer_dependency_artifact_analyses (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  report_id uuid NOT NULL,
  package_name text NOT NULL CHECK (length(package_name) BETWEEN 1 AND 214),
  package_version text NOT NULL CHECK (length(package_version) BETWEEN 1 AND 100),
  purl text NOT NULL CHECK (length(purl) BETWEEN 1 AND 512),
  analysis jsonb NOT NULL CHECK ((
    jsonb_typeof(analysis) = 'object'
    AND analysis->>'status' IN ('not_requested','verified','checksum_mismatch','unavailable','unsafe_archive','scan_incomplete')
    AND octet_length(analysis::text) <= 262144
  ) IS TRUE),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, application_id, report_id, purl),
  FOREIGN KEY (organization_id, application_id, report_id)
    REFERENCES gotchu.customer_reports(organization_id, application_id, id)
);

ALTER TABLE gotchu.customer_dependency_artifact_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.customer_dependency_artifact_analyses FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_dependency_artifacts_tenant ON gotchu.customer_dependency_artifact_analyses
  USING (organization_id = gotchu.tenant_id())
  WITH CHECK (organization_id = gotchu.tenant_id());
REVOKE ALL ON gotchu.customer_dependency_artifact_analyses FROM PUBLIC;
GRANT SELECT ON gotchu.customer_dependency_artifact_analyses TO gotchu_api, gotchu_coordinator;
GRANT INSERT ON gotchu.customer_dependency_artifact_analyses TO gotchu_coordinator;
CREATE INDEX customer_dependency_artifact_package ON gotchu.customer_dependency_artifact_analyses
  (organization_id, application_id, package_name, package_version, created_at DESC);

CREATE FUNCTION gotchu.customer_dependency_artifact_analysis_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'customer_dependency_artifact_analysis_immutable';
END $$;
REVOKE ALL ON FUNCTION gotchu.customer_dependency_artifact_analysis_immutable() FROM PUBLIC;
CREATE TRIGGER customer_dependency_artifact_analysis_no_change
  BEFORE UPDATE OR DELETE ON gotchu.customer_dependency_artifact_analyses
  FOR EACH ROW EXECUTE FUNCTION gotchu.customer_dependency_artifact_analysis_immutable();
