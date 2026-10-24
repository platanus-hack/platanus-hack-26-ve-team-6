CREATE TABLE gotchu.coordinator_heartbeats (
  coordinator_id text PRIMARY KEY CHECK (length(coordinator_id) BETWEEN 1 AND 128),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE gotchu.monitoring_liveness (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('unknown', 'healthy', 'late', 'stopped')),
  reason text CHECK (length(reason) <= 500),
  since timestamptz,
  last_scheduler_heartbeat_at timestamptz,
  last_check_heartbeat_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures BETWEEN 0 AND 1000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, application_id),
  FOREIGN KEY (organization_id, application_id) REFERENCES gotchu.applications(organization_id, id),
  CHECK ((state IN ('late', 'stopped') AND since IS NOT NULL AND reason IS NOT NULL) OR state IN ('unknown', 'healthy'))
);

CREATE TABLE gotchu.notification_channels (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('email', 'webhook')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  destination jsonb NOT NULL CHECK (octet_length(destination::text) <= 4096),
  secret_ref text CHECK (secret_ref IS NULL OR length(secret_ref) BETWEEN 1 AND 256),
  minimum_severity text NOT NULL DEFAULT 'medium' CHECK (minimum_severity IN ('info', 'low', 'medium', 'high', 'critical')),
  state text NOT NULL CHECK (state IN ('active', 'disabled')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES gotchu.organizations(id),
  CHECK ((kind = 'webhook' AND secret_ref IS NOT NULL) OR (kind = 'email' AND secret_ref IS NULL)),
  CHECK ((kind = 'webhook' AND destination->>'kind' = 'webhook' AND destination ? 'url')
      OR (kind = 'email' AND destination->>'kind' = 'email' AND destination ? 'email'))
);
CREATE INDEX notification_channels_active ON gotchu.notification_channels(organization_id, created_at) WHERE state = 'active';

CREATE TABLE gotchu.notification_events (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  application_id uuid NOT NULL,
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 256),
  event_kind text NOT NULL CHECK (event_kind IN ('monitoring_stopped', 'monitoring_recovered', 'finding', 'runtime_alert', 'test')),
  severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, event_key),
  FOREIGN KEY (organization_id, application_id) REFERENCES gotchu.applications(organization_id, id)
);
CREATE INDEX notification_events_recent ON gotchu.notification_events(organization_id, created_at DESC);

