CREATE INDEX ai_correction_report ON gotchu.ai_correction_requests(organization_id,application_id,report_id);

-- Take the parent lock before inserting a request, not only during its FK check.
-- A report DELETE owns the conflicting row lock before its BEFORE trigger runs.
CREATE FUNCTION gotchu.guard_private_correction_report() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM gotchu.tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM gotchu.customer_reports
    WHERE organization_id=NEW.organization_id AND application_id=NEW.application_id AND id=NEW.report_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'correction_report_unavailable' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.guard_private_correction_report() FROM PUBLIC;
-- Alphabetical trigger order keeps 059's source locks before the report lock,
-- matching retention's source-erasure-then-report-deletion order.
CREATE TRIGGER private_correction_validate_report BEFORE INSERT OR UPDATE OF organization_id,application_id,report_id
  ON gotchu.ai_correction_requests FOR EACH ROW EXECUTE FUNCTION gotchu.guard_private_correction_report();

-- Keep 040's bounded purge, counts, audit and retry cadence. The original NO ACTION
-- FK remains a backstop; only retention may erase terminal private request copies.
CREATE FUNCTION gotchu.erase_private_correction_report() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF current_setting('gotchu.retention_purge',true) IS DISTINCT FROM 'enabled' THEN RETURN OLD; END IF;
  IF OLD.organization_id IS DISTINCT FROM gotchu.tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch' USING ERRCODE='42501';
  END IF;

  -- Freeze existing lifecycle rows and re-read after locks. NOWAIT defers contention
  -- instead of reversing worker lock order (jobs/runs/requests/sources).
  PERFORM 1 FROM gotchu.ai_correction_requests c
    WHERE c.organization_id=OLD.organization_id AND c.application_id=OLD.application_id AND c.report_id=OLD.id
    ORDER BY c.id FOR UPDATE NOWAIT;
  PERFORM 1 FROM gotchu.jobs j WHERE j.organization_id=OLD.organization_id AND j.application_id=OLD.application_id
    AND EXISTS (SELECT 1 FROM gotchu.ai_correction_requests c
      WHERE c.organization_id=j.organization_id AND c.application_id=j.application_id AND c.report_id=OLD.id
        AND j.id IN (c.job_id,c.rescan_job_id)) ORDER BY j.id FOR UPDATE NOWAIT;
  PERFORM 1 FROM gotchu.agent_runs r WHERE r.organization_id=OLD.organization_id AND r.application_id=OLD.application_id
    AND EXISTS (SELECT 1 FROM gotchu.ai_correction_requests c
      WHERE c.organization_id=r.organization_id AND c.application_id=r.application_id AND c.report_id=OLD.id AND c.job_id=r.job_id)
    ORDER BY r.id FOR UPDATE NOWAIT;
  PERFORM 1 FROM gotchu.model_reservations m WHERE m.organization_id=OLD.organization_id
    AND EXISTS (SELECT 1 FROM gotchu.agent_runs r JOIN gotchu.ai_correction_requests c
      ON c.organization_id=r.organization_id AND c.application_id=r.application_id AND c.job_id=r.job_id
      WHERE r.organization_id=m.organization_id AND r.id=m.run_id AND c.application_id=OLD.application_id AND c.report_id=OLD.id)
    ORDER BY m.id FOR UPDATE NOWAIT;
  PERFORM 1 FROM gotchu.validation_runs v WHERE v.organization_id=OLD.organization_id AND v.application_id=OLD.application_id
    AND EXISTS (SELECT 1 FROM gotchu.ai_correction_requests c
      WHERE c.organization_id=v.organization_id AND c.application_id=v.application_id AND c.report_id=OLD.id AND c.validation_run_id=v.id)
    ORDER BY v.id FOR UPDATE NOWAIT;
  PERFORM 1 FROM gotchu.proposals p WHERE p.organization_id=OLD.organization_id AND p.application_id=OLD.application_id
    AND EXISTS (SELECT 1 FROM gotchu.ai_correction_requests c
      WHERE c.organization_id=p.organization_id AND c.application_id=p.application_id AND c.report_id=OLD.id
        AND p.source_ref->>'candidateId'=c.candidate_source_id::text)
    ORDER BY p.id FOR UPDATE NOWAIT;

  IF EXISTS (
    SELECT 1 FROM gotchu.ai_correction_requests c
    JOIN gotchu.jobs j ON j.organization_id=c.organization_id AND j.application_id=c.application_id AND j.id=c.job_id
    LEFT JOIN gotchu.agent_runs r ON r.organization_id=c.organization_id AND r.application_id=c.application_id AND r.job_id=c.job_id
    WHERE c.organization_id=OLD.organization_id AND c.application_id=OLD.application_id AND c.report_id=OLD.id
      AND (c.state IN ('queued','running','reconciliation_required') OR j.state IN ('queued','running')
        OR position('reconciliation' in coalesce(j.result->>'reasonCode',''))>0
        OR r.state IN ('pending','running') OR r.reserved_micros>0 OR r.tokens_reserved>0
        OR EXISTS (SELECT 1 FROM gotchu.model_reservations m
          WHERE m.organization_id=r.organization_id AND m.run_id=r.id AND m.state<>'settled')
        OR EXISTS (SELECT 1 FROM gotchu.jobs scan
          WHERE scan.organization_id=c.organization_id AND scan.application_id=c.application_id AND scan.id=c.rescan_job_id
            AND (scan.state IN ('queued','running') OR scan.result->>'reasonCode'='assessment_reconciliation_required'))
        OR EXISTS (SELECT 1 FROM gotchu.validation_runs v
          WHERE v.organization_id=c.organization_id AND v.application_id=c.application_id AND v.id=c.validation_run_id
            AND v.state IN ('queued','running','quarantined'))
        OR EXISTS (SELECT 1 FROM gotchu.proposals p
          WHERE p.organization_id=c.organization_id AND p.application_id=c.application_id
            AND p.source_ref->>'candidateId'=c.candidate_source_id::text
            AND p.state IN ('executing','uncertain','reconciliation_required')))
  ) THEN RETURN NULL; END IF;

  DELETE FROM gotchu.ai_correction_requests
    WHERE organization_id=OLD.organization_id AND application_id=OLD.application_id AND report_id=OLD.id;
  -- Jobs, sources, validations, audit records and usage accounting keep their own lifetimes.
  RETURN OLD;
EXCEPTION WHEN lock_not_available THEN
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION gotchu.erase_private_correction_report() FROM PUBLIC;
CREATE TRIGGER private_correction_report_erasure BEFORE DELETE ON gotchu.customer_reports
  FOR EACH ROW EXECUTE FUNCTION gotchu.erase_private_correction_report();
