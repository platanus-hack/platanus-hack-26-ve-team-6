CREATE TABLE gotchu.workspace_retention_policies (
  organization_id uuid PRIMARY KEY REFERENCES gotchu.organizations(id) ON DELETE CASCADE,
  source_snapshot_days integer NOT NULL DEFAULT 90 CHECK(source_snapshot_days BETWEEN 1 AND 3650),
  container_image_days integer NOT NULL DEFAULT 30 CHECK(container_image_days BETWEEN 1 AND 3650),
  report_days integer NOT NULL DEFAULT 365 CHECK(report_days BETWEEN 1 AND 3650),
  observation_days integer NOT NULL DEFAULT 30 CHECK(observation_days BETWEEN 1 AND 3650),
  run_days integer NOT NULL DEFAULT 30 CHECK(run_days BETWEEN 1 AND 3650),
  notification_delivery_days integer NOT NULL DEFAULT 90 CHECK(notification_delivery_days BETWEEN 1 AND 3650),
  protection_event_days integer NOT NULL DEFAULT 30 CHECK(protection_event_days BETWEEN 1 AND 3650),
  updated_by text NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE gotchu.workspace_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.workspace_retention_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.workspace_retention_policies
  USING(organization_id=gotchu.tenant_id()) WITH CHECK(organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.workspace_retention_policies FROM PUBLIC;
GRANT SELECT ON gotchu.workspace_retention_policies TO gotchu_api;
GRANT INSERT(organization_id,source_snapshot_days,container_image_days,report_days,observation_days,run_days,notification_delivery_days,protection_event_days,updated_by)
  ON gotchu.workspace_retention_policies TO gotchu_api;
GRANT UPDATE(source_snapshot_days,container_image_days,report_days,observation_days,run_days,notification_delivery_days,protection_event_days,updated_by,updated_at)
  ON gotchu.workspace_retention_policies TO gotchu_api;

CREATE FUNCTION gotchu.retention_initialize_workspace() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gotchu AS $$
DECLARE previous_organization text:=current_setting('gotchu.organization_id',true);
        previous_retention_worker text:=current_setting('gotchu.retention_worker',true);
        previous_row_security text:=current_setting('row_security',true);
BEGIN
  PERFORM set_config('gotchu.organization_id',NEW.id::text,true);
  PERFORM set_config('gotchu.retention_worker','enabled',true);
  PERFORM set_config('row_security','on',true);
  INSERT INTO gotchu.workspace_retention_policies(organization_id,updated_by)
    VALUES(NEW.id,'system:workspace-defaults') ON CONFLICT(organization_id) DO NOTHING;
  PERFORM set_config('row_security',coalesce(previous_row_security,'on'),true);
  PERFORM set_config('gotchu.retention_worker',coalesce(previous_retention_worker,''),true);
  PERFORM set_config('gotchu.organization_id',coalesce(previous_organization,''),true);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.retention_initialize_workspace() FROM PUBLIC;
CREATE TRIGGER workspace_retention_initialize AFTER INSERT ON gotchu.organizations
  FOR EACH ROW EXECUTE FUNCTION gotchu.retention_initialize_workspace();

CREATE TABLE gotchu.retention_purge_jobs (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  job_id uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed')),
  next_due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1000000),
  last_completed_at timestamptz,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(octet_length(last_result::text)<=4096),
  PRIMARY KEY(organization_id,application_id),
  FOREIGN KEY(organization_id,application_id) REFERENCES gotchu.applications(organization_id,id) ON DELETE CASCADE,
  CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
     OR (state<>'running' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX retention_purge_jobs_due ON gotchu.retention_purge_jobs(next_due_at,organization_id,application_id)
  WHERE state<>'running';
ALTER TABLE gotchu.retention_purge_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.retention_purge_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.retention_purge_jobs
  USING(organization_id=gotchu.tenant_id()) WITH CHECK(organization_id=gotchu.tenant_id());
CREATE POLICY retention_worker ON gotchu.retention_purge_jobs TO gotchu_owner
  USING(current_setting('gotchu.retention_worker',true)='enabled')
  WITH CHECK(current_setting('gotchu.retention_worker',true)='enabled');
REVOKE ALL ON gotchu.retention_purge_jobs FROM PUBLIC,gotchu_api,gotchu_coordinator,gotchu_ingest,gotchu_executor,gotchu_validator;

CREATE FUNCTION gotchu.retention_initialize_application() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gotchu AS $$
DECLARE previous_organization text:=current_setting('gotchu.organization_id',true);
        previous_retention_worker text:=current_setting('gotchu.retention_worker',true);
        previous_row_security text:=current_setting('row_security',true);
BEGIN
  PERFORM set_config('gotchu.organization_id',NEW.organization_id::text,true);
  PERFORM set_config('gotchu.retention_worker','enabled',true);
  PERFORM set_config('row_security','on',true);
  INSERT INTO gotchu.retention_purge_jobs(organization_id,application_id)
    VALUES(NEW.organization_id,NEW.id) ON CONFLICT(organization_id,application_id) DO NOTHING;
  PERFORM set_config('row_security',coalesce(previous_row_security,'on'),true);
  PERFORM set_config('gotchu.retention_worker',coalesce(previous_retention_worker,''),true);
  PERFORM set_config('gotchu.organization_id',coalesce(previous_organization,''),true);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.retention_initialize_application() FROM PUBLIC;
CREATE TRIGGER application_retention_initialize AFTER INSERT ON gotchu.applications
  FOR EACH ROW EXECUTE FUNCTION gotchu.retention_initialize_application();

INSERT INTO gotchu.workspace_retention_policies(organization_id,updated_by)
  SELECT id,'system:workspace-defaults' FROM gotchu.organizations ON CONFLICT(organization_id) DO NOTHING;
INSERT INTO gotchu.retention_purge_jobs(organization_id,application_id)
  SELECT organization_id,id FROM gotchu.applications ON CONFLICT(organization_id,application_id) DO NOTHING;
