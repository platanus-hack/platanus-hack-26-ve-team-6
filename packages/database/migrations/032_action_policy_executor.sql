CREATE TABLE gotchu.action_policy_registry (
  capability_id text PRIMARY KEY CHECK (length(capability_id) BETWEEN 1 AND 100),
  active_version text NOT NULL CHECK (length(active_version) BETWEEN 1 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO gotchu.action_policy_registry(capability_id,active_version)
VALUES ('repository.source_patch_pr','gotchu-source-patch-pr-v1');
CREATE FUNCTION gotchu.invalidate_actions_on_policy_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gotchu AS $$
BEGIN
  IF OLD.active_version IS DISTINCT FROM NEW.active_version THEN
    UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='policy_changed',
      blocking_reasons='["La política de esta acción cambió; prepara y valida una propuesta nueva."]'::jsonb
    WHERE version=2 AND capability_id=NEW.capability_id AND body->>'policyVersion' IS DISTINCT FROM NEW.active_version
      AND state IN ('proposed','eligible','ineligible','approved');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION gotchu.invalidate_actions_on_policy_change() FROM PUBLIC;
CREATE TRIGGER action_policy_registry_invalidate_pending AFTER UPDATE OF active_version ON gotchu.action_policy_registry
  FOR EACH ROW EXECUTE FUNCTION gotchu.invalidate_actions_on_policy_change();
UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='policy_changed',
  blocking_reasons='["La política de esta acción cambió; prepara y valida una propuesta nueva."]'::jsonb
WHERE version=2 AND kind='source_patch_pull_request' AND state IN ('proposed','eligible','ineligible','approved')
  AND body->>'policyVersion' IS DISTINCT FROM 'gotchu-source-patch-pr-v1';
ALTER TABLE gotchu.action_policy_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.action_policy_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY action_policy_registry_read ON gotchu.action_policy_registry FOR SELECT TO gotchu_api,gotchu_executor USING (true);
CREATE POLICY action_policy_registry_owner ON gotchu.action_policy_registry FOR ALL TO gotchu_owner USING (true) WITH CHECK (true);
REVOKE ALL ON gotchu.action_policy_registry FROM PUBLIC,gotchu_api,gotchu_executor;
GRANT SELECT ON gotchu.action_policy_registry TO gotchu_api,gotchu_executor;
GRANT SELECT,INSERT,UPDATE,DELETE ON gotchu.action_policy_registry TO gotchu_owner;

-- Eligibility depends on a live, configured independent worker, not a code-only adapter flag.
CREATE TABLE gotchu.action_executor_instances (
  instance_id uuid NOT NULL,
  capability_id text NOT NULL REFERENCES gotchu.action_policy_registry(capability_id),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (instance_id,capability_id)
);
ALTER TABLE gotchu.action_executor_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.action_executor_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY action_executor_instances_read ON gotchu.action_executor_instances FOR SELECT TO gotchu_api,gotchu_executor USING (true);
CREATE POLICY action_executor_instances_executor ON gotchu.action_executor_instances FOR ALL TO gotchu_executor USING (true) WITH CHECK (true);
REVOKE ALL ON gotchu.action_executor_instances FROM PUBLIC,gotchu_api,gotchu_executor;
GRANT SELECT ON gotchu.action_executor_instances TO gotchu_api,gotchu_executor;
GRANT INSERT,UPDATE,DELETE ON gotchu.action_executor_instances TO gotchu_executor;

-- A repository lock survives process loss and uncertain provider results.
CREATE TABLE gotchu.executor_repository_locks (
  repository_key text PRIMARY KEY CHECK (length(repository_key) BETWEEN 1 AND 200),
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  repository_link_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,application_id,repository_link_id)
    REFERENCES gotchu.application_repository_links(organization_id,application_id,id),
  FOREIGN KEY (organization_id,execution_id)
    REFERENCES gotchu.executions(organization_id,id)
);
ALTER TABLE gotchu.executor_repository_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.executor_repository_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY executor_repository_locks_tenant ON gotchu.executor_repository_locks
  USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.executor_repository_locks FROM PUBLIC;
GRANT SELECT,INSERT,DELETE ON gotchu.executor_repository_locks TO gotchu_executor;

CREATE TABLE gotchu.executor_attempt_events (
  organization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  step text NOT NULL CHECK (step IN ('claim','publish_branch','open_pr','verify')),
  state text NOT NULL CHECK (state IN ('claimed','branch_published','pr_opened','verified','failed','uncertain','reconciliation_required')),
  provider_reference text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(detail::text) <= 4096),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,execution_id,attempt,step,state),
  FOREIGN KEY (organization_id,execution_id,attempt)
    REFERENCES gotchu.executor_attempts(organization_id,execution_id,attempt),
  CHECK (provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 1000)
);
ALTER TABLE gotchu.executor_attempt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.executor_attempt_events FORCE ROW LEVEL SECURITY;
CREATE POLICY executor_attempt_events_tenant ON gotchu.executor_attempt_events
  USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.executor_attempt_events FROM PUBLIC;
GRANT SELECT,INSERT ON gotchu.executor_attempt_events TO gotchu_executor;
GRANT SELECT ON gotchu.executor_attempt_events TO gotchu_api;
GRANT SELECT (organization_id,execution_id,attempt,state,step,provider_reference,detail,started_at,updated_at)
  ON gotchu.executor_attempts TO gotchu_api;
GRANT SELECT ON gotchu.jobs TO gotchu_executor;
GRANT UPDATE (state,lease_token,lease_until,attempts,result,completed_at) ON gotchu.jobs TO gotchu_executor;

ALTER TABLE gotchu.executor_attempts DROP CONSTRAINT executor_attempts_state_check;
ALTER TABLE gotchu.executor_attempts ADD CONSTRAINT executor_attempts_state_check
  CHECK (state IN ('claimed','branch_published','pr_opened','verified','failed','uncertain','reconciliation_required'));

UPDATE gotchu.action_capabilities SET adapter_available=true,updated_at=clock_timestamp()
WHERE kind='source_patch_pull_request';
