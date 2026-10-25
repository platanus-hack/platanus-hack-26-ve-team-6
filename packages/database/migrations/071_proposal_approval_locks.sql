-- Lock existing approvals before the proposal, matching executor claim order.
-- The definer permits locking without granting the API approval mutation rights;
-- the owner remains subject to existing FORCE RLS policies on both tables.
CREATE FUNCTION gotchu.lock_proposal_approvals(organization_id uuid, application_id uuid, proposal_id uuid)
RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF $1 IS DISTINCT FROM gotchu.tenant_id() THEN RETURN; END IF;
  RETURN QUERY
    SELECT a.id
    FROM gotchu.approvals a
    JOIN gotchu.proposals p ON p.organization_id=a.organization_id AND p.id=a.proposal_id
    WHERE a.organization_id=$1 AND p.application_id=$2 AND p.id=$3
    ORDER BY a.id
    FOR UPDATE OF a;
END $$;
REVOKE ALL ON FUNCTION gotchu.lock_proposal_approvals(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.lock_proposal_approvals(uuid,uuid,uuid) TO gotchu_api, gotchu_executor;
