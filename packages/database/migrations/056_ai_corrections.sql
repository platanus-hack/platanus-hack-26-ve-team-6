CREATE TABLE gotchu.ai_correction_requests (
  organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL,
  job_id uuid NOT NULL, report_id uuid NOT NULL, finding_id uuid NOT NULL,
  base_source_id uuid NOT NULL, source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 256),
  model_config_sha256 text NOT NULL CHECK (model_config_sha256 ~ '^[a-f0-9]{64}$'),
  authorized_files jsonb NOT NULL CHECK (jsonb_typeof(authorized_files)='array' AND jsonb_array_length(authorized_files) BETWEEN 1 AND 4 AND octet_length(authorized_files::text)<=4096),
  suggestion jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','prepared','failed','cancelled','reconciliation_required')),
  model_patch jsonb CHECK (jsonb_typeof(model_patch)='object' AND octet_length(model_patch::text)<=65536),
  candidate_source_id uuid, patch_hash text CHECK (patch_hash ~ '^[a-f0-9]{64}$'),
  validation_run_id uuid, rescan_job_id uuid,
  summary text CHECK (length(summary)<=2000), reason_code text CHECK (length(reason_code)<=100),
  implications jsonb NOT NULL DEFAULT '[]', risks jsonb NOT NULL DEFAULT '[]', validation_plan jsonb NOT NULL DEFAULT '[]',
  diff jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(diff)='array' AND jsonb_array_length(diff)<=4 AND octet_length(diff::text)<=600000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,application_id,id), UNIQUE (organization_id,application_id,job_id),
  FOREIGN KEY (organization_id,application_id,job_id) REFERENCES gotchu.jobs(organization_id,application_id,id),
  FOREIGN KEY (organization_id,application_id,report_id) REFERENCES gotchu.customer_reports(organization_id,application_id,id),
  FOREIGN KEY (organization_id,application_id,base_source_id) REFERENCES gotchu.customer_sources(organization_id,application_id,id),
  FOREIGN KEY (organization_id,application_id,candidate_source_id) REFERENCES gotchu.customer_sources(organization_id,application_id,id),
  FOREIGN KEY (organization_id,application_id,rescan_job_id) REFERENCES gotchu.customer_requests(organization_id,application_id,job_id),
  FOREIGN KEY (organization_id,application_id,validation_run_id) REFERENCES gotchu.validation_runs(organization_id,application_id,id),
  CHECK (state <> 'prepared' OR (candidate_source_id IS NOT NULL AND patch_hash IS NOT NULL AND validation_run_id IS NOT NULL AND rescan_job_id IS NOT NULL))
);
CREATE UNIQUE INDEX ai_correction_active_selection ON gotchu.ai_correction_requests(organization_id,application_id,report_id,finding_id,source_digest)
  WHERE state IN ('queued','running','prepared','reconciliation_required');
ALTER TABLE gotchu.ai_correction_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.ai_correction_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.ai_correction_requests
  USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.ai_correction_requests FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON gotchu.ai_correction_requests TO gotchu_api,gotchu_coordinator;

-- Serialize consent/configuration changes without giving the coordinator settings write access.
CREATE FUNCTION gotchu.lock_ai_correction_model(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() THEN RAISE EXCEPTION 'tenant mismatch'; END IF;
  PERFORM 1 FROM gotchu.investigation_model_settings WHERE organization_id=p_org FOR SHARE;
END $$;
REVOKE ALL ON FUNCTION gotchu.lock_ai_correction_model(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.lock_ai_correction_model(uuid),gotchu.lock_membership(uuid,text) TO gotchu_coordinator;
GRANT EXECUTE ON FUNCTION gotchu.lock_ai_correction_model(uuid) TO gotchu_api;
-- Finalization reuses source admission, static assessment admission and validation queuing.
GRANT INSERT ON gotchu.customer_sources,gotchu.customer_requests,gotchu.validation_runs TO gotchu_coordinator;
GRANT SELECT ON gotchu.customer_license_policies,gotchu.validation_suite_definitions TO gotchu_coordinator;
