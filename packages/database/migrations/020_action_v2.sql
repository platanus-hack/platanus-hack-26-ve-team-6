ALTER TABLE gotchu.proposals
  ADD COLUMN version smallint NOT NULL DEFAULT 1 CHECK (version IN (1, 2)),
  ADD COLUMN kind text NOT NULL DEFAULT 'dependency_pull_request',
  ADD COLUMN capability_id text NOT NULL DEFAULT 'repository.dependency_pr',
  ADD COLUMN state text NOT NULL DEFAULT 'proposed',
  ADD COLUMN source_ref jsonb;

ALTER TABLE gotchu.proposals
  ADD CONSTRAINT proposals_action_kind CHECK (kind IN ('dependency_pull_request','source_patch_pull_request','merge_pull_request','deploy_release','rollback_release','provider_response')),
  ADD CONSTRAINT proposals_action_state CHECK (state IN ('proposed','eligible','ineligible','approved','expired','invalidated','executing','succeeded','failed','uncertain','reconciliation_required')),
  ADD CONSTRAINT proposals_action_version_kind CHECK (version = 2 OR (kind = 'dependency_pull_request' AND capability_id = 'repository.dependency_pr'));

CREATE INDEX proposals_open_per_application ON gotchu.proposals(organization_id,application_id,created_at)
  WHERE state NOT IN ('expired','invalidated','succeeded','failed');

CREATE TABLE gotchu.action_capabilities (
  kind text PRIMARY KEY CHECK (kind IN ('dependency_pull_request','source_patch_pull_request','merge_pull_request','deploy_release','rollback_release','provider_response')),
  capability_id text NOT NULL UNIQUE,
  adapter_available boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO gotchu.action_capabilities(kind,capability_id) VALUES
 ('dependency_pull_request','repository.dependency_pr'),
 ('source_patch_pull_request','repository.source_patch_pr'),
 ('merge_pull_request','repository.merge'),
 ('deploy_release','environment.deploy'),
 ('rollback_release','environment.rollback'),
 ('provider_response','provider.response');

GRANT SELECT ON gotchu.action_capabilities TO gotchu_api, gotchu_executor;
GRANT UPDATE (state, invalidated_at, invalidation_reason) ON gotchu.proposals TO gotchu_api, gotchu_executor;
