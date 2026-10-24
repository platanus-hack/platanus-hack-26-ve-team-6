CREATE FUNCTION gotchu.tenant_id() RETURNS uuid LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$ SELECT nullif(current_setting('gotchu.organization_id', true), '')::uuid $$;
CREATE FUNCTION gotchu.integration_id() RETURNS uuid LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$ SELECT nullif(current_setting('gotchu.integration_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION gotchu.tenant_id(), gotchu.integration_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.tenant_id(), gotchu.integration_id() TO gotchu_api, gotchu_ingest, gotchu_coordinator, gotchu_executor;

CREATE TABLE gotchu.organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  model_opt_in boolean NOT NULL DEFAULT false,
  model_budget_micros bigint NOT NULL DEFAULT 0 CHECK (model_budget_micros >= 0),
  model_spent_micros bigint NOT NULL DEFAULT 0 CHECK (model_spent_micros >= 0),
  model_reserved_micros bigint NOT NULL DEFAULT 0 CHECK (model_reserved_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (model_spent_micros + model_reserved_micros <= model_budget_micros)
);
CREATE TABLE gotchu.memberships (
  organization_id uuid NOT NULL REFERENCES gotchu.organizations(id),
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 256),
  role text NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE gotchu.applications (
  organization_id uuid NOT NULL REFERENCES gotchu.organizations(id),
  id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
CREATE TABLE gotchu.integrations (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('signed_events', 'github', 'aws', 'cloudflare')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_event_at timestamptz,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, application_id, id),
  FOREIGN KEY (organization_id, application_id) REFERENCES gotchu.applications(organization_id, id)
);
-- Opaque references only. The credential store, not this schema, holds signing material.
CREATE TABLE gotchu.integration_credentials (
  organization_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  credential_ref text NOT NULL CHECK (length(credential_ref) BETWEEN 1 AND 1024),
  PRIMARY KEY (organization_id, integration_id),
  FOREIGN KEY (organization_id, integration_id) REFERENCES gotchu.integrations(organization_id, id)
);
CREATE TABLE gotchu.jobs (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('audit', 'events.aggregate', 'investigation', 'execution', 'notification')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, application_id, id),
  UNIQUE (organization_id, application_id, kind, idempotency_key),
  FOREIGN KEY (organization_id, application_id) REFERENCES gotchu.applications(organization_id, id)
);
CREATE TABLE gotchu.events (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  id uuid NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  job_id uuid NOT NULL,
  PRIMARY KEY (organization_id, integration_id, id),
  FOREIGN KEY (organization_id, application_id, integration_id) REFERENCES gotchu.integrations(organization_id, application_id, id),
  FOREIGN KEY (organization_id, application_id, job_id) REFERENCES gotchu.jobs(organization_id, application_id, id)
);
CREATE TABLE gotchu.outbox (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  job_id uuid NOT NULL,
  envelope jsonb NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, job_id),
  FOREIGN KEY (organization_id, job_id) REFERENCES gotchu.jobs(organization_id, id)
);
CREATE INDEX outbox_pending ON gotchu.outbox (organization_id, created_at) WHERE delivered_at IS NULL;
CREATE TABLE gotchu.agent_runs (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  id uuid NOT NULL,
  job_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'succeeded', 'unavailable', 'failed')),
  checkpoint jsonb,
  checkpoint_version integer NOT NULL DEFAULT 0,
  model_calls integer NOT NULL DEFAULT 0 CHECK (model_calls BETWEEN 0 AND 4),
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls BETWEEN 0 AND 8),
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  deadline timestamptz NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, job_id),
  FOREIGN KEY (organization_id, application_id, job_id) REFERENCES gotchu.jobs(organization_id, application_id, id)
);
CREATE TABLE gotchu.model_reservations (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  amount_micros bigint NOT NULL CHECK (amount_micros > 0),
  charged_micros bigint CHECK (charged_micros >= 0 AND charged_micros <= amount_micros),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, run_id) REFERENCES gotchu.agent_runs(organization_id, id)
);
CREATE TABLE gotchu.incidents (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  id uuid NOT NULL,
  rule_id text NOT NULL,
  dedupe_key text NOT NULL,
  summary text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  evidence jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, application_id, rule_id, dedupe_key),
  FOREIGN KEY (organization_id, application_id) REFERENCES gotchu.applications(organization_id, id)
);
CREATE TABLE gotchu.coverage (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  capability text NOT NULL,
  state text NOT NULL CHECK (state IN ('not_configured', 'active', 'degraded', 'stale', 'unsupported')),
  reason text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, application_id, capability),
  FOREIGN KEY (organization_id, application_id) REFERENCES gotchu.applications(organization_id, id)
);
CREATE TABLE gotchu.proposals (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  id uuid NOT NULL,
  action_hash text NOT NULL CHECK (action_hash ~ '^[0-9a-f]{64}$'),
  body jsonb NOT NULL,
  recovery_epoch bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, id, action_hash, recovery_epoch),
  FOREIGN KEY (organization_id, application_id) REFERENCES gotchu.applications(organization_id, id)
);
CREATE TABLE gotchu.approvals (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  action_hash text NOT NULL,
  user_id text NOT NULL,
  proof_id text NOT NULL UNIQUE,
  recovery_epoch bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, id, proposal_id, action_hash, recovery_epoch),
  FOREIGN KEY (organization_id, user_id) REFERENCES gotchu.memberships(organization_id, user_id),
  FOREIGN KEY (organization_id, proposal_id, action_hash, recovery_epoch) REFERENCES gotchu.proposals(organization_id, id, action_hash, recovery_epoch)
);
CREATE TABLE gotchu.executions (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  approval_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  action_hash text NOT NULL,
  recovery_epoch bigint NOT NULL,
  claim_token uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('claimed', 'succeeded', 'failed', 'uncertain')),
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, approval_id),
  UNIQUE (organization_id, proposal_id),
  FOREIGN KEY (organization_id, approval_id, proposal_id, action_hash, recovery_epoch) REFERENCES gotchu.approvals(organization_id, id, proposal_id, action_hash, recovery_epoch)
);
CREATE TABLE gotchu.audit_records (
  organization_id uuid NOT NULL REFERENCES gotchu.organizations(id),
  id uuid NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  subject_id uuid,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
-- Operations-only recovery switch. Default frozen, including brand-new installations.
CREATE TABLE gotchu.platform_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  recovery_epoch bigint NOT NULL CHECK (recovery_epoch > 0),
  writes_frozen boolean NOT NULL,
  reconciliation_reference text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO gotchu.platform_state(singleton, recovery_epoch, writes_frozen) VALUES (true, 1, true);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','applications','integrations','integration_credentials','jobs','events','outbox','agent_runs','model_reservations','incidents','coverage','proposals','approvals','executions','audit_records'] LOOP
    EXECUTE format('ALTER TABLE gotchu.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE gotchu.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_scope ON gotchu.%I USING (organization_id = gotchu.tenant_id()) WITH CHECK (organization_id = gotchu.tenant_id())', t);
  END LOOP;
END $$;
ALTER TABLE gotchu.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.organizations USING (id = gotchu.tenant_id()) WITH CHECK (id = gotchu.tenant_id());
CREATE POLICY intake_lookup ON gotchu.integrations FOR SELECT TO gotchu_ingest USING (id = gotchu.integration_id());
CREATE POLICY intake_credential ON gotchu.integration_credentials FOR SELECT TO gotchu_ingest USING (integration_id = gotchu.integration_id());
ALTER TABLE gotchu.platform_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.platform_state FORCE ROW LEVEL SECURITY;
CREATE POLICY read_state ON gotchu.platform_state FOR SELECT USING (true);
CREATE POLICY operate_state ON gotchu.platform_state TO gotchu_owner USING (true) WITH CHECK (true);

REVOKE ALL ON ALL TABLES IN SCHEMA gotchu FROM PUBLIC;
GRANT USAGE ON SCHEMA gotchu TO gotchu_api, gotchu_ingest, gotchu_coordinator, gotchu_executor;
GRANT SELECT ON gotchu.organizations, gotchu.memberships, gotchu.applications, gotchu.integrations, gotchu.jobs, gotchu.incidents, gotchu.coverage, gotchu.proposals, gotchu.approvals, gotchu.executions, gotchu.audit_records, gotchu.platform_state TO gotchu_api;
GRANT INSERT ON gotchu.jobs, gotchu.outbox, gotchu.proposals, gotchu.approvals, gotchu.audit_records TO gotchu_api;
GRANT SELECT ON gotchu.integrations, gotchu.integration_credentials, gotchu.events, gotchu.jobs TO gotchu_ingest;
GRANT INSERT ON gotchu.events, gotchu.jobs, gotchu.outbox, gotchu.audit_records TO gotchu_ingest;
GRANT UPDATE (last_event_at) ON gotchu.integrations TO gotchu_ingest;
GRANT SELECT ON gotchu.organizations, gotchu.applications, gotchu.integrations, gotchu.events, gotchu.jobs, gotchu.outbox, gotchu.agent_runs, gotchu.model_reservations, gotchu.incidents, gotchu.coverage, gotchu.proposals, gotchu.platform_state TO gotchu_coordinator;
GRANT INSERT, UPDATE ON gotchu.jobs, gotchu.outbox, gotchu.agent_runs, gotchu.model_reservations, gotchu.incidents, gotchu.coverage TO gotchu_coordinator;
GRANT UPDATE (model_spent_micros, model_reserved_micros) ON gotchu.organizations TO gotchu_coordinator;
GRANT INSERT ON gotchu.audit_records TO gotchu_coordinator;
GRANT SELECT ON gotchu.memberships, gotchu.proposals, gotchu.approvals, gotchu.executions, gotchu.platform_state TO gotchu_executor;
GRANT INSERT ON gotchu.executions, gotchu.audit_records TO gotchu_executor;
GRANT UPDATE (consumed_at) ON gotchu.approvals TO gotchu_executor;
GRANT UPDATE (state, provider_reference, finished_at) ON gotchu.executions TO gotchu_executor;
