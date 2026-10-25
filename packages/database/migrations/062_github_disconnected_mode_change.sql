-- Migration 061 is already applied locally; keep its checksum immutable.
-- Active connections keep their mode. A disconnected installation may reconnect
-- through the legacy path after the shared ownership/transfer checks succeed.
CREATE OR REPLACE FUNCTION gotchu.github_bind_installation(p_org uuid,p_user text,p_installation text,p_login text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
  IF p_org IS DISTINCT FROM gotchu.tenant_id() THEN RETURN 'forbidden'; END IF;
  IF coalesce(gotchu.lock_membership(p_org,p_user),'') NOT IN ('owner','operator')
    OR NOT gotchu.lock_customer_organization(p_org) THEN RETURN 'forbidden'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('github-installation:'||p_installation,0));
  IF EXISTS(SELECT 1 FROM gotchu.github_installations WHERE organization_id=p_org AND installation_id=p_installation
    AND state='active' AND connection_mode='single_app') THEN RETURN 'reconnection_required'; END IF;
  result:=gotchu.github_bind_legacy_installation(p_org,p_user,p_installation,p_login);
  IF result='bound' THEN
    UPDATE gotchu.github_installations SET connection_mode='legacy',app_id=NULL
      WHERE organization_id=p_org AND installation_id=p_installation;
  END IF;
  RETURN result;
END $$;
