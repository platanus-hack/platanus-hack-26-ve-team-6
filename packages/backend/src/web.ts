import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, authorize, BackendError, parse, scopedIdSchema, systemClock, type BaseDependencies, type Identity, type MembershipRole } from './core.js';
import { enqueue } from './jobs.js';
const orgSchema = z.object({ organizationId: z.uuid() }).strict();
export function createWebService(deps: BaseDependencies) {
  const clock = deps.clock ?? systemClock;
  return {
    async authorize(identity: Identity, organizationId: string, roles?: readonly MembershipRole[]) {
      return deps.database.tenant(parse(z.uuid(), organizationId), tx => authorize(tx, organizationId, identity, roles));
    },
    async listApplications(identity: Identity, input: { organizationId: string }) {
      const value = parse(orgSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity);
        return (await tx.query<{ id: string; name: string }>('SELECT id,name FROM gotchu.applications WHERE organization_id=$1 ORDER BY created_at,id LIMIT 100', [value.organizationId])).rows;
      });
    },
    async queueAudit(identity: Identity, input: { organizationId: string; applicationId: string; idempotencyKey: string }): Promise<{ jobId: string }> {
      const value = parse(scopedIdSchema.extend({ idempotencyKey: z.string().min(1).max(200) }), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator']);
        const app = await tx.query('SELECT id FROM gotchu.applications WHERE organization_id=$1 AND id=$2', [value.organizationId, value.applicationId]);
        if (!app.rowCount) throw new BackendError('not_found', 'Application not found', 404);
        const jobId = await enqueue(tx, { ...value, id: randomUUID(), kind: 'audit', payload: { requestedBy: identity.userId } });
        await audit(tx, value.organizationId, identity.userId, 'audit.queued', jobId);
        return { jobId };
      });
    },
    async getJob(identity: Identity, input: { organizationId: string; jobId: string }) {
      const value = parse(z.object({ organizationId: z.uuid(), jobId: z.uuid() }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query<{ id: string; applicationId: string; kind: string; state: string; attempts: number; createdAt: Date; completedAt: Date | null; outcome: string | null; reasonCode: string | null; reportId: string | null }>('SELECT id,application_id AS "applicationId",kind,state,attempts,created_at AS "createdAt",completed_at AS "completedAt",result->>\'status\' AS outcome,result->>\'reasonCode\' AS "reasonCode",result->>\'reportId\' AS "reportId" FROM gotchu.jobs WHERE organization_id=$1 AND id=$2', [value.organizationId, value.jobId]);
        await authorize(tx, value.organizationId, identity, undefined, result.rows[0]?.applicationId);
        if (!result.rows[0]) throw new BackendError('not_found', 'Job not found', 404);
        return result.rows[0];
      });
    },
    async listIncidents(identity: Identity, input: { organizationId: string; applicationId: string }) {
      const value = parse(scopedIdSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity);
        return (await tx.query<{ id: string; ruleId: string; summary: string; severity: string; status: string; createdAt: Date }>('SELECT id,rule_id AS "ruleId",summary,severity,status,created_at AS "createdAt" FROM gotchu.incidents WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at DESC,id LIMIT 100', [value.organizationId, value.applicationId])).rows;
      });
    },
    async getCoverage(identity: Identity, input: { organizationId: string; applicationId: string }) {
      const value = parse(scopedIdSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity);
        const app = await tx.query('SELECT id FROM gotchu.applications WHERE organization_id=$1 AND id=$2', [value.organizationId, value.applicationId]);
        if (!app.rowCount) throw new BackendError('not_found', 'Application not found', 404);
        const rows = await tx.query<{ capability: string; state: string; reason: string; checkedAt: Date }>('SELECT capability,state,reason,checked_at AS "checkedAt" FROM gotchu.coverage WHERE organization_id=$1 AND application_id=$2', [value.organizationId, value.applicationId]);
        const integrations = await tx.query<{ last_event_at: Date | null }>("SELECT last_event_at FROM gotchu.integrations WHERE organization_id=$1 AND application_id=$2 AND kind='signed_events' AND status='active' ORDER BY last_event_at DESC NULLS LAST LIMIT 1", [value.organizationId, value.applicationId]);
        const received = integrations.rows[0]?.last_event_at;
        const runtime = received ? (clock.now().getTime() - received.getTime() < 300_000 ? 'active' : 'stale') : 'not_configured';
        const defaults = ['repository_scan', 'aws_inventory', 'cloudflare', 'response_readiness', 'customer_code_execution'];
        const result = rows.rows.filter(row => row.capability !== 'runtime_events');
        for (const capability of defaults) if (!result.some(row => row.capability === capability)) result.push({ capability, state: capability === 'customer_code_execution' ? 'unsupported' : 'not_configured', reason: capability === 'customer_code_execution' ? 'VM-class isolation has not been demonstrated' : 'No verified coverage is recorded', checkedAt: clock.now() });
        result.push({ capability: 'runtime_events', state: runtime, reason: received ? 'Based on authenticated event receipt; does not establish response readiness' : 'No authenticated events received', checkedAt: received ?? clock.now() });
        return result;
      });
    },
    async listProposals(identity: Identity, input: { organizationId: string; applicationId: string }) {
      const value = parse(scopedIdSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity);
        return (await tx.query<{ id: string; actionHash: string; proposal: unknown; createdAt: Date }>('SELECT id,action_hash AS "actionHash",body AS proposal,created_at AS "createdAt" FROM gotchu.proposals WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at DESC,id LIMIT 100', [value.organizationId, value.applicationId])).rows;
      });
    },
  };
}
