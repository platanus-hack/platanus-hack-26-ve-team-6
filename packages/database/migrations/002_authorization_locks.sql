-- Narrow definer functions lock authorization state without granting runtime roles
-- permission to edit memberships or recovery state. FORCE RLS still applies to owner.
CREATE FUNCTION gotchu.lock_membership(p_organization uuid, p_user text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result text;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() THEN RETURN NULL; END IF;
  SELECT role INTO result FROM gotchu.memberships WHERE organization_id=p_organization AND user_id=p_user FOR SHARE;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION gotchu.lock_membership(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.lock_membership(uuid,text) TO gotchu_api, gotchu_executor;
CREATE FUNCTION gotchu.lock_authorization_state() RETURNS TABLE(recovery_epoch bigint, writes_frozen boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT recovery_epoch,writes_frozen FROM gotchu.platform_state WHERE singleton FOR SHARE
$$;
REVOKE ALL ON FUNCTION gotchu.lock_authorization_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.lock_authorization_state() TO gotchu_api, gotchu_executor;
