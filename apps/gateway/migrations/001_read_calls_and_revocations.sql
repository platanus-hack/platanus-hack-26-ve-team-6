CREATE TABLE gotchu.gateway_read_calls (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  call_id uuid NOT NULL,
  call_type text NOT NULL CHECK (call_type IN ('required_evidence', 'additional')),
  tool_name text NOT NULL CHECK (tool_name IN ('evidence.read', 'auth.events.read')),
  evidence_id uuid NOT NULL,
  response jsonb NOT NULL CHECK (octet_length(response::text) <= 2048),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, run_id, call_id),
  FOREIGN KEY (organization_id, run_id) REFERENCES gotchu.agent_runs(organization_id, id)
);
-- Required evidence has a fixed identity, independent of agent-chosen call IDs.
CREATE UNIQUE INDEX gateway_required_evidence ON gotchu.gateway_read_calls(organization_id, run_id, evidence_id)
  WHERE call_type = 'required_evidence';
CREATE TABLE gotchu.gateway_revoked_capabilities (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  jti uuid NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, run_id, jti),
  FOREIGN KEY (organization_id, run_id) REFERENCES gotchu.agent_runs(organization_id, id)
);
ALTER TABLE gotchu.gateway_read_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.gateway_read_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.gateway_read_calls
  USING (organization_id = gotchu.tenant_id()) WITH CHECK (organization_id = gotchu.tenant_id());
ALTER TABLE gotchu.gateway_revoked_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.gateway_revoked_capabilities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.gateway_revoked_capabilities
  USING (organization_id = gotchu.tenant_id()) WITH CHECK (organization_id = gotchu.tenant_id());
REVOKE ALL ON gotchu.gateway_read_calls, gotchu.gateway_revoked_capabilities FROM PUBLIC;
GRANT SELECT, INSERT ON gotchu.gateway_read_calls, gotchu.gateway_revoked_capabilities TO gotchu_coordinator;
