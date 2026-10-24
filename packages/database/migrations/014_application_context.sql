CREATE TABLE gotchu.application_environments (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL, name text NOT NULL CHECK(name ~ '^[a-z][a-z0-9-]{0,62}$'),
 kind text NOT NULL CHECK(kind IN ('production','staging','development','test','other')), archived boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'declared' CHECK(state IN ('declared','verified','unknown')),
 source text NOT NULL CHECK(source IN ('customer_declared','signed_telemetry','operator')), observed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,application_id,id), UNIQUE(organization_id,application_id,name),
 FOREIGN KEY(organization_id,application_id) REFERENCES gotchu.applications(organization_id,id)
);
CREATE TABLE gotchu.application_services (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, environment_id uuid NOT NULL, id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), kind text NOT NULL CHECK(kind IN ('web','api','worker','database','queue','other')),
 state text NOT NULL CHECK(state IN ('declared','verified','unknown')), source text NOT NULL CHECK(source IN ('customer_declared','signed_telemetry','operator')),
 observed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,application_id,id),
 UNIQUE(organization_id,application_id,environment_id,id),
 FOREIGN KEY(organization_id,application_id,environment_id) REFERENCES gotchu.application_environments(organization_id,application_id,id)
);
CREATE TABLE gotchu.application_repository_links (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, id uuid NOT NULL, repository_key text NOT NULL CHECK(repository_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
 subdirectory text CHECK(subdirectory IS NULL OR (length(subdirectory) BETWEEN 1 AND 256 AND subdirectory !~ '(^/|\\|(^|/)\.\.?(/|$))')),
 default_branch text NOT NULL CHECK(length(default_branch) BETWEEN 1 AND 128), read_access text NOT NULL CHECK(read_access IN ('not_granted','granted','revoked')),
 write_access text NOT NULL DEFAULT 'not_granted' CHECK(write_access IN ('not_granted','granted','revoked')), revoked boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'declared' CHECK(state IN ('declared','verified','unknown')), source text NOT NULL DEFAULT 'customer_declared' CHECK(source IN ('customer_declared','signed_telemetry','operator')),
 observed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,application_id,id),
 UNIQUE(organization_id,application_id,repository_key), FOREIGN KEY(organization_id,application_id) REFERENCES gotchu.applications(organization_id,id)
);
CREATE TABLE gotchu.application_deployments (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, service_id uuid NOT NULL, environment_id uuid NOT NULL, id uuid NOT NULL,
 release_id text NOT NULL CHECK(length(release_id) BETWEEN 1 AND 200), commit_sha text CHECK(commit_sha IS NULL OR commit_sha ~* '^[0-9a-f]{40}$'),
 source_snapshot_digest text CHECK(source_snapshot_digest IS NULL OR source_snapshot_digest ~ '^[0-9a-f]{64}$'), artifact_digest text CHECK(artifact_digest IS NULL OR artifact_digest ~* '^sha256:[0-9a-f]{64}$'),
 deployed_at timestamptz NOT NULL, state text NOT NULL CHECK(state IN ('declared','verified','unknown')),
 source text NOT NULL CHECK(source IN ('customer_declared','signed_telemetry','operator')), observed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id,environment_id,service_id) REFERENCES gotchu.application_services(organization_id,application_id,environment_id,id)
);
CREATE INDEX application_deployments_retention ON gotchu.application_deployments(organization_id,application_id,service_id,deployed_at DESC);
CREATE TABLE gotchu.application_dependencies (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, environment_id uuid NOT NULL, service_id uuid NOT NULL, id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('provider_component','external_api','database','package')), provider text NOT NULL CHECK(provider IN ('cloudflare','railway','postgres','other')),
 component text NOT NULL CHECK(length(component) BETWEEN 1 AND 200), region text CHECK(region IS NULL OR length(region)<=100),
 state text NOT NULL CHECK(state IN ('declared','verified','unknown')), source text NOT NULL CHECK(source IN ('customer_declared','signed_telemetry','operator')),
 observed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id,environment_id,service_id) REFERENCES gotchu.application_services(organization_id,application_id,environment_id,id)
);
CREATE TABLE gotchu.application_origin_candidates (
 organization_id uuid NOT NULL, application_id uuid NOT NULL, environment_id uuid NOT NULL, id uuid NOT NULL,
 origin text NOT NULL CHECK(length(origin) BETWEEN 1 AND 300), discovery_source text NOT NULL CHECK(discovery_source IN ('customer_inventory','dns','public_reference')),
 ownership text NOT NULL CHECK(ownership IN ('unknown','claimed','verified')), authorization_target_id uuid,
 state text NOT NULL CHECK(state IN ('declared','verified','unknown')), source text NOT NULL CHECK(source IN ('customer_declared','signed_telemetry','operator')),
 observed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id,environment_id) REFERENCES gotchu.application_environments(organization_id,application_id,id),
 FOREIGN KEY(organization_id,application_id,authorization_target_id) REFERENCES gotchu.customer_targets(organization_id,application_id,id), UNIQUE(organization_id,application_id,environment_id,origin)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['application_environments','application_services','application_repository_links','application_deployments','application_dependencies','application_origin_candidates'] LOOP
 EXECUTE format('ALTER TABLE gotchu.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE gotchu.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON gotchu.%I USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id())',t);
