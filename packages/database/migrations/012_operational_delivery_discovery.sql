ALTER POLICY customer_pending_discovery ON gotchu.jobs TO gotchu_owner
  USING (current_setting('gotchu.pending_discovery',true)='enabled' AND state IN ('queued','running')
    AND ((kind='audit' AND payload->>'version'='2') OR kind IN ('events.aggregate','investigation')
      OR (kind='notification' AND payload->>'kind'='assessment_observation')));

CREATE OR REPLACE FUNCTION gotchu.customer_pending_organizations(p_limit integer DEFAULT 100) RETURNS TABLE(organization_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_customer_discovery'; END IF;
  PERFORM set_config('gotchu.pending_discovery','enabled',true);
  RETURN QUERY SELECT j.organization_id FROM gotchu.jobs j WHERE j.state IN ('queued','running')
    AND ((j.kind='audit' AND j.payload->>'version'='2') OR j.kind IN ('events.aggregate','investigation')
      OR (j.kind='notification' AND j.payload->>'kind'='assessment_observation'))
    GROUP BY j.organization_id ORDER BY min(j.created_at),j.organization_id LIMIT p_limit;
  PERFORM set_config('gotchu.pending_discovery','',true);
END $$;
CREATE INDEX operational_pending_jobs ON gotchu.jobs(created_at,organization_id)
  WHERE kind IN ('events.aggregate','investigation','notification') AND state IN ('queued','running');
