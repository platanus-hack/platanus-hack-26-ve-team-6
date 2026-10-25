-- Approved execution jobs must keep their organization discoverable after assessments finish.
-- Discovery only schedules delivery; the executor still checks live exact approval and permissions.
ALTER POLICY customer_pending_discovery ON gotchu.jobs TO gotchu_owner
  USING (current_setting('gotchu.pending_discovery', true) = 'enabled' AND state IN ('queued', 'running')
    AND ((kind = 'audit' AND payload->>'version' = '2') OR kind IN ('events.aggregate', 'investigation', 'execution')
      OR (kind = 'notification' AND payload->>'kind' IN ('assessment_observation', 'triage_evaluation', 'alert_delivery'))));
CREATE OR REPLACE FUNCTION gotchu.customer_pending_organizations(p_limit integer DEFAULT 100) RETURNS TABLE(organization_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_customer_discovery';
  END IF;
  PERFORM set_config('gotchu.pending_discovery', 'enabled', true);
  PERFORM set_config('gotchu.operation_discovery', 'enabled', true);
  RETURN QUERY SELECT discovered.organization_id FROM (
    SELECT j.organization_id, min(j.created_at) AS first_seen FROM gotchu.jobs j WHERE j.state IN ('queued', 'running')
      AND ((j.kind = 'audit' AND j.payload->>'version' = '2') OR j.kind IN ('events.aggregate', 'investigation', 'execution')
        OR (j.kind = 'notification' AND j.payload->>'kind' IN ('assessment_observation', 'triage_evaluation', 'alert_delivery')))
      GROUP BY j.organization_id
    UNION
    SELECT m.organization_id, m.updated_at AS first_seen FROM gotchu.operation_monitors m WHERE m.enabled
  ) discovered GROUP BY discovered.organization_id ORDER BY min(discovered.first_seen), discovered.organization_id LIMIT p_limit;
  PERFORM set_config('gotchu.pending_discovery', '', true);
  PERFORM set_config('gotchu.operation_discovery', '', true);
END $$;
