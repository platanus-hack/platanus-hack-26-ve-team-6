CREATE INDEX ai_correction_base_source ON gotchu.ai_correction_requests(organization_id,application_id,base_source_id);
CREATE INDEX ai_correction_candidate_source ON gotchu.ai_correction_requests(organization_id,application_id,candidate_source_id)
  WHERE candidate_source_id IS NOT NULL;

-- Narrow trigger capabilities run as the table owner, still under tenant RLS.
-- Runtime roles gain neither source UPDATE nor model-reservation read privileges.
CREATE FUNCTION gotchu.erase_private_correction_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM gotchu.tenant_id()
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'tenant mismatch' USING ERRCODE='42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM gotchu.ai_correction_requests c
    JOIN gotchu.jobs j ON j.organization_id=c.organization_id AND j.application_id=c.application_id AND j.id=c.job_id
    LEFT JOIN gotchu.agent_runs r ON r.organization_id=c.organization_id AND r.application_id=c.application_id AND r.job_id=c.job_id
    WHERE c.organization_id=OLD.organization_id AND c.application_id=OLD.application_id
      AND (c.base_source_id=OLD.id OR c.candidate_source_id=OLD.id)
      AND (c.state IN ('queued','running','reconciliation_required') OR j.state IN ('queued','running')
        OR r.state IN ('pending','running') OR r.reserved_micros>0 OR r.tokens_reserved>0
        OR EXISTS (SELECT 1 FROM gotchu.model_reservations m
          WHERE m.organization_id=r.organization_id AND m.run_id=r.id AND m.state<>'settled')
        OR EXISTS (SELECT 1 FROM gotchu.jobs scan
          WHERE scan.organization_id=c.organization_id AND scan.application_id=c.application_id AND scan.id=c.rescan_job_id
            AND (scan.state IN ('queued','running') OR scan.result->>'reasonCode'='assessment_reconciliation_required'))
        OR EXISTS (SELECT 1 FROM gotchu.validation_runs v
          WHERE v.organization_id=c.organization_id AND v.application_id=c.application_id AND v.id=c.validation_run_id
            AND v.state IN ('queued','running','quarantined')))
  ) THEN
    -- Retention counts only rows actually erased and retries deferred sources later.
    -- Only the existing owner functions can update sources; a caller-set GUC adds no write capability.
    IF current_setting('gotchu.retention_purge',true)='enabled' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'source_in_use' USING ERRCODE='55006';
  END IF;

  UPDATE gotchu.ai_correction_requests SET model_patch=NULL,diff='[]'::jsonb,suggestion=NULL,summary=NULL,
    implications='[]'::jsonb,risks='[]'::jsonb,validation_plan='[]'::jsonb,
    state=CASE WHEN state='cancelled' THEN 'cancelled' ELSE 'failed' END,
    reason_code='correction_source_unavailable',updated_at=clock_timestamp()
    WHERE organization_id=OLD.organization_id AND application_id=OLD.application_id
      AND (base_source_id=OLD.id OR candidate_source_id=OLD.id);
  -- IDs, digests, authorization metadata, audit records, and usage holds are retained.
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.erase_private_correction_source() FROM PUBLIC;
CREATE TRIGGER private_correction_source_erasure BEFORE UPDATE OF body ON gotchu.customer_sources
  FOR EACH ROW WHEN (NEW.body IS NULL) EXECUTE FUNCTION gotchu.erase_private_correction_source();

-- Lock sources before admitting new content so an insert cannot race past erasure.
-- Source erasure's own content-free terminal update needs no reverse row lock.
CREATE FUNCTION gotchu.guard_private_correction_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE source_id uuid;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM gotchu.tenant_id() THEN
    RAISE EXCEPTION 'tenant mismatch' USING ERRCODE='42501';
  END IF;
  IF NEW.state IN ('failed','cancelled','reconciliation_required') AND NEW.model_patch IS NULL AND NEW.diff='[]'::jsonb
    AND NEW.suggestion IS NULL AND NEW.summary IS NULL AND NEW.implications='[]'::jsonb
    AND NEW.risks='[]'::jsonb AND NEW.validation_plan='[]'::jsonb THEN RETURN NEW; END IF;

  FOR source_id IN SELECT DISTINCT id FROM unnest(ARRAY[NEW.base_source_id,NEW.candidate_source_id]) id
    WHERE id IS NOT NULL ORDER BY id
  LOOP
    PERFORM 1 FROM gotchu.customer_sources s
      WHERE s.organization_id=NEW.organization_id AND s.application_id=NEW.application_id AND s.id=source_id
        AND s.body IS NOT NULL AND s.deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'correction_source_unavailable' USING ERRCODE='55000'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.guard_private_correction_sources() FROM PUBLIC;
CREATE TRIGGER private_correction_sources_available BEFORE INSERT OR UPDATE OF
  base_source_id,candidate_source_id,model_patch,diff,suggestion,summary,implications,risks,validation_plan,state
  ON gotchu.ai_correction_requests FOR EACH ROW EXECUTE FUNCTION gotchu.guard_private_correction_sources();

-- Repair copies whose source was already erased before this protection existed.
-- Already-lost sources cannot be restored: active work stays reconciliation_required,
-- and all usage holds stay untouched. Live/queued source bodies are never changed.
CREATE POLICY private_correction_migration_tenants ON gotchu.organizations FOR SELECT TO gotchu_owner USING (true);
DO $$
DECLARE tenant uuid; previous_tenant text:=current_setting('gotchu.organization_id',true);
BEGIN
  FOR tenant IN SELECT id FROM gotchu.organizations LOOP
    PERFORM set_config('gotchu.organization_id',tenant::text,true);
    UPDATE gotchu.ai_correction_requests c SET model_patch=NULL,diff='[]'::jsonb,suggestion=NULL,summary=NULL,
      implications='[]'::jsonb,risks='[]'::jsonb,validation_plan='[]'::jsonb,
      state=CASE WHEN c.state IN ('queued','running','reconciliation_required') THEN 'reconciliation_required'
        WHEN c.state='cancelled' THEN 'cancelled' ELSE 'failed' END,
      reason_code='correction_source_unavailable',updated_at=clock_timestamp()
      WHERE c.organization_id=tenant AND EXISTS (SELECT 1 FROM gotchu.customer_sources s
        WHERE s.organization_id=c.organization_id AND s.application_id=c.application_id AND s.body IS NULL
          AND (s.id=c.base_source_id OR s.id=c.candidate_source_id));
  END LOOP;
  PERFORM set_config('gotchu.organization_id',coalesce(previous_tenant,''),true);
END $$;
DROP POLICY private_correction_migration_tenants ON gotchu.organizations;
