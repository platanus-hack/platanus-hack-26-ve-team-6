CREATE TABLE gotchu.executor_attempts (
  organization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  state text NOT NULL CHECK (state IN ('claimed','branch_published','pr_opened','verified','uncertain','reconciliation_required')),
  step text NOT NULL CHECK (step IN ('claim','publish_branch','open_pr','verify')),
  provider_reference text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(detail::text) <= 4096),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,execution_id,attempt),
  FOREIGN KEY (organization_id,execution_id) REFERENCES gotchu.executions(organization_id,id),
  CHECK (provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 1000)
);
ALTER TABLE gotchu.executor_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.executor_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY executor_attempts_tenant ON gotchu.executor_attempts
  USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id());
GRANT SELECT,INSERT,UPDATE ON gotchu.executor_attempts TO gotchu_executor;
GRANT SELECT ON gotchu.customer_sources,gotchu.audit_records TO gotchu_executor;
GRANT SELECT ON gotchu.application_repository_links TO gotchu_executor;
CREATE INDEX executor_attempts_unfinished ON gotchu.executor_attempts(organization_id,updated_at)
  WHERE state NOT IN ('verified','uncertain','reconciliation_required');
