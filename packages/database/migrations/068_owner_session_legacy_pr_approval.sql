-- Keep historical proof-backed approvals intact; new approvals use the Owner session.
-- Only the already-supported v1 dependency PR adapter joins the existing v2 PR scope.
CREATE OR REPLACE FUNCTION gotchu.check_owner_session_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,gotchu AS $$
BEGIN
  IF NEW.authorization_method='owner_session' AND NOT EXISTS (
    SELECT 1 FROM gotchu.proposals p
    WHERE p.organization_id=NEW.organization_id AND p.id=NEW.proposal_id
      AND (
        (p.version=2 AND p.kind IN ('source_patch_pull_request','dependency_pull_request'))
        OR (p.version=1 AND p.kind='dependency_pull_request'
          AND p.capability_id='repository.dependency_pr'
          AND p.body->'version'='1'::jsonb
          AND p.body->>'adapter'='github.pull_request')
      )
  ) THEN
    RAISE EXCEPTION 'owner_session_approval_requires_pr';
  END IF;
  RETURN NEW;
END;
$$;
