-- Preserve legacy second-factor approvals (including TOTP) and their unique proofs.
ALTER TABLE gotchu.approvals
  ALTER COLUMN proof_id DROP NOT NULL,
  ADD COLUMN authorization_method text NOT NULL DEFAULT 'step_up',
  ADD CONSTRAINT approvals_authorization_method_check CHECK (
    (authorization_method='step_up' AND proof_id IS NOT NULL)
    OR (authorization_method='owner_session' AND proof_id IS NULL)
  );

CREATE FUNCTION gotchu.check_owner_session_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,gotchu AS $$
BEGIN
  IF NEW.authorization_method='owner_session' AND NOT EXISTS (
    SELECT 1 FROM gotchu.proposals p
    WHERE p.organization_id=NEW.organization_id AND p.id=NEW.proposal_id
      AND p.version=2 AND p.kind IN ('source_patch_pull_request','dependency_pull_request')
  ) THEN
    RAISE EXCEPTION 'owner_session_approval_requires_pr';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER approvals_owner_session_scope
  BEFORE INSERT ON gotchu.approvals FOR EACH ROW
  EXECUTE FUNCTION gotchu.check_owner_session_approval();

-- A grant/revoke cycle must never make an old confirmation hash valid again.
-- Every link update advances the revision, including provider disconnect/reconnect.
ALTER TABLE gotchu.application_repository_links
  ADD COLUMN write_access_revision bigint NOT NULL DEFAULT 0;
CREATE FUNCTION gotchu.advance_repository_write_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,gotchu AS $$
BEGIN
  NEW.write_access_revision := OLD.write_access_revision + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repository_write_revision
  BEFORE UPDATE ON gotchu.application_repository_links FOR EACH ROW
  EXECUTE FUNCTION gotchu.advance_repository_write_revision();
