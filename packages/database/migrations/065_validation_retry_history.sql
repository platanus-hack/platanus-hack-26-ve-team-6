-- Keep every attempt and its immutable attestations; only active attempts conflict.
ALTER TABLE gotchu.validation_runs
  DROP CONSTRAINT validation_runs_organization_id_application_id_action_ref_key;
CREATE UNIQUE INDEX validation_runs_one_active_action
  ON gotchu.validation_runs(organization_id,application_id,action_ref)
  WHERE state IN ('queued','running','quarantined');
-- Source-patch correction replay retains its original one-run contract.
CREATE UNIQUE INDEX validation_runs_one_correction_action
  ON gotchu.validation_runs(organization_id,application_id,action_ref)
  WHERE validation_mode='correction';
CREATE INDEX validation_runs_candidate_history
  ON gotchu.validation_runs(organization_id,application_id,candidate_source_id,queued_at);

GRANT UPDATE(validation_run_id) ON gotchu.dependency_fix_candidates TO gotchu_api;
CREATE OR REPLACE FUNCTION gotchu.dependency_fix_candidate_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' AND current_user='gotchu_owner'
    AND current_setting('gotchu.retention_purge',true)='enabled' THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'validation_run_id')=(to_jsonb(OLD)-'validation_run_id')
    AND NEW.validation_run_id<>OLD.validation_run_id
    AND EXISTS(SELECT 1 FROM gotchu.validation_runs v
      WHERE v.organization_id=OLD.organization_id AND v.application_id=OLD.application_id
        AND v.id=OLD.validation_run_id AND v.state IN ('failed','inconclusive'))
    AND EXISTS(SELECT 1 FROM gotchu.validation_runs v
      WHERE v.organization_id=NEW.organization_id AND v.application_id=NEW.application_id
        AND v.id=NEW.validation_run_id AND v.state='queued' AND v.validation_mode='dependency'
        AND v.action_ref=NEW.candidate_source_id AND v.candidate_source_id=NEW.candidate_source_id
        AND v.base_source_id=NEW.base_source_id AND v.suite_repository_link_id=NEW.repository_link_id
        AND v.base_snapshot_digest=NEW.base_digest AND v.candidate_tree_digest=NEW.candidate_digest
        AND v.patch_digest=NEW.patch_sha256 AND v.target_finding_id=NEW.finding_id
        AND v.target_finding_ids=NEW.finding_ids
        AND v.dependency_allowlist=jsonb_build_array(jsonb_build_object(
          'name',NEW.package_name,'section',NEW.dependency_section,'version',NEW.to_version)))
    THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'dependency_fix_candidate_immutable';
END $$;
