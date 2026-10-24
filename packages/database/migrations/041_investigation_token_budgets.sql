ALTER TABLE gotchu.organizations
  ADD COLUMN model_token_budget bigint NOT NULL DEFAULT 0 CHECK (model_token_budget >= 0),
  ADD COLUMN model_tokens_spent bigint NOT NULL DEFAULT 0 CHECK (model_tokens_spent >= 0),
  ADD COLUMN model_tokens_reserved bigint NOT NULL DEFAULT 0 CHECK (model_tokens_reserved >= 0),
  ADD CONSTRAINT organization_model_token_budget CHECK (model_tokens_spent + model_tokens_reserved <= model_token_budget);

ALTER TABLE gotchu.agent_runs
  ADD COLUMN tokens_reserved bigint NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  ADD COLUMN tokens_spent bigint NOT NULL DEFAULT 0 CHECK (tokens_spent >= 0),
  ADD COLUMN cancel_requested_at timestamptz;

ALTER TABLE gotchu.model_reservations
  ADD COLUMN reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  ADD COLUMN input_tokens bigint CHECK (input_tokens >= 0),
  ADD COLUMN output_tokens bigint CHECK (output_tokens >= 0),
  ADD COLUMN charged_tokens bigint CHECK (charged_tokens >= 0 AND charged_tokens <= reserved_tokens),
  ADD COLUMN request_sha256 text CHECK (request_sha256 IS NULL OR request_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN provider text CHECK (provider IS NULL OR provider IN ('openai_compatible','anthropic_messages')),
  ADD COLUMN model_id text CHECK (model_id IS NULL OR length(model_id) BETWEEN 1 AND 200),
  ADD COLUMN state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','in_flight','unknown','settled'));

UPDATE gotchu.model_reservations SET state='settled' WHERE charged_micros IS NOT NULL;
UPDATE gotchu.model_reservations r SET charged_tokens=0
  WHERE r.charged_micros IS NOT NULL;

REVOKE ALL ON gotchu.model_reservations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON gotchu.model_reservations TO gotchu_coordinator;
GRANT UPDATE (model_tokens_spent, model_tokens_reserved) ON gotchu.organizations TO gotchu_coordinator;
GRANT UPDATE (tokens_reserved, tokens_spent, cancel_requested_at) ON gotchu.agent_runs TO gotchu_coordinator;
GRANT UPDATE (model_opt_in, model_budget_micros, model_token_budget) ON gotchu.organizations TO gotchu_api;
