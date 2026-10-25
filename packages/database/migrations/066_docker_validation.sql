ALTER TABLE gotchu.validation_runs
  DROP CONSTRAINT validation_runs_sandbox_kind_check,
  ADD CONSTRAINT validation_runs_sandbox_kind_check
    CHECK (sandbox_kind IN ('bwrap+systemd-scope','jailer','docker'));

ALTER TABLE gotchu.validation_runs
  ADD COLUMN container_image_digest text
    CHECK (container_image_digest IS NULL OR container_image_digest ~ '^[a-f0-9]{64}$');

GRANT UPDATE(container_image_digest) ON gotchu.validation_runs TO gotchu_validator;
