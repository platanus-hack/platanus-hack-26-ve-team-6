CREATE TABLE gotchu.investigation_model_settings (
  organization_id uuid PRIMARY KEY REFERENCES gotchu.organizations(id),
  provider text NOT NULL CHECK (provider IN ('openai_compatible','anthropic_messages')),
  endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
  model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  secret_ref text CHECK (secret_ref IS NULL OR secret_ref ~ '^local-model:[a-f0-9-]{36}$'),
  consent_to_external_processing boolean NOT NULL DEFAULT false,
  data_scopes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(data_scopes)='array' AND jsonb_array_length(data_scopes)<=7),
  input_price_micro_usd_per_million_tokens bigint NOT NULL DEFAULT 0 CHECK (input_price_micro_usd_per_million_tokens BETWEEN 0 AND 1000000000),
  output_price_micro_usd_per_million_tokens bigint NOT NULL DEFAULT 0 CHECK (output_price_micro_usd_per_million_tokens BETWEEN 0 AND 1000000000),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT consent_to_external_processing OR jsonb_array_length(data_scopes)>0)
);
ALTER TABLE gotchu.investigation_model_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.investigation_model_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.investigation_model_settings
  USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.investigation_model_settings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON gotchu.investigation_model_settings TO gotchu_api;
GRANT SELECT ON gotchu.investigation_model_settings TO gotchu_coordinator;
GRANT SELECT (organization_id,application_id,id,job_id,state,cancel_requested_at,tokens_reserved,tokens_spent,reserved_micros,spent_micros)
  ON gotchu.agent_runs TO gotchu_api;
GRANT UPDATE (state,result,completed_at,lease_until) ON gotchu.jobs TO gotchu_api;

ALTER TABLE gotchu.model_reservations ADD COLUMN model_config_sha256 text
  CHECK(model_config_sha256 IS NULL OR model_config_sha256 ~ '^[a-f0-9]{64}$');

GRANT SELECT ON gotchu.application_environments,gotchu.application_services,gotchu.application_repository_links,
  gotchu.application_deployments,gotchu.application_dependencies,gotchu.application_origin_candidates TO gotchu_coordinator;
GRANT SELECT ON gotchu.validation_runs,gotchu.validation_attestations TO gotchu_coordinator;
GRANT SELECT ON gotchu.dependency_fix_candidates TO gotchu_coordinator;
