-- Exact action identity is unique per tenant, including the recovery epoch in its hash.
CREATE UNIQUE INDEX proposals_exact_action ON gotchu.proposals(organization_id, action_hash);
CREATE UNIQUE INDEX executions_exact_action ON gotchu.executions(organization_id, action_hash);
