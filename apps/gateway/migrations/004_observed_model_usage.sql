-- Provider observations are reconciliation evidence, not charged usage or released holds.
ALTER TABLE gotchu.model_reservations
  ADD COLUMN observed_input_tokens bigint CHECK (observed_input_tokens BETWEEN 0 AND 1000000000),
  ADD COLUMN observed_output_tokens bigint CHECK (observed_output_tokens BETWEEN 0 AND 1000000000),
  ADD COLUMN observed_at timestamptz,
  ADD CONSTRAINT model_reservations_observed_usage_paired CHECK (
    (observed_input_tokens IS NULL AND observed_output_tokens IS NULL AND observed_at IS NULL)
    OR (observed_input_tokens IS NOT NULL AND observed_output_tokens IS NOT NULL AND observed_at IS NOT NULL)
  );

CREATE FUNCTION gotchu.preserve_observed_model_usage() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.observed_at IS NOT NULL AND
    ROW(NEW.observed_input_tokens, NEW.observed_output_tokens, NEW.observed_at)
      IS DISTINCT FROM ROW(OLD.observed_input_tokens, OLD.observed_output_tokens, OLD.observed_at) THEN
    RAISE EXCEPTION 'Model usage observation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gotchu.preserve_observed_model_usage() FROM PUBLIC;
CREATE TRIGGER model_reservations_preserve_observed_usage
  BEFORE UPDATE OF observed_input_tokens, observed_output_tokens, observed_at ON gotchu.model_reservations
  FOR EACH ROW EXECUTE FUNCTION gotchu.preserve_observed_model_usage();

-- Existing forced tenant RLS and coordinator table UPDATE cover these columns.
-- The API has no reservation write grant; no new access or billing permissions are needed.
