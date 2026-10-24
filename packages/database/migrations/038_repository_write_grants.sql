-- A previous write_access value is not sufficient evidence that the configured Writer App
-- actually covers a repository. Existing grants are revoked until an Owner verifies coverage.
ALTER TABLE gotchu.application_repository_links
  ADD COLUMN writer_installation_id text,
  ADD COLUMN writer_verified_at timestamptz,
  ADD COLUMN writer_verified_commit text;

CREATE POLICY repository_write_grant_migration_read ON gotchu.application_repository_links
  FOR SELECT TO gotchu_owner USING (true);
CREATE POLICY repository_write_grant_migration_update ON gotchu.application_repository_links
  FOR UPDATE TO gotchu_owner USING (true) WITH CHECK (true);
UPDATE gotchu.application_repository_links
SET write_access='not_granted',writer_installation_id=NULL,writer_verified_at=NULL,writer_verified_commit=NULL
WHERE write_access='granted';
DROP POLICY repository_write_grant_migration_read ON gotchu.application_repository_links;
DROP POLICY repository_write_grant_migration_update ON gotchu.application_repository_links;

ALTER TABLE gotchu.application_repository_links
  ADD CONSTRAINT application_repository_writer_grant_check CHECK (
    (write_access='granted'
      AND writer_installation_id ~ '^[0-9]{1,20}$'
      AND writer_verified_at IS NOT NULL
      AND writer_verified_commit ~ '^[0-9a-f]{40,64}$')
    OR (write_access<>'granted'
      AND writer_installation_id IS NULL
      AND writer_verified_at IS NULL
      AND writer_verified_commit IS NULL)
  );

GRANT UPDATE(write_access,writer_installation_id,writer_verified_at,writer_verified_commit)
  ON gotchu.application_repository_links TO gotchu_api;

CREATE FUNCTION gotchu.invalidate_repository_write_actions(p_organization_id uuid,p_application_id uuid,p_repository_link_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gotchu AS $$
BEGIN
  IF gotchu.tenant_id() IS DISTINCT FROM p_organization_id
    OR NOT EXISTS (SELECT 1 FROM gotchu.applications WHERE organization_id=p_organization_id AND id=p_application_id) THEN
    RAISE EXCEPTION 'repository_write_access_scope';
  END IF;
  UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='repository_write_access_revoked',
    blocking_reasons='["El permiso de escritura del repositorio fue revocado; prepara y aprueba una propuesta nueva."]'::jsonb
    WHERE organization_id=p_organization_id AND application_id=p_application_id AND body->'target'->>'repositoryLinkId'=p_repository_link_id::text
      AND kind IN ('source_patch_pull_request','dependency_pull_request')
      AND state IN ('proposed','eligible','ineligible','approved');
  UPDATE gotchu.approvals SET consumed_at=COALESCE(consumed_at,clock_timestamp())
    WHERE organization_id=p_organization_id AND proposal_id IN (
      SELECT id FROM gotchu.proposals WHERE organization_id=p_organization_id AND application_id=p_application_id
        AND body->'target'->>'repositoryLinkId'=p_repository_link_id::text
        AND kind IN ('source_patch_pull_request','dependency_pull_request')
        AND invalidation_reason='repository_write_access_revoked');
END;
$$;
REVOKE ALL ON FUNCTION gotchu.invalidate_repository_write_actions(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.invalidate_repository_write_actions(uuid,uuid,uuid) TO gotchu_api;

-- Global policy changes invalidate tenant rows from a trigger; this non-login role
-- needs read/update RLS paths for that server-owned operation.
CREATE POLICY proposals_policy_change_invalidation_read ON gotchu.proposals
  FOR SELECT TO gotchu_owner USING (true);
CREATE POLICY proposals_policy_change_invalidation_update ON gotchu.proposals
  FOR UPDATE TO gotchu_owner USING (true) WITH CHECK (true);

INSERT INTO gotchu.action_policy_registry(capability_id,active_version)
VALUES ('repository.dependency_pr','gotchu-dependency-pr-v1')
ON CONFLICT (capability_id) DO NOTHING;

UPDATE gotchu.action_capabilities SET adapter_available=true,updated_at=clock_timestamp()
WHERE kind='dependency_pull_request';

UPDATE gotchu.proposals
SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='policy_changed',
  blocking_reasons='["La política de esta acción cambió; prepara y valida una propuesta nueva."]'::jsonb
WHERE version=2 AND state IN ('proposed','eligible','ineligible','approved') AND (
  (capability_id='repository.source_patch_pr' AND body->>'policyVersion' IS DISTINCT FROM 'gotchu-source-patch-pr-v1')
  OR (capability_id='repository.dependency_pr' AND body->>'policyVersion' IS DISTINCT FROM 'gotchu-dependency-pr-v1')
);