CREATE TABLE gotchu.notification_deliveries (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  event_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  state text NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text CHECK (length(last_error) <= 120),
  provider_accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, channel_id, idempotency_key),
  FOREIGN KEY (organization_id, event_id) REFERENCES gotchu.notification_events(organization_id, id),
  FOREIGN KEY (organization_id, channel_id) REFERENCES gotchu.notification_channels(organization_id, id),
  CHECK ((state = 'sending' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
      OR (state <> 'sending' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK ((state = 'sent') = (provider_accepted_at IS NOT NULL))
);
CREATE INDEX notification_deliveries_event ON gotchu.notification_deliveries(organization_id, event_id, created_at);
CREATE INDEX notification_deliveries_due ON gotchu.notification_deliveries(organization_id, next_attempt_at, created_at) WHERE state = 'queued';

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['monitoring_liveness', 'notification_channels', 'notification_events', 'notification_deliveries'] LOOP
    EXECUTE format('ALTER TABLE gotchu.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE gotchu.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_scope ON gotchu.%I USING (organization_id = gotchu.tenant_id()) WITH CHECK (organization_id = gotchu.tenant_id())', t);
    EXECUTE format('REVOKE ALL ON gotchu.%I FROM PUBLIC', t);
  END LOOP;
END $$;

CREATE POLICY coordinator_heartbeat_runtime ON gotchu.coordinator_heartbeats TO gotchu_coordinator USING (true) WITH CHECK (true);
ALTER TABLE gotchu.coordinator_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.coordinator_heartbeats FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gotchu.coordinator_heartbeats FROM PUBLIC;

GRANT SELECT ON gotchu.monitoring_liveness TO gotchu_api, gotchu_coordinator;
GRANT INSERT (organization_id, application_id, state, reason, since) ON gotchu.monitoring_liveness TO gotchu_api;
GRANT UPDATE (state, reason, since, updated_at) ON gotchu.monitoring_liveness TO gotchu_api;
GRANT INSERT, UPDATE ON gotchu.monitoring_liveness TO gotchu_coordinator;
GRANT SELECT (organization_id, id, kind, label, destination, minimum_severity, state, created_at, updated_at) ON gotchu.notification_channels TO gotchu_api;
GRANT SELECT ON gotchu.notification_channels TO gotchu_coordinator;
GRANT INSERT (organization_id, id, kind, label, destination, secret_ref, minimum_severity, state, created_by) ON gotchu.notification_channels TO gotchu_api;
GRANT UPDATE (state, updated_at) ON gotchu.notification_channels TO gotchu_api;
GRANT INSERT, UPDATE ON gotchu.notification_channels TO gotchu_coordinator;
GRANT SELECT, INSERT ON gotchu.notification_events TO gotchu_api, gotchu_coordinator;
GRANT SELECT ON gotchu.notification_deliveries TO gotchu_api, gotchu_coordinator;
GRANT INSERT ON gotchu.notification_deliveries TO gotchu_api;
GRANT INSERT, UPDATE ON gotchu.notification_deliveries TO gotchu_coordinator;
GRANT UPDATE (state, last_error, updated_at) ON gotchu.notification_deliveries TO gotchu_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON gotchu.coordinator_heartbeats TO gotchu_coordinator;

CREATE FUNCTION gotchu.notification_heartbeat_age_seconds() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT CASE WHEN count(*) = 0 THEN NULL ELSE greatest(0, floor(extract(epoch FROM clock_timestamp() - max(heartbeat_at)))::integer) END
  FROM gotchu.coordinator_heartbeats
$$;
REVOKE ALL ON FUNCTION gotchu.notification_heartbeat_age_seconds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.notification_heartbeat_age_seconds() TO gotchu_coordinator;

-- The coordinator job remains the wake-up mechanism; Postgres notification rows are the source of truth.
ALTER POLICY customer_pending_discovery ON gotchu.jobs TO gotchu_owner
  USING (current_setting('gotchu.pending_discovery', true) = 'enabled' AND state IN ('queued', 'running')
    AND ((kind = 'audit' AND payload->>'version' = '2') OR kind IN ('events.aggregate', 'investigation')
      OR (kind = 'notification' AND payload->>'kind' IN ('assessment_observation', 'triage_evaluation', 'alert_delivery'))));
CREATE OR REPLACE FUNCTION gotchu.customer_pending_organizations(p_limit integer DEFAULT 100) RETURNS TABLE(organization_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF gotchu.tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_customer_discovery';
  END IF;
  PERFORM set_config('gotchu.pending_discovery', 'enabled', true);
  PERFORM set_config('gotchu.operation_discovery', 'enabled', true);
  RETURN QUERY SELECT discovered.organization_id FROM (
    SELECT j.organization_id, min(j.created_at) AS first_seen FROM gotchu.jobs j WHERE j.state IN ('queued', 'running')
      AND ((j.kind = 'audit' AND j.payload->>'version' = '2') OR j.kind IN ('events.aggregate', 'investigation')
        OR (j.kind = 'notification' AND j.payload->>'kind' IN ('assessment_observation', 'triage_evaluation', 'alert_delivery')))
      GROUP BY j.organization_id
    UNION
    SELECT m.organization_id, m.updated_at AS first_seen FROM gotchu.operation_monitors m WHERE m.enabled
  ) discovered GROUP BY discovered.organization_id ORDER BY min(discovered.first_seen), discovered.organization_id LIMIT p_limit;
  PERFORM set_config('gotchu.pending_discovery', '', true);
  PERFORM set_config('gotchu.operation_discovery', '', true);
END $$;
REVOKE ALL ON FUNCTION gotchu.notification_heartbeat_age_seconds() FROM PUBLIC;
