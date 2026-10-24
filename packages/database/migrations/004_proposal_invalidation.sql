ALTER TABLE gotchu.proposals ADD COLUMN invalidated_at timestamptz;
ALTER TABLE gotchu.proposals ADD COLUMN invalidation_reason text;
GRANT UPDATE (invalidated_at, invalidation_reason) ON gotchu.proposals TO gotchu_api, gotchu_executor;
