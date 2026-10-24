CREATE TABLE gotchu.investigation_model_probes (
  organization_id uuid NOT NULL REFERENCES gotchu.organizations(id),
  request_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('in_flight', 'unknown', 'settled')),
  reserved_micros bigint NOT NULL CHECK (reserved_micros > 0),
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens > 0),
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  charged_micros bigint CHECK (charged_micros >= 0 AND charged_micros <= reserved_micros),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  PRIMARY KEY (organization_id, request_id),
  CHECK ((state = 'settled') = (settled_at IS NOT NULL)),
  CHECK (state <> 'settled' OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND charged_micros IS NOT NULL))
);

ALTER TABLE gotchu.investigation_model_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.investigation_model_probes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.investigation_model_probes
  USING (organization_id = nullif(current_setting('gotchu.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('gotchu.organization_id', true), '')::uuid);
REVOKE ALL ON gotchu.investigation_model_probes FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON gotchu.investigation_model_probes TO gotchu_coordinator;
GRANT UPDATE (model_spent_micros, model_reserved_micros, model_tokens_spent, model_tokens_reserved) ON gotchu.organizations TO gotchu_coordinator;
