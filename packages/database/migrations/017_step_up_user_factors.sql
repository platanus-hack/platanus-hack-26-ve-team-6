-- Nothing using migration 015 has shipped. Replace its workspace-local factor
-- rows instead of trying to merge identities that were scoped incorrectly.
DROP TABLE gotchu.step_up_proofs;
DROP TABLE gotchu.step_up_challenges;
DROP TABLE gotchu.step_up_recovery_codes;
DROP TABLE gotchu.step_up_factors;

CREATE TABLE gotchu.step_up_user_factors (
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
  PRIMARY KEY (user_id,id)
);
CREATE INDEX step_up_user_factors_active ON gotchu.step_up_user_factors(user_id) WHERE revoked_at IS NULL;

CREATE TABLE gotchu.step_up_user_recovery_codes (
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 256),
  id uuid NOT NULL,
  salt bytea NOT NULL,
  code_hash bytea NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,id)
);

CREATE TABLE gotchu.step_up_challenges (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('enroll','assert')),
  action_hash text CHECK (action_hash IS NULL OR action_hash ~ '^[a-f0-9]{64}$'),
  challenge text NOT NULL CHECK (length(challenge) BETWEEN 32 AND 128),
  recovery_epoch bigint NOT NULL CHECK (recovery_epoch > 0),
  enrollment_authorization text CHECK (enrollment_authorization IN ('existing_factor','recovery_code','bootstrap')),
  authorization_factor_id uuid,
  enrollment_factor_count integer CHECK (enrollment_factor_count >= 0),
  enrollment_factor_ids uuid[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (user_id,authorization_factor_id) REFERENCES gotchu.step_up_user_factors(user_id,id),
  CHECK ((purpose='assert') = (action_hash IS NOT NULL)),
  CHECK ((purpose='enroll') = (enrollment_authorization IS NOT NULL AND enrollment_factor_count IS NOT NULL)),
  CHECK ((enrollment_authorization='existing_factor') = (authorization_factor_id IS NOT NULL))
);
CREATE INDEX step_up_challenges_expiry ON gotchu.step_up_challenges(organization_id,expires_at);

CREATE TABLE gotchu.step_up_proofs (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id text NOT NULL,
  proof_hash text NOT NULL UNIQUE CHECK (proof_hash ~ '^[a-f0-9]{64}$'),
  action_hash text NOT NULL CHECK (action_hash ~ '^[a-f0-9]{64}$'),
  recovery_epoch bigint NOT NULL CHECK (recovery_epoch > 0),
  authenticated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  factor_id uuid NOT NULL,
  factor_count integer NOT NULL CHECK (factor_count >= 1),
  factor_ids uuid[] NOT NULL,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (user_id,factor_id) REFERENCES gotchu.step_up_user_factors(user_id,id)
);
CREATE INDEX step_up_proofs_expiry ON gotchu.step_up_proofs(organization_id,expires_at);

-- The API role sets this transaction-local value only after validating the
-- Auth.js session and workspace membership. RLS still limits rows to that user
-- and to a workspace where they are a member; factors themselves are global.
CREATE FUNCTION gotchu.step_up_user_in_tenant(p_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM gotchu.memberships m WHERE m.organization_id=gotchu.tenant_id() AND m.user_id=p_user)
$$;
REVOKE ALL ON FUNCTION gotchu.step_up_user_in_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.step_up_user_in_tenant(text) TO gotchu_api;

ALTER TABLE gotchu.step_up_user_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.step_up_user_factors FORCE ROW LEVEL SECURITY;
CREATE POLICY step_up_user_scope ON gotchu.step_up_user_factors USING (
  user_id=nullif(current_setting('gotchu.step_up_user',true),'') AND gotchu.step_up_user_in_tenant(user_id)
) WITH CHECK (
  user_id=nullif(current_setting('gotchu.step_up_user',true),'') AND gotchu.step_up_user_in_tenant(user_id)
);
ALTER TABLE gotchu.step_up_user_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.step_up_user_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY step_up_recovery_user_scope ON gotchu.step_up_user_recovery_codes USING (
  user_id=nullif(current_setting('gotchu.step_up_user',true),'') AND gotchu.step_up_user_in_tenant(user_id)
) WITH CHECK (
  user_id=nullif(current_setting('gotchu.step_up_user',true),'') AND gotchu.step_up_user_in_tenant(user_id)
);
DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['step_up_challenges','step_up_proofs'] LOOP
    EXECUTE format('ALTER TABLE gotchu.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE gotchu.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON gotchu.%I USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id())',t);
  END LOOP;
END $$;
CREATE POLICY step_up_owner_invalidation ON gotchu.step_up_challenges TO gotchu_owner USING (true) WITH CHECK (true);
CREATE POLICY step_up_owner_invalidation ON gotchu.step_up_proofs TO gotchu_owner USING (true) WITH CHECK (true);
REVOKE ALL ON gotchu.step_up_user_factors,gotchu.step_up_user_recovery_codes,gotchu.step_up_challenges,gotchu.step_up_proofs FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON gotchu.step_up_user_factors,gotchu.step_up_user_recovery_codes,gotchu.step_up_challenges,gotchu.step_up_proofs TO gotchu_api;

CREATE FUNCTION gotchu.step_up_invalidate_user(p_user text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE invalidated integer;
BEGIN
  UPDATE gotchu.step_up_challenges SET consumed_at=clock_timestamp()
    WHERE user_id=p_user AND consumed_at IS NULL;
  GET DIAGNOSTICS invalidated = ROW_COUNT;
  UPDATE gotchu.step_up_proofs SET consumed_at=clock_timestamp()
    WHERE user_id=p_user AND consumed_at IS NULL;
  RETURN invalidated;
END $$;
REVOKE ALL ON FUNCTION gotchu.step_up_invalidate_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.step_up_invalidate_user(text) TO gotchu_api;

CREATE FUNCTION gotchu.auth_lookup_id(p_id uuid) RETURNS TABLE(id uuid,password_hash text,epoch integer)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT a.id,a.password_hash,a.epoch FROM gotchu.local_accounts a WHERE a.id=p_id AND NOT a.disabled
$$;
REVOKE ALL ON FUNCTION gotchu.auth_lookup_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.auth_lookup_id(uuid) TO gotchu_api;
