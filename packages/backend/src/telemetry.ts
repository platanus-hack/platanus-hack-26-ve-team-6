import { randomBytes, randomUUID } from 'node:crypto';
import { telemetryConnectionSchema, telemetryDisableSchema, telemetryIntegrationSchema, customerScopeSchema } from '@gotchu/contracts';
import { audit, authorize, BackendError, parse, type BaseDependencies, type CredentialStore, type Identity } from './core.js';

export interface WritableEventCredentials extends CredentialStore {
  /** Create exclusively; a rejected write must clean up its own partial file. */
  putSigningSecret(reference: string, secret: Uint8Array): Promise<void>;
  deleteSigningSecret(reference: string): Promise<void>;
}
export function createTelemetryService(deps: BaseDependencies & { eventCredentials?: WritableEventCredentials }) {
  return {
    async list(identity: Identity, input: { organizationId: string; applicationId: string }) {
      const scope = parse(customerScopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity);
        const rows = await tx.query<{ id: string; status: string; last_event_at: Date | null }>(
          "SELECT id,status,last_event_at FROM gotchu.integrations WHERE organization_id=$1 AND application_id=$2 AND kind='signed_events' ORDER BY created_at DESC,id LIMIT 20", [scope.organizationId, scope.applicationId]);
        return rows.rows.map(row => parse(telemetryIntegrationSchema, { ...scope, id: row.id, status: row.status, lastEventAt: row.last_event_at?.toISOString() ?? null }));
      });
    },
    async connect(identity: Identity, input: { organizationId: string; applicationId: string }) {
      const scope = parse(customerScopeSchema, input);
      const store = deps.eventCredentials;
      if (!store) throw new BackendError('event_credentials_unavailable', 'Event signing credential storage is not configured', 503);
      const id = randomUUID(); const reference = `local-event:${id}`; const secret = randomBytes(32);
      let stored = false;
      try {
        return await deps.database.tenant(scope.organizationId, async tx => {
          await authorize(tx, scope.organizationId, identity, ['owner', 'operator']);
          const result = await tx.query<{ connected: boolean }>('SELECT gotchu.customer_connect_events($1,$2,$3,$4,$5) AS connected', [scope.organizationId, scope.applicationId, identity.userId, id, reference]);
          if (!result.rows[0]?.connected) throw new BackendError('forbidden', 'Application membership or state does not permit event setup', 403);
          await store.putSigningSecret(reference, secret);
          stored = true;
          await audit(tx, scope.organizationId, identity.userId, 'events.connected', id);
          return parse(telemetryConnectionSchema, { integration: { ...scope, id, status: 'active', lastEventAt: null }, signingKey: secret.toString('base64') });
        });
      } catch (cause) {
        try { if (stored) await store.deleteSigningSecret(reference); }
        catch (cleanup) { throw new BackendError('credential_cleanup_required', 'Event setup failed and credential cleanup needs operator review', 503, { cause: new AggregateError([cause, cleanup]) }); }
        if (cause instanceof Error && cause.message === 'event_integration_limit') throw new BackendError('event_integration_limit', 'Workspace daily event-key rotation limit reached', 429);
        throw cause;
      }
    },
    async disable(identity: Identity, input: { organizationId: string; applicationId: string; integrationId: string }) {
      const value = parse(telemetryDisableSchema, input);
      await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator']);
        const result = await tx.query<{ disabled: boolean }>('SELECT gotchu.customer_disable_events($1,$2,$3,$4) AS disabled', [value.organizationId, value.applicationId, identity.userId, value.integrationId]);
        if (!result.rows[0]?.disabled) throw new BackendError('not_found', 'Event integration not found', 404);
        await audit(tx, value.organizationId, identity.userId, 'events.disabled', value.integrationId);
      });
    },
  };
}
