-- Personal bearer tokens for the Gotchu MCP server. Each one is bound to one member of one
-- workspace and only ever acts with that member's current role; only a hash of the secret is kept.
CREATE TABLE gotchu.mcp_access_tokens (
  organization_id uuid NOT NULL REFERENCES gotchu.organizations(id),
  id uuid NOT NULL,
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 256),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text CHECK (length(revoked_by) BETWEEN 1 AND 256),
  PRIMARY KEY (organization_id, id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days 1 minute'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX mcp_access_tokens_user ON gotchu.mcp_access_tokens(organization_id, user_id, created_at DESC);

ALTER TABLE gotchu.mcp_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.mcp_access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.mcp_access_tokens USING (organization_id = gotchu.tenant_id()) WITH CHECK (organization_id = gotchu.tenant_id());
REVOKE ALL ON gotchu.mcp_access_tokens FROM PUBLIC;
GRANT SELECT ON gotchu.mcp_access_tokens TO gotchu_api;
GRANT INSERT (organization_id, id, user_id, label, secret_hash, expires_at) ON gotchu.mcp_access_tokens TO gotchu_api;
GRANT UPDATE (last_used_at, revoked_at, revoked_by) ON gotchu.mcp_access_tokens TO gotchu_api;