END LOOP; END $$;
REVOKE ALL ON gotchu.application_environments,gotchu.application_services,gotchu.application_repository_links,gotchu.application_deployments,gotchu.application_dependencies,gotchu.application_origin_candidates FROM PUBLIC;
GRANT SELECT ON gotchu.application_environments,gotchu.application_services,gotchu.application_repository_links,gotchu.application_deployments,gotchu.application_dependencies,gotchu.application_origin_candidates TO gotchu_api;

CREATE FUNCTION gotchu.context_guard(p_org uuid,p_app uuid,p_user text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a jsonb;
BEGIN
 IF p_org IS DISTINCT FROM gotchu.tenant_id() OR coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator') THEN RETURN false; END IF;
 IF NOT gotchu.lock_customer_organization(p_org) THEN RETURN false; END IF;
 a:=gotchu.lock_customer_application(p_org,p_app); RETURN a IS NOT NULL AND NOT (a->>'archived')::boolean;
END $$;
CREATE FUNCTION gotchu.context_create_environment(p_org uuid,p_app uuid,p_user text,p_id uuid,p_name text,p_kind text,p_source text,p_observed timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 IF (SELECT count(*) FROM gotchu.application_environments WHERE organization_id=p_org AND application_id=p_app)>=10 THEN RAISE EXCEPTION 'context_environment_limit'; END IF;
 INSERT INTO gotchu.application_environments(organization_id,application_id,id,name,kind,source,observed_at) VALUES(p_org,p_app,p_id,p_name,p_kind,p_source,p_observed); RETURN true; END $$;
CREATE FUNCTION gotchu.context_create_service(p_org uuid,p_app uuid,p_user text,p_env uuid,p_id uuid,p_name text,p_kind text,p_source text,p_observed timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM gotchu.application_environments WHERE organization_id=p_org AND application_id=p_app AND id=p_env AND NOT archived) THEN RETURN false; END IF;
 IF (SELECT count(*) FROM gotchu.application_services WHERE organization_id=p_org AND application_id=p_app AND environment_id=p_env)>=50 THEN RAISE EXCEPTION 'context_service_limit'; END IF;
 INSERT INTO gotchu.application_services(organization_id,application_id,environment_id,id,name,kind,state,source,observed_at) VALUES(p_org,p_app,p_env,p_id,p_name,p_kind,'declared',p_source,p_observed); RETURN true; END $$;
CREATE FUNCTION gotchu.context_create_repository(p_org uuid,p_app uuid,p_user text,p_id uuid,p_key text,p_subdir text,p_branch text,p_read text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,subdirectory,default_branch,read_access) VALUES(p_org,p_app,p_id,p_key,p_subdir,p_branch,p_read); RETURN true; END $$;
CREATE FUNCTION gotchu.context_revoke_repository(p_org uuid,p_app uuid,p_user text,p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 UPDATE gotchu.application_repository_links SET revoked=true,read_access='revoked',write_access=CASE WHEN write_access='not_granted' THEN write_access ELSE 'revoked' END,state='unknown' WHERE organization_id=p_org AND application_id=p_app AND id=p_id AND NOT revoked; RETURN FOUND; END $$;
CREATE FUNCTION gotchu.context_create_deployment(p_org uuid,p_app uuid,p_user text,p_env uuid,p_service uuid,p_id uuid,p_release text,p_commit text,p_snapshot text,p_artifact text,p_deployed timestamptz,p_state text,p_source text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM gotchu.application_services WHERE organization_id=p_org AND application_id=p_app AND environment_id=p_env AND id=p_service) THEN RETURN false; END IF;
 INSERT INTO gotchu.application_deployments(organization_id,application_id,environment_id,service_id,id,release_id,commit_sha,source_snapshot_digest,artifact_digest,deployed_at,state,source) VALUES(p_org,p_app,p_env,p_service,p_id,p_release,p_commit,p_snapshot,p_artifact,p_deployed,p_state,p_source);
 DELETE FROM gotchu.application_deployments WHERE organization_id=p_org AND application_id=p_app AND service_id=p_service AND id IN (SELECT id FROM gotchu.application_deployments WHERE organization_id=p_org AND application_id=p_app AND service_id=p_service ORDER BY deployed_at DESC,id DESC OFFSET 500); RETURN true; END $$;
CREATE FUNCTION gotchu.context_create_dependency(p_org uuid,p_app uuid,p_user text,p_env uuid,p_service uuid,p_id uuid,p_kind text,p_provider text,p_component text,p_region text,p_state text,p_source text,p_observed timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM gotchu.application_services WHERE organization_id=p_org AND application_id=p_app AND environment_id=p_env AND id=p_service) THEN RETURN false; END IF;
 IF (SELECT count(*) FROM gotchu.application_dependencies WHERE organization_id=p_org AND application_id=p_app AND environment_id=p_env)>=100 THEN RAISE EXCEPTION 'context_dependency_limit'; END IF;
 INSERT INTO gotchu.application_dependencies(organization_id,application_id,environment_id,service_id,id,kind,provider,component,region,state,source,observed_at) VALUES(p_org,p_app,p_env,p_service,p_id,p_kind,p_provider,p_component,p_region,p_state,p_source,p_observed); RETURN true; END $$;
CREATE FUNCTION gotchu.context_create_origin(p_org uuid,p_app uuid,p_user text,p_env uuid,p_id uuid,p_origin text,p_discovery text,p_ownership text,p_target uuid,p_state text,p_source text,p_observed timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM gotchu.application_environments WHERE organization_id=p_org AND application_id=p_app AND id=p_env AND NOT archived) THEN RETURN false; END IF;
 IF (SELECT count(*) FROM gotchu.application_origin_candidates WHERE organization_id=p_org AND application_id=p_app AND environment_id=p_env)>=200 THEN RAISE EXCEPTION 'context_origin_limit'; END IF;
 INSERT INTO gotchu.application_origin_candidates(organization_id,application_id,environment_id,id,origin,discovery_source,ownership,authorization_target_id,state,source,observed_at) VALUES(p_org,p_app,p_env,p_id,p_origin,p_discovery,p_ownership,p_target,p_state,p_source,p_observed); RETURN true; END $$;
CREATE FUNCTION gotchu.context_archive_environment(p_org uuid,p_app uuid,p_user text,p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 UPDATE gotchu.application_environments SET archived=true WHERE organization_id=p_org AND application_id=p_app AND id=p_id AND NOT archived; RETURN FOUND; END $$;
CREATE FUNCTION gotchu.context_update_environment(p_org uuid,p_app uuid,p_user text,p_id uuid,p_name text,p_kind text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 UPDATE gotchu.application_environments SET name=coalesce(p_name,name),kind=coalesce(p_kind,kind) WHERE organization_id=p_org AND application_id=p_app AND id=p_id AND NOT archived; RETURN FOUND; END $$;
CREATE FUNCTION gotchu.context_update_service(p_org uuid,p_app uuid,p_user text,p_id uuid,p_name text,p_kind text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 UPDATE gotchu.application_services SET name=coalesce(p_name,name),kind=coalesce(p_kind,kind) WHERE organization_id=p_org AND application_id=p_app AND id=p_id; RETURN FOUND; END $$;
DO $$ DECLARE f record; BEGIN FOR f IN SELECT p.proname,p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='gotchu' AND p.proname LIKE 'context_%' LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||f.signature||' FROM PUBLIC'; IF f.proname <> 'context_guard' THEN EXECUTE 'GRANT EXECUTE ON FUNCTION '||f.signature||' TO gotchu_api'; END IF; END LOOP; END $$;
