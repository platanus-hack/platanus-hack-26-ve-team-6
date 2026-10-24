CREATE TABLE gotchu.step_up_factors (
  organization_id uuid NOT NULL,
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 256),
  id uuid NOT NULL,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (organization_id,user_id,id),
  FOREIGN KEY (organization_id,user_id) REFERENCES gotchu.memberships(organization_id,user_id)
);
CREATE INDEX step_up_factors_active ON gotchu.step_up_factors(organization_id,user_id) WHERE revoked_at IS NULL;
CREATE TABLE gotchu.step_up_recovery_codes (
  organization_id uuid NOT NULL, user_id text NOT NULL, id uuid NOT NULL,
  salt bytea NOT NULL, code_hash bytea NOT NULL, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,user_id,id),
  FOREIGN KEY (organization_id,user_id) REFERENCES gotchu.memberships(organization_id,user_id)
);
CREATE TABLE gotchu.step_up_challenges (
  organization_id uuid NOT NULL, id uuid NOT NULL, user_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('enroll','assert','recovery')),
  action_hash text CHECK (action_hash IS NULL OR action_hash ~ '^[a-f0-9]{64}$'),
  challenge text NOT NULL CHECK (length(challenge) BETWEEN 32 AND 128),
  recovery_epoch bigint NOT NULL CHECK (recovery_epoch > 0),
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,user_id) REFERENCES gotchu.memberships(organization_id,user_id),
  CHECK ((purpose='assert') = (action_hash IS NOT NULL))
);
CREATE INDEX step_up_challenges_expiry ON gotchu.step_up_challenges(organization_id,expires_at);
CREATE TABLE gotchu.step_up_proofs (
  organization_id uuid NOT NULL, id uuid NOT NULL, user_id text NOT NULL,
  proof_hash text NOT NULL UNIQUE CHECK (proof_hash ~ '^[a-f0-9]{64}$'),
  action_hash text NOT NULL CHECK (action_hash ~ '^[a-f0-9]{64}$'),
  recovery_epoch bigint NOT NULL CHECK (recovery_epoch > 0),
  authenticated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  factor_id uuid NOT NULL,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,user_id,factor_id) REFERENCES gotchu.step_up_factors(organization_id,user_id,id)
);
CREATE INDEX step_up_proofs_expiry ON gotchu.step_up_proofs(organization_id,expires_at);
CREATE OR REPLACE FUNCTION gotchu.auth_admit(p_bucket text,p_limit integer,p_window integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE count_now integer;
BEGIN
  IF p_bucket !~ '^(login|register|step-up|step-up-recovery):(global|[a-f0-9]{64})$' OR p_limit NOT BETWEEN 1 AND 100 OR p_window NOT BETWEEN 1 AND 3600 THEN RETURN false; END IF;
  INSERT INTO gotchu.local_auth_limits(bucket,started_at,attempts) VALUES(p_bucket,clock_timestamp(),1)
  ON CONFLICT(bucket) DO UPDATE SET
    started_at=CASE WHEN gotchu.local_auth_limits.started_at<=clock_timestamp()-make_interval(secs=>p_window) THEN clock_timestamp() ELSE gotchu.local_auth_limits.started_at END,
    attempts=CASE WHEN gotchu.local_auth_limits.started_at<=clock_timestamp()-make_interval(secs=>p_window) THEN 1 ELSE LEAST(gotchu.local_auth_limits.attempts+1,1000000) END
  RETURNING attempts INTO count_now;
  DELETE FROM gotchu.local_auth_limits WHERE started_at<clock_timestamp()-interval '2 hours';
  RETURN count_now<=p_limit;
END $$;
DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['step_up_factors','step_up_recovery_codes','step_up_challenges','step_up_proofs'] LOOP
    EXECUTE format('ALTER TABLE gotchu.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE gotchu.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON gotchu.%I USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id())',t);
  END LOOP;
END $$;
REVOKE ALL ON gotchu.step_up_factors,gotchu.step_up_recovery_codes,gotchu.step_up_challenges,gotchu.step_up_proofs FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON gotchu.step_up_factors,gotchu.step_up_recovery_codes,gotchu.step_up_challenges,gotchu.step_up_proofs TO gotchu_api;
