CREATE TABLE gotchu.runtime_protection_configs (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('monitor','block')),
  enabled_detectors text[] NOT NULL CHECK (cardinality(enabled_detectors) <= 4),
  version integer NOT NULL CHECK (version > 0),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, application_id),
  FOREIGN KEY (organization_id, application_id) REFERENCES gotchu.applications(organization_id, id),
  CHECK (enabled_detectors <@ ARRAY['sql_injection','path_traversal','command_injection','ssrf']::text[])
);

ALTER TABLE gotchu.runtime_protection_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.runtime_protection_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.runtime_protection_configs
  USING (organization_id = gotchu.tenant_id())
  WITH CHECK (organization_id = gotchu.tenant_id());
REVOKE ALL ON gotchu.runtime_protection_configs FROM PUBLIC;
GRANT SELECT ON gotchu.runtime_protection_configs TO gotchu_api, gotchu_ingest;
GRANT INSERT, UPDATE ON gotchu.runtime_protection_configs TO gotchu_api;

CREATE TABLE gotchu.runtime_protection_events (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  event_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('attack','heartbeat')),
  attack_kind text,
  sink text,
  route text,
  evidence text,
  outcome text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, integration_id, event_id),
  FOREIGN KEY (organization_id, application_id, integration_id) REFERENCES gotchu.integrations(organization_id, application_id, id),
  FOREIGN KEY (organization_id, integration_id, event_id) REFERENCES gotchu.events(organization_id, integration_id, id),
  CHECK (
    (kind='attack' AND attack_kind IN ('sql_injection','path_traversal','command_injection','ssrf')
      AND sink IN ('sql','filesystem','child_process','fetch','http') AND route IS NOT NULL
      AND evidence IS NOT NULL AND outcome IN ('blocked','unknown'))
    OR (kind='heartbeat' AND attack_kind IS NULL AND sink IS NULL AND route IS NULL AND evidence IS NULL AND outcome IS NULL)
  )
);

ALTER TABLE gotchu.runtime_protection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.runtime_protection_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.runtime_protection_events
  USING (organization_id = gotchu.tenant_id())
  WITH CHECK (organization_id = gotchu.tenant_id());
REVOKE ALL ON gotchu.runtime_protection_events FROM PUBLIC;
GRANT SELECT ON gotchu.runtime_protection_events TO gotchu_api;
GRANT INSERT ON gotchu.runtime_protection_events TO gotchu_ingest;
CREATE INDEX runtime_protection_events_recent
  ON gotchu.runtime_protection_events(organization_id, application_id, received_at DESC);
