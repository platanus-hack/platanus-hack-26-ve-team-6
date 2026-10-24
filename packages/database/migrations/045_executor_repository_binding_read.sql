-- The dependency action verifier proves its candidate remains bound to the authorized repository base.
-- Keep the executor read-only and expose only the binding columns used in that proof.
GRANT SELECT (organization_id, application_id, source_id, repository_link_id, commit_sha, source_digest)
  ON gotchu.customer_source_repository_bindings TO gotchu_executor;
