-- Existing scopes keep their exact profile. Active API checks require a new enrollment.
ALTER TABLE gotchu.customer_targets DROP CONSTRAINT customer_targets_scan_profile_check;
ALTER TABLE gotchu.customer_targets ADD CONSTRAINT customer_targets_scan_profile_check
  CHECK (scan_profile IN ('root','public_surface','api_checks'));
