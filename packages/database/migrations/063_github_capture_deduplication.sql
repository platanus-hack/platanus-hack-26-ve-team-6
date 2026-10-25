-- A canonical snapshot can be captured under more than one immutable authority.
-- Empty keys preserve the existing uniqueness of ordinary uploads. Capture keys
-- are server-derived deduplication hints, never repository authorization.
ALTER TABLE gotchu.customer_sources
  ADD COLUMN capture_key text NOT NULL DEFAULT '' CHECK(capture_key='' OR capture_key ~ '^[a-f0-9]{64}$');

DROP INDEX gotchu.customer_sources_active_digest;
CREATE UNIQUE INDEX customer_sources_active_digest
  ON gotchu.customer_sources(organization_id,application_id,digest,capture_key) WHERE deleted_at IS NULL;
