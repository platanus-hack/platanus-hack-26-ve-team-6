-- Existing calls retain their original token limits and any unresolved holds.
-- Locate migration 041's unnamed, two-column check by its referenced columns.
DO $$
DECLARE
  usage_constraint name;
BEGIN
  SELECT conname INTO STRICT usage_constraint
    FROM pg_constraint
    WHERE conrelid = 'gotchu.model_reservations'::regclass AND contype = 'c'
      AND cardinality(conkey) = 2 AND conkey @> ARRAY(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'gotchu.model_reservations'::regclass
          AND attname IN ('charged_tokens', 'reserved_tokens')
      );
  EXECUTE format('ALTER TABLE gotchu.model_reservations DROP CONSTRAINT %I', usage_constraint);
END;
$$;

ALTER TABLE gotchu.model_reservations
  ADD COLUMN token_limit_enforced boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT model_reservations_charged_tokens_check CHECK (
    charged_tokens >= 0 AND (NOT token_limit_enforced OR charged_tokens <= reserved_tokens)
  ),
  ADD CONSTRAINT model_reservations_subscription_hold CHECK (
    token_limit_enforced OR (reserved_tokens = 0 AND amount_micros = 1)
  );

-- Subscription usage is observed even after the configured token threshold.
-- Per-token admission still enforces that threshold under the organization lock.
ALTER TABLE gotchu.organizations DROP CONSTRAINT organization_model_token_budget;

CREATE FUNCTION gotchu.reject_model_token_limit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_limit_enforced IS DISTINCT FROM OLD.token_limit_enforced THEN
    RAISE EXCEPTION 'Model reservation token enforcement is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER model_reservation_token_limit_immutable
  BEFORE UPDATE OF token_limit_enforced ON gotchu.model_reservations
  FOR EACH ROW EXECUTE FUNCTION gotchu.reject_model_token_limit_change();
