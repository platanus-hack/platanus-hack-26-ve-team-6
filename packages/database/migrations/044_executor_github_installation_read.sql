-- The executor independently rechecks the linked GitHub App installation before provider writes.
-- Tenant RLS stays enabled, and the executor receives only the columns used by that check.
GRANT SELECT (organization_id, installation_id, state) ON gotchu.github_installations TO gotchu_executor;
