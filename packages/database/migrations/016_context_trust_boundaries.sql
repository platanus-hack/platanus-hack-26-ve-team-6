-- Customer context is evidence supplied by an untrusted workspace member. Trusted
-- verification facts remain available to operator/telemetry paths, but customer
-- SQL entry points can only create declarations.
CREATE OR REPLACE FUNCTION gotchu.context_create_environment(p_org uuid,p_app uuid,p_user text,p_id uuid,p_name text,p_kind text,p_source text,p_observed timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 IF p_source IS DISTINCT FROM 'customer_declared' THEN RAISE EXCEPTION 'context_self_assertion'; END IF;
 IF (SELECT count(*) FROM gotchu.application_environments WHERE organization_id=p_org AND application_id=p_app)>=10 THEN RAISE EXCEPTION 'context_environment_limit'; END IF;
 INSERT INTO gotchu.application_environments(organization_id,application_id,id,name,kind,state,source,observed_at) VALUES(p_org,p_app,p_id,p_name,p_kind,'declared','customer_declared',p_observed); RETURN true; END $$;
CREATE OR REPLACE FUNCTION gotchu.context_create_service(p_org uuid,p_app uuid,p_user text,p_env uuid,p_id uuid,p_name text,p_kind text,p_source text,p_observed timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 IF p_source IS DISTINCT FROM 'customer_declared' THEN RAISE EXCEPTION 'context_self_assertion'; END IF;
 IF NOT EXISTS(SELECT 1 FROM gotchu.application_environments WHERE organization_id=p_org AND application_id=p_app AND id=p_env AND NOT archived) THEN RETURN false; END IF;
 IF (SELECT count(*) FROM gotchu.application_services WHERE organization_id=p_org AND application_id=p_app AND environment_id=p_env)>=50 THEN RAISE EXCEPTION 'context_service_limit'; END IF;
 INSERT INTO gotchu.application_services(organization_id,application_id,environment_id,id,name,kind,state,source,observed_at) VALUES(p_org,p_app,p_env,p_id,p_name,p_kind,'declared','customer_declared',p_observed); RETURN true; END $$;
CREATE OR REPLACE FUNCTION gotchu.context_create_repository(p_org uuid,p_app uuid,p_user text,p_id uuid,p_key text,p_subdir text,p_branch text,p_read text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 IF p_read IS DISTINCT FROM 'granted' THEN RAISE EXCEPTION 'context_self_assertion'; END IF;
 IF (SELECT count(*) FROM gotchu.application_repository_links WHERE organization_id=p_org AND application_id=p_app)>=20 THEN RAISE EXCEPTION 'context_repository_limit'; END IF;
 INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,subdirectory,default_branch,read_access,write_access,revoked,state,source) VALUES(p_org,p_app,p_id,p_key,p_subdir,p_branch,'granted','not_granted',false,'declared','customer_declared'); RETURN true; END $$;
CREATE OR REPLACE FUNCTION gotchu.context_revoke_repository(p_org uuid,p_app uuid,p_user text,p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 UPDATE gotchu.application_repository_links SET revoked=true,read_access='revoked',write_access=CASE WHEN write_access='not_granted' THEN write_access ELSE 'revoked' END WHERE organization_id=p_org AND application_id=p_app AND id=p_id AND NOT revoked; RETURN FOUND; END $$;
CREATE OR REPLACE FUNCTION gotchu.context_create_deployment(p_org uuid,p_app uuid,p_user text,p_env uuid,p_service uuid,p_id uuid,p_release text,p_commit text,p_snapshot text,p_artifact text,p_deployed timestamptz,p_state text,p_source text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 IF p_state IS DISTINCT FROM 'declared' OR p_source IS DISTINCT FROM 'customer_declared' THEN RAISE EXCEPTION 'context_self_assertion'; END IF;
 IF NOT EXISTS(SELECT 1 FROM gotchu.application_services s JOIN gotchu.application_environments e ON e.organization_id=s.organization_id AND e.application_id=s.application_id AND e.id=s.environment_id WHERE s.organization_id=p_org AND s.application_id=p_app AND s.environment_id=p_env AND s.id=p_service AND NOT e.archived) THEN RETURN false; END IF;
 INSERT INTO gotchu.application_deployments(organization_id,application_id,environment_id,service_id,id,release_id,commit_sha,source_snapshot_digest,artifact_digest,deployed_at,state,source) VALUES(p_org,p_app,p_env,p_service,p_id,p_release,p_commit,p_snapshot,p_artifact,p_deployed,'declared','customer_declared');
 DELETE FROM gotchu.application_deployments WHERE organization_id=p_org AND application_id=p_app AND service_id=p_service AND id IN (SELECT id FROM gotchu.application_deployments WHERE organization_id=p_org AND application_id=p_app AND service_id=p_service ORDER BY deployed_at DESC,id DESC OFFSET 500); RETURN true; END $$;
CREATE OR REPLACE FUNCTION gotchu.context_create_dependency(p_org uuid,p_app uuid,p_user text,p_env uuid,p_service uuid,p_id uuid,p_kind text,p_provider text,p_component text,p_region text,p_state text,p_source text,p_observed timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 IF p_state IS DISTINCT FROM 'declared' OR p_source IS DISTINCT FROM 'customer_declared' THEN RAISE EXCEPTION 'context_self_assertion'; END IF;
 IF NOT EXISTS(SELECT 1 FROM gotchu.application_services s JOIN gotchu.application_environments e ON e.organization_id=s.organization_id AND e.application_id=s.application_id AND e.id=s.environment_id WHERE s.organization_id=p_org AND s.application_id=p_app AND s.environment_id=p_env AND s.id=p_service AND NOT e.archived) THEN RETURN false; END IF;
 IF (SELECT count(*) FROM gotchu.application_dependencies WHERE organization_id=p_org AND application_id=p_app AND environment_id=p_env)>=100 THEN RAISE EXCEPTION 'context_dependency_limit'; END IF;
 INSERT INTO gotchu.application_dependencies(organization_id,application_id,environment_id,service_id,id,kind,provider,component,region,state,source,observed_at) VALUES(p_org,p_app,p_env,p_service,p_id,p_kind,p_provider,p_component,p_region,'declared','customer_declared',p_observed); RETURN true; END $$;
CREATE OR REPLACE FUNCTION gotchu.context_create_origin(p_org uuid,p_app uuid,p_user text,p_env uuid,p_id uuid,p_origin text,p_discovery text,p_ownership text,p_target uuid,p_state text,p_source text,p_observed timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 IF p_state IS DISTINCT FROM 'declared' OR p_source IS DISTINCT FROM 'customer_declared' OR p_ownership NOT IN ('unknown','claimed') THEN RAISE EXCEPTION 'context_self_assertion'; END IF;
 IF NOT EXISTS(SELECT 1 FROM gotchu.application_environments WHERE organization_id=p_org AND application_id=p_app AND id=p_env AND NOT archived) THEN RETURN false; END IF;
 IF p_target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gotchu.customer_targets WHERE organization_id=p_org AND application_id=p_app AND id=p_target AND origin=p_origin) THEN RAISE EXCEPTION 'context_target_origin_mismatch'; END IF;
 IF (SELECT count(*) FROM gotchu.application_origin_candidates WHERE organization_id=p_org AND application_id=p_app AND environment_id=p_env)>=200 THEN RAISE EXCEPTION 'context_origin_limit'; END IF;
 INSERT INTO gotchu.application_origin_candidates(organization_id,application_id,environment_id,id,origin,discovery_source,ownership,authorization_target_id,state,source,observed_at) VALUES(p_org,p_app,p_env,p_id,p_origin,p_discovery,p_ownership,p_target,'declared','customer_declared',p_observed); RETURN true; END $$;
CREATE OR REPLACE FUNCTION gotchu.context_update_service(p_org uuid,p_app uuid,p_user text,p_id uuid,p_name text,p_kind text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT gotchu.context_guard(p_org,p_app,p_user) THEN RETURN false; END IF;
 UPDATE gotchu.application_services s SET name=coalesce(p_name,s.name),kind=coalesce(p_kind,s.kind) FROM gotchu.application_environments e WHERE s.organization_id=p_org AND s.application_id=p_app AND s.id=p_id AND e.organization_id=s.organization_id AND e.application_id=s.application_id AND e.id=s.environment_id AND NOT e.archived; RETURN FOUND; END $$;
