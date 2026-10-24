CREATE POLICY retention_worker ON gotchu.workspace_retention_policies TO gotchu_owner
  USING(current_setting('gotchu.retention_worker',true)='enabled')
  WITH CHECK(current_setting('gotchu.retention_worker',true)='enabled');

CREATE OR REPLACE FUNCTION gotchu.dependency_fix_candidate_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' AND current_user='gotchu_owner'
    AND current_setting('gotchu.retention_purge',true)='enabled' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'dependency_fix_candidate_immutable';
END $$;

CREATE FUNCTION gotchu.retention_claim_due(p_limit integer DEFAULT 10,p_lease_ms integer DEFAULT 300000,p_organization uuid DEFAULT NULL)
RETURNS TABLE(organization_id uuid,application_id uuid,job_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item record; next_job uuid; token uuid;
BEGIN
  IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
    OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 300000
    OR p_organization='00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'invalid_retention_claim';
  END IF;
  PERFORM set_config('gotchu.retention_worker','enabled',true);
  FOR item IN SELECT j.organization_id,j.application_id
    FROM gotchu.retention_purge_jobs j
    WHERE (p_organization IS NULL OR j.organization_id=p_organization)
      AND ((j.state<>'running' AND j.next_due_at<=clock_timestamp())
       OR (j.state='running' AND j.lease_until<=clock_timestamp())
      )
    ORDER BY j.next_due_at,j.organization_id,j.application_id
    LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    next_job:=gen_random_uuid(); token:=gen_random_uuid();
    UPDATE gotchu.retention_purge_jobs j SET job_id=next_job,state='running',lease_token=token,
      lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond',attempts=LEAST(attempts+1,1000000)
      WHERE j.organization_id=item.organization_id AND j.application_id=item.application_id;
    organization_id:=item.organization_id; application_id:=item.application_id; job_id:=next_job; lease_token:=token;
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('gotchu.retention_worker','',true);
END $$;
REVOKE ALL ON FUNCTION gotchu.retention_claim_due(integer,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.retention_claim_due(integer,integer,uuid) TO gotchu_coordinator;

CREATE FUNCTION gotchu.retention_purge(p_organization uuid,p_application uuid,p_job uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gotchu AS $$
DECLARE
  policy gotchu.workspace_retention_policies;
  source_ids uuid[]; image_ids uuid[]; report_ids uuid[]; assessment_report_ids uuid[]; observation_ids uuid[];
  run_ids uuid[]; delivery_ids uuid[]; protection_ids uuid[];
  candidate_ids uuid[]; proposal_ids uuid[];
  source_count integer:=0; image_count integer:=0; report_count integer:=0; customer_report_count integer:=0;
  observation_count integer:=0; run_count integer:=0; delivery_count integer:=0; protection_count integer:=0; proposal_count integer:=0;
  detail jsonb; batch_size integer:=500; has_backlog boolean;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() OR p_application IS NULL OR p_job IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'invalid_retention_scope';
  END IF;
  PERFORM set_config('gotchu.retention_worker','enabled',true);
  PERFORM set_config('gotchu.retention_purge','enabled',true);
  SELECT * INTO policy FROM gotchu.workspace_retention_policies WHERE organization_id=p_organization;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention_policy_missing'; END IF;
  PERFORM 1 FROM gotchu.retention_purge_jobs WHERE organization_id=p_organization AND application_id=p_application
    AND job_id=p_job AND state='running' AND lease_token=p_token AND lease_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention_claim_stale'; END IF;

  source_ids:=ARRAY(SELECT s.id FROM gotchu.customer_sources s
    WHERE s.organization_id=p_organization AND s.application_id=p_application AND s.body IS NOT NULL
      AND s.created_at<clock_timestamp()-make_interval(days=>policy.source_snapshot_days)
      AND NOT EXISTS(SELECT 1 FROM gotchu.customer_requests r JOIN gotchu.jobs j
        ON j.organization_id=r.organization_id AND j.application_id=r.application_id AND j.id=r.job_id
        WHERE r.organization_id=s.organization_id AND r.application_id=s.application_id AND r.source_id=s.id
          AND (j.state IN ('queued','running') OR (j.state='failed' AND j.result->>'reasonCode'='assessment_reconciliation_required')))
    ORDER BY s.created_at,s.id LIMIT batch_size);
  image_ids:=ARRAY(SELECT i.id FROM gotchu.customer_container_images i
    WHERE i.organization_id=p_organization AND i.application_id=p_application AND i.body IS NOT NULL
      AND i.created_at<clock_timestamp()-make_interval(days=>policy.container_image_days)
      AND NOT EXISTS(SELECT 1 FROM gotchu.customer_requests r JOIN gotchu.jobs j
        ON j.organization_id=r.organization_id AND j.application_id=r.application_id AND j.id=r.job_id
        WHERE r.organization_id=i.organization_id AND r.application_id=i.application_id AND r.container_image_id=i.id
          AND (j.state IN ('queued','running') OR (j.state='failed' AND j.result->>'reasonCode'='assessment_reconciliation_required')))
    ORDER BY i.created_at,i.id LIMIT batch_size);
  report_ids:=ARRAY(SELECT r.id FROM gotchu.customer_reports r
    WHERE r.organization_id=p_organization AND r.application_id=p_application
      AND r.created_at<clock_timestamp()-make_interval(days=>policy.report_days)
    ORDER BY r.created_at,r.id LIMIT batch_size);
  assessment_report_ids:=ARRAY(SELECT r.id FROM gotchu.assessment_reports r
    WHERE r.organization_id=p_organization AND r.application_id=p_application
      AND r.created_at<clock_timestamp()-make_interval(days=>policy.report_days)
      AND NOT EXISTS(SELECT 1 FROM gotchu.jobs j WHERE j.organization_id=r.organization_id AND j.application_id=r.application_id
        AND j.id=r.job_id AND j.state IN ('queued','running'))
    ORDER BY r.created_at,r.id LIMIT batch_size);

  candidate_ids:=ARRAY(
    SELECT unnest(source_ids)
    UNION
    SELECT c.candidate_source_id FROM gotchu.dependency_fix_candidates c
      WHERE c.organization_id=p_organization AND c.application_id=p_application
        AND (c.candidate_source_id=ANY(source_ids) OR c.base_source_id=ANY(source_ids) OR c.report_id=ANY(report_ids))
    UNION
    SELECT a.subject_id FROM gotchu.audit_records a WHERE a.organization_id=p_organization
      AND a.detail->>'applicationId'=p_application::text AND a.action='correction.prepared'
      AND (a.detail->>'originalSourceId'=ANY(ARRAY(SELECT unnest(source_ids)::text))
        OR a.detail->>'reportId'=ANY(ARRAY(SELECT unnest(report_ids)::text)))
  );
  proposal_ids:=ARRAY(SELECT p.id FROM gotchu.proposals p WHERE p.organization_id=p_organization AND p.application_id=p_application
    AND p.version=2 AND p.state IN ('proposed','eligible','ineligible','approved')
    AND p.source_ref->>'candidateId'=ANY(ARRAY(SELECT unnest(candidate_ids)::text)));
  IF cardinality(proposal_ids)>0 THEN
    UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='retention_source_purged',
      blocking_reasons='["la fuente de la propuesta venció por retención"]'::jsonb
      WHERE organization_id=p_organization AND application_id=p_application AND id=ANY(proposal_ids)
        AND state IN ('proposed','eligible','ineligible','approved');
    GET DIAGNOSTICS proposal_count=ROW_COUNT;
    UPDATE gotchu.approvals SET consumed_at=clock_timestamp()
      WHERE organization_id=p_organization AND proposal_id=ANY(proposal_ids) AND consumed_at IS NULL;
    UPDATE gotchu.step_up_proofs SET consumed_at=clock_timestamp()
      WHERE organization_id=p_organization AND consumed_at IS NULL
        AND action_hash IN (SELECT p.action_hash FROM gotchu.proposals p WHERE p.organization_id=p_organization AND p.id=ANY(proposal_ids));
  END IF;

  -- An executor may have claimed an approval while this purge waited on its proposal row.
  -- Recheck after invalidation so an executing/uncertain action keeps every source it may need to reconcile.
  source_ids:=ARRAY(SELECT source_id FROM unnest(source_ids) source_id WHERE NOT EXISTS(
    SELECT 1 FROM gotchu.proposals p WHERE p.organization_id=p_organization AND p.application_id=p_application
      AND p.state IN ('executing','uncertain','reconciliation_required') AND (
        p.source_ref->>'candidateId'=source_id::text
        OR EXISTS(SELECT 1 FROM gotchu.dependency_fix_candidates c WHERE c.organization_id=p.organization_id
          AND c.application_id=p.application_id AND c.base_source_id=source_id
          AND p.source_ref->>'candidateId'=c.candidate_source_id::text)
        OR EXISTS(SELECT 1 FROM gotchu.audit_records a WHERE a.organization_id=p.organization_id
          AND a.action='correction.prepared' AND a.subject_id::text=p.source_ref->>'candidateId'
          AND a.detail->>'originalSourceId'=source_id::text)
      )
  ));
  report_ids:=ARRAY(SELECT report_id FROM unnest(report_ids) report_id WHERE NOT EXISTS(
    SELECT 1 FROM gotchu.proposals p WHERE p.organization_id=p_organization AND p.application_id=p_application
      AND p.state IN ('executing','uncertain','reconciliation_required') AND (
        EXISTS(SELECT 1 FROM gotchu.dependency_fix_candidates c WHERE c.organization_id=p.organization_id
          AND c.application_id=p.application_id AND c.report_id=report_id
          AND p.source_ref->>'candidateId'=c.candidate_source_id::text)
        OR EXISTS(SELECT 1 FROM gotchu.audit_records a WHERE a.organization_id=p.organization_id
          AND a.action='correction.prepared' AND a.subject_id::text=p.source_ref->>'candidateId'
          AND a.detail->>'reportId'=report_id::text)
      )
  ));

  DELETE FROM gotchu.dependency_fix_candidates c WHERE c.organization_id=p_organization AND c.application_id=p_application
    AND (c.candidate_source_id=ANY(source_ids) OR c.base_source_id=ANY(source_ids) OR c.report_id=ANY(report_ids));
  UPDATE gotchu.customer_sources SET body=NULL,deleted_at=clock_timestamp()
    WHERE organization_id=p_organization AND application_id=p_application AND id=ANY(source_ids) AND body IS NOT NULL;
  GET DIAGNOSTICS source_count=ROW_COUNT;
  UPDATE gotchu.customer_container_images SET body=NULL,deleted_at=clock_timestamp()
    WHERE organization_id=p_organization AND application_id=p_application AND id=ANY(image_ids) AND body IS NOT NULL;
  GET DIAGNOSTICS image_count=ROW_COUNT;
  DELETE FROM gotchu.customer_reports WHERE organization_id=p_organization AND application_id=p_application AND id=ANY(report_ids);
  GET DIAGNOSTICS customer_report_count=ROW_COUNT;
  DELETE FROM gotchu.assessment_reports WHERE organization_id=p_organization AND application_id=p_application AND id=ANY(assessment_report_ids);
  GET DIAGNOSTICS report_count=ROW_COUNT;
  report_count:=report_count+customer_report_count;

  observation_ids:=ARRAY(SELECT o.id FROM gotchu.operation_observations o
    WHERE o.organization_id=p_organization AND o.application_id=p_application
      AND o.created_at<clock_timestamp()-make_interval(days=>policy.observation_days)
    ORDER BY o.created_at,o.id LIMIT batch_size);
  DELETE FROM gotchu.operation_alerts WHERE organization_id=p_organization AND application_id=p_application AND observation_id=ANY(observation_ids);
  DELETE FROM gotchu.operation_observations WHERE organization_id=p_organization AND application_id=p_application AND id=ANY(observation_ids);
  GET DIAGNOSTICS observation_count=ROW_COUNT;

  run_ids:=ARRAY(SELECT r.id FROM gotchu.operation_runs r
    WHERE r.organization_id=p_organization AND r.application_id=p_application AND r.status<>'running'
      AND r.created_at<clock_timestamp()-make_interval(days=>policy.run_days)
    ORDER BY r.created_at,r.id LIMIT batch_size);
  DELETE FROM gotchu.operation_runs WHERE organization_id=p_organization AND application_id=p_application AND id=ANY(run_ids);
  GET DIAGNOSTICS run_count=ROW_COUNT;

  delivery_ids:=ARRAY(SELECT d.id FROM gotchu.notification_deliveries d
    WHERE d.organization_id=p_organization AND d.created_at<clock_timestamp()-make_interval(days=>policy.notification_delivery_days)
      AND (d.state<>'sending' OR d.lease_until<=clock_timestamp())
    ORDER BY d.created_at,d.id LIMIT batch_size);
  DELETE FROM gotchu.notification_deliveries WHERE organization_id=p_organization AND id=ANY(delivery_ids);
  GET DIAGNOSTICS delivery_count=ROW_COUNT;

  protection_ids:=ARRAY(SELECT p.event_id FROM gotchu.runtime_protection_events p
    WHERE p.organization_id=p_organization AND p.application_id=p_application
      AND p.received_at<clock_timestamp()-make_interval(days=>policy.protection_event_days)
    ORDER BY p.received_at,p.event_id LIMIT batch_size);
  DELETE FROM gotchu.runtime_protection_events WHERE organization_id=p_organization AND application_id=p_application AND event_id=ANY(protection_ids);
  GET DIAGNOSTICS protection_count=ROW_COUNT;

  detail:=jsonb_build_object('sourceSnapshots',source_count,'containerImages',image_count,'reports',report_count,
    'observations',observation_count,'runs',run_count,'notificationDeliveries',delivery_count,'protectionEvents',protection_count,
    'proposalsInvalidated',proposal_count);
  SELECT EXISTS(
    SELECT 1 FROM gotchu.customer_sources WHERE organization_id=p_organization AND application_id=p_application AND body IS NOT NULL
      AND created_at<clock_timestamp()-make_interval(days=>policy.source_snapshot_days)
    UNION ALL SELECT 1 FROM gotchu.customer_container_images WHERE organization_id=p_organization AND application_id=p_application AND body IS NOT NULL
      AND created_at<clock_timestamp()-make_interval(days=>policy.container_image_days)
    UNION ALL SELECT 1 FROM gotchu.customer_reports WHERE organization_id=p_organization AND application_id=p_application
      AND created_at<clock_timestamp()-make_interval(days=>policy.report_days)
    UNION ALL SELECT 1 FROM gotchu.assessment_reports WHERE organization_id=p_organization AND application_id=p_application
      AND created_at<clock_timestamp()-make_interval(days=>policy.report_days)
    UNION ALL SELECT 1 FROM gotchu.operation_observations WHERE organization_id=p_organization AND application_id=p_application
      AND created_at<clock_timestamp()-make_interval(days=>policy.observation_days)
    UNION ALL SELECT 1 FROM gotchu.operation_runs WHERE organization_id=p_organization AND application_id=p_application AND status<>'running'
      AND created_at<clock_timestamp()-make_interval(days=>policy.run_days)
    UNION ALL SELECT 1 FROM gotchu.notification_deliveries WHERE organization_id=p_organization
      AND created_at<clock_timestamp()-make_interval(days=>policy.notification_delivery_days) AND (state<>'sending' OR lease_until<=clock_timestamp())
    UNION ALL SELECT 1 FROM gotchu.runtime_protection_events WHERE organization_id=p_organization AND application_id=p_application
      AND received_at<clock_timestamp()-make_interval(days=>policy.protection_event_days)
  ) INTO has_backlog;

  UPDATE gotchu.retention_purge_jobs SET state='completed',lease_token=NULL,lease_until=NULL,
    last_completed_at=clock_timestamp(),last_result=detail,next_due_at=clock_timestamp()+CASE WHEN has_backlog THEN interval '10 minutes' ELSE interval '1 day' END
    WHERE organization_id=p_organization AND application_id=p_application AND job_id=p_job AND lease_token=p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention_claim_lost'; END IF;
  INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail)
    VALUES(p_organization,gen_random_uuid(),'system:retention','retention.purged',p_application,detail);
  PERFORM set_config('gotchu.retention_purge','',true);
  PERFORM set_config('gotchu.retention_worker','',true);
  RETURN detail;
END $$;
REVOKE ALL ON FUNCTION gotchu.retention_purge(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.retention_purge(uuid,uuid,uuid,uuid) TO gotchu_coordinator;
