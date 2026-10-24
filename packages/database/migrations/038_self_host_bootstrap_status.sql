CREATE FUNCTION gotchu.self_host_bootstrap_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM gotchu.self_host_bootstrap_state WHERE singleton)
$$;
REVOKE ALL ON FUNCTION gotchu.self_host_bootstrap_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.self_host_bootstrap_complete() TO gotchu_api;
