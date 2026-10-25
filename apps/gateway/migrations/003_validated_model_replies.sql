-- Composite keys prevent a reply from borrowing another application's run or reservation.
ALTER TABLE gotchu.agent_runs ADD CONSTRAINT gateway_reply_run_scope
  UNIQUE (organization_id, application_id, id);
ALTER TABLE gotchu.model_reservations ADD CONSTRAINT gateway_reply_reservation_scope
  UNIQUE (organization_id, run_id, id);

CREATE TABLE gotchu.gateway_validated_model_replies (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  run_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  model_call integer NOT NULL CHECK (model_call BETWEEN 1 AND 4),
  tool_calls integer NOT NULL CHECK (tool_calls BETWEEN 0 AND 8),
  loaded_evidence_ids uuid[] NOT NULL CHECK (
    cardinality(loaded_evidence_ids) BETWEEN 0 AND 20
    AND array_position(loaded_evidence_ids, NULL) IS NULL
  ),
  output jsonb NOT NULL CHECK (
    jsonb_typeof(output) = 'object' AND octet_length(output::text) <= 24576
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, run_id, model_call),
  UNIQUE (organization_id, reservation_id),
  FOREIGN KEY (organization_id, application_id, run_id)
    REFERENCES gotchu.agent_runs(organization_id, application_id, id),
  FOREIGN KEY (organization_id, run_id, reservation_id)
    REFERENCES gotchu.model_reservations(organization_id, run_id, id)
);
ALTER TABLE gotchu.gateway_validated_model_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.gateway_validated_model_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.gateway_validated_model_replies
  USING (organization_id = gotchu.tenant_id()) WITH CHECK (organization_id = gotchu.tenant_id());
REVOKE ALL ON gotchu.gateway_validated_model_replies
  FROM PUBLIC, gotchu_api, gotchu_ingest, gotchu_executor, gotchu_validator, gotchu_coordinator;
GRANT SELECT, INSERT ON gotchu.gateway_validated_model_replies TO gotchu_coordinator;
