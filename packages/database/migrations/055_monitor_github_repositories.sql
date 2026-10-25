-- Scheduled monitoring of repositories connected through the GitHub App.
-- The coordinator cannot read GitHub installations; it may only resolve
-- the repository its own tenant's enabled monitor selected, while the link and installation stay active.
CREATE FUNCTION gotchu.monitor_github_repository(p_org uuid,p_app uuid,p_key text)
RETURNS TABLE(installation_id text,default_branch text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT l.installation_id,l.default_branch
  FROM gotchu.operation_monitors m
  JOIN gotchu.application_repository_links l ON l.organization_id=m.organization_id AND l.application_id=m.application_id AND l.repository_key=m.repository_key
  JOIN gotchu.github_installations g ON g.organization_id=l.organization_id AND g.installation_id=l.installation_id
  WHERE p_org=gotchu.tenant_id() AND m.organization_id=p_org AND m.application_id=p_app AND m.repository_key=p_key AND m.enabled
    AND l.source='github_app' AND NOT l.revoked AND l.read_access='granted' AND g.state='active'
$$;
REVOKE ALL ON FUNCTION gotchu.monitor_github_repository(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.monitor_github_repository(uuid,uuid,text) TO gotchu_coordinator;
