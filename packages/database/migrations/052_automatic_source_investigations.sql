ALTER TABLE gotchu.investigation_model_settings
  ADD COLUMN automatic_source_investigations boolean NOT NULL DEFAULT false;
ALTER TABLE gotchu.investigation_model_settings
  ADD CONSTRAINT automatic_source_investigation_consent
  CHECK (NOT automatic_source_investigations OR (consent_to_external_processing AND data_scopes ? 'finding_details'));
