import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Transaction } from '@gotchu/database';
import {
  customerScopeSchema, runtimeAttackEventAttributesSchema, runtimeAttackKindSchema,
  runtimeProtectionConfigSchema, runtimeProtectionDetectionSchema, runtimeProtectionPolicySchema,
  runtimeProtectionUpdateSchema, type RuntimeProtectionPolicy,
} from '@gotchu/contracts';
import { audit, authorize, BackendError, canonicalJson, parse, systemClock, type BaseDependencies, type CredentialStore, type Identity } from './core.js';

const defaultDetectors = runtimeAttackKindSchema.options;
const policyDurationMs = 30_000;
const policySignature = (secret: Uint8Array, policy: RuntimeProtectionPolicy) => createHmac('sha256', secret).update(`gotchu-runtime-policy-v1\n${canonicalJson(policy)}`).digest('hex');
const requestSignature = (secret: Uint8Array, integrationId: string, timestamp: string) => createHmac('sha256', secret).update(`gotchu-protection-policy-request-v1\n${integrationId}\n${timestamp}\n`).digest();

type Scope = { organizationId: string; applicationId: string };
async function readConfig(tx: Transaction, scope: Scope) {
  const [configured, health] = await Promise.all([
    tx.query<{ mode: string; enabled_detectors: string[]; version: number }>('SELECT mode,enabled_detectors,version FROM gotchu.runtime_protection_configs WHERE organization_id=$1 AND application_id=$2', [scope.organizationId, scope.applicationId]),
    tx.query<{ last_event_at: Date | null; receiving: boolean }>(`SELECT max(received_at) AS last_event_at,
      coalesce(bool_or(received_at > clock_timestamp()-interval '2 minutes'),false) AS receiving
      FROM gotchu.runtime_protection_events WHERE organization_id=$1 AND application_id=$2`, [scope.organizationId, scope.applicationId]),
  ]);
  const row = configured.rows[0]; const current = health.rows[0];
  return runtimeProtectionConfigSchema.parse({
    ...scope,
    mode: row?.mode ?? 'monitor',
    enabledDetectors: row?.enabled_detectors ?? defaultDetectors,
    version: row?.version ?? 0,
    receiving: current?.receiving ?? false,
    lastEventAt: current?.last_event_at?.toISOString() ?? null,
  });
}

export function createProtectionService(deps: BaseDependencies & { credentials?: CredentialStore }) {
  const clock = deps.clock ?? systemClock;
  return {
    async get(identity: Identity, input: Scope) {
      const scope = parse(customerScopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity);
        return readConfig(tx, scope);
      });
    },
    async update(identity: Identity, input: unknown) {
      const value = parse(runtimeProtectionUpdateSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator']);
        await tx.query('SELECT gotchu.lock_customer_organization($1)', [value.organizationId]);
        const application = await tx.query<{ body: unknown }>('SELECT gotchu.lock_customer_application($1,$2) AS body', [value.organizationId, value.applicationId]);
        const state = application.rows[0]?.body;
        if (!state) throw new BackendError('not_found', 'Application not found', 404);
        const parsedState = parse(z.object({ archived: z.boolean() }), state);
        if (parsedState.archived) throw new BackendError('application_archived', 'Restore this application before changing protection', 409);
        await tx.query(`INSERT INTO gotchu.runtime_protection_configs(organization_id,application_id,mode,enabled_detectors,version,updated_by)
          VALUES($1,$2,$3,$4,1,$5)
          ON CONFLICT(organization_id,application_id) DO UPDATE SET mode=EXCLUDED.mode,enabled_detectors=EXCLUDED.enabled_detectors,
            version=runtime_protection_configs.version+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
        [value.organizationId, value.applicationId, value.mode, value.enabledDetectors, identity.userId]);
        await audit(tx, value.organizationId, identity.userId, 'runtime_protection.configured', value.applicationId, { mode: value.mode, enabledDetectors: value.enabledDetectors });
        return readConfig(tx, value);
      });
    },
    async listDetections(identity: Identity, input: Scope) {
      const scope = parse(customerScopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity);
        const rows = await tx.query<{ event_id: string; attack_kind: string; sink: string; route: string; evidence: string; outcome: string; occurred_at: Date; received_at: Date }>(`SELECT event_id,attack_kind,sink,route,evidence,outcome,occurred_at,received_at
          FROM gotchu.runtime_protection_events WHERE organization_id=$1 AND application_id=$2 AND kind='attack'
            AND received_at>clock_timestamp()-interval '30 days'
          ORDER BY received_at DESC,event_id LIMIT 100`, [scope.organizationId, scope.applicationId]);
        return rows.rows.flatMap(row => {
          const kind = runtimeAttackKindSchema.safeParse(row.attack_kind);
          const evidence = runtimeAttackEventAttributesSchema.shape.evidence.safeParse(row.evidence);
          if (!kind.success || !evidence.success) return [];
          return [runtimeProtectionDetectionSchema.parse({ id: row.event_id, kind: kind.data, sink: row.sink,
            route: row.route, evidence: evidence.data, outcome: row.outcome,
            occurredAt: row.occurred_at.toISOString(), receivedAt: row.received_at.toISOString() })];
        });
      });
    },
    async signedPolicy(input: { integrationId: string; timestamp: string; requestSignature: string }) {
      const credentials = deps.credentials;
      if (!credentials || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.integrationId)
        || !/^[1-9][0-9]{9,11}$/.test(input.timestamp) || Math.abs(clock.now().getTime() / 1000 - Number(input.timestamp)) > 300
        || !/^[a-f0-9]{64}$/.test(input.requestSignature)) throw new BackendError('invalid_signature', 'Policy authentication failed', 401);
      return deps.database.integration(input.integrationId, async tx => {
        const result = await tx.query<{ organization_id: string; application_id: string; credential_ref: string }>(`SELECT i.organization_id,i.application_id,c.credential_ref
          FROM gotchu.integrations i JOIN gotchu.integration_credentials c ON c.organization_id=i.organization_id AND c.integration_id=i.id
          WHERE i.id=$1 AND i.status='active' AND i.kind='signed_events'`, [input.integrationId]);
        const integration = result.rows[0];
        if (!integration) throw new BackendError('invalid_signature', 'Policy authentication failed', 401);
        let secret: Uint8Array;
        try { secret = await credentials.getSigningSecret(integration.credential_ref); }
        catch (cause) { throw new BackendError('credential_unavailable', 'Integration signing credential is unavailable', 503, { cause }); }
        if (secret.byteLength < 32) throw new BackendError('credential_unavailable', 'Integration signing credential is unavailable', 503);
        const expected = requestSignature(secret, input.integrationId, input.timestamp);
        const supplied = Buffer.from(input.requestSignature, 'hex');
        if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) throw new BackendError('invalid_signature', 'Policy authentication failed', 401);
        await tx.query("SELECT set_config('gotchu.organization_id',$1,true)", [integration.organization_id]);
        const config = await tx.query<{ mode: 'monitor' | 'block'; enabled_detectors: string[] }>('SELECT mode,enabled_detectors FROM gotchu.runtime_protection_configs WHERE organization_id=$1 AND application_id=$2', [integration.organization_id, integration.application_id]);
        const row = config.rows[0]; const now = clock.now();
        const policy = runtimeProtectionPolicySchema.parse({ applicationId: integration.application_id,
          mode: row?.mode ?? 'monitor', enabledDetectors: row?.enabled_detectors ?? defaultDetectors,
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + policyDurationMs).toISOString() });
        return { policy, signature: policySignature(secret, policy) };
      });
    },
  };
}
