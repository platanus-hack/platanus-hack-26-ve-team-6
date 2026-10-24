CREATE FUNCTION gotchu.retention_trim_monitoring(p_organization uuid,p_application uuid,p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gotchu AS $$
DECLARE
  run_ids uuid[]; observation_ids uuid[]; plan_ids uuid[];
  run_count integer:=0; observation_count integer:=0; plan_count integer:=0; detail jsonb;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() OR p_application IS NULL OR p_job IS NULL THEN
    RAISE EXCEPTION 'invalid_retention_quota_scope';
  END IF;
  PERFORM set_config('gotchu.retention_worker','enabled',true);
  PERFORM 1 FROM gotchu.retention_purge_jobs WHERE organization_id=p_organization AND application_id=p_application
    AND job_id=p_job AND state='completed' AND last_completed_at>=transaction_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention_quota_claim_stale'; END IF;

  run_ids:=ARRAY(SELECT r.id FROM gotchu.operation_runs r WHERE r.organization_id=p_organization AND r.application_id=p_application AND r.status<>'running'
    ORDER BY r.created_at,r.id LIMIT LEAST(GREATEST((SELECT count(*)::integer-999 FROM gotchu.operation_runs WHERE organization_id=p_organization AND application_id=p_application),0),500));
  DELETE FROM gotchu.operation_runs WHERE organization_id=p_organization AND application_id=p_application AND id=ANY(run_ids);
  GET DIAGNOSTICS run_count=ROW_COUNT;

  observation_ids:=ARRAY(SELECT o.id FROM gotchu.operation_observations o WHERE o.organization_id=p_organization AND o.application_id=p_application
    ORDER BY o.created_at,o.id LIMIT LEAST(GREATEST((SELECT count(*)::integer-1999 FROM gotchu.operation_observations WHERE organization_id=p_organization AND application_id=p_application),0),500));
  plan_ids:=ARRAY(SELECT p.id FROM gotchu.operation_plans p WHERE p.organization_id=p_organization AND p.application_id=p_application
    AND (EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.body->'observationIds')='array' THEN p.body->'observationIds' ELSE '[]'::jsonb END) refs(value)
        WHERE refs.value=ANY(ARRAY(SELECT unnest(observation_ids)::text))
          OR NOT EXISTS(SELECT 1 FROM gotchu.operation_observations o WHERE o.organization_id=p_organization AND o.application_id=p_application AND o.id::text=refs.value))
      OR p.id=ANY(ARRAY(SELECT old.id FROM gotchu.operation_plans old WHERE old.organization_id=p_organization AND old.application_id=p_application
        ORDER BY old.created_at,old.id LIMIT LEAST(GREATEST((SELECT count(*)::integer-99 FROM gotchu.operation_plans WHERE organization_id=p_organization AND application_id=p_application),0),500)))));
  DELETE FROM gotchu.operation_plans WHERE organization_id=p_organization AND application_id=p_application AND id=ANY(plan_ids);
  GET DIAGNOSTICS plan_count=ROW_COUNT;
  DELETE FROM gotchu.operation_alerts WHERE organization_id=p_organization AND application_id=p_application AND observation_id=ANY(observation_ids);
  DELETE FROM gotchu.operation_observations WHERE organization_id=p_organization AND application_id=p_application AND id=ANY(observation_ids);
  GET DIAGNOSTICS observation_count=ROW_COUNT;

  detail:=jsonb_build_object('runsTrimmed',run_count,'observationsTrimmed',observation_count,'plansTrimmed',plan_count);
  IF run_count>0 OR observation_count>0 OR plan_count>0 THEN
    UPDATE gotchu.retention_purge_jobs SET last_result=last_result||detail
      WHERE organization_id=p_organization AND application_id=p_application AND job_id=p_job;
    INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail)
      VALUES(p_organization,gen_random_uuid(),'system:retention','retention.quota_pruned',p_application,detail);
  END IF;
  PERFORM set_config('gotchu.retention_worker','',true);
  RETURN detail;
END $$;
REVOKE ALL ON FUNCTION gotchu.retention_trim_monitoring(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.retention_trim_monitoring(uuid,uuid,uuid) TO gotchu_coordinator;

CREATE FUNCTION gotchu.retention_monitoring_cadence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.state='running' AND NEW.state='completed' THEN NEW.next_due_at:=clock_timestamp()+interval '10 minutes'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.retention_monitoring_cadence() FROM PUBLIC;
CREATE TRIGGER retention_monitoring_cadence BEFORE UPDATE ON gotchu.retention_purge_jobs
  FOR EACH ROW EXECUTE FUNCTION gotchu.retention_monitoring_cadence();
