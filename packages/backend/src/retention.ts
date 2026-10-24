import { z } from 'zod';
import { workspaceRetentionPolicyInputSchema, workspaceRetentionPolicySchema, type WorkspaceRetentionPolicy } from '@gotchu/contracts';
import type { Database } from '@gotchu/database';
import { audit, authorize, BackendError, parse, type Identity } from './core.js';

const systemOrganizationId = '00000000-0000-0000-0000-000000000000';
const coordinatorClaimSchema = z.object({
  organization_id: z.uuid(), application_id: z.uuid(), job_id: z.uuid(), lease_token: z.uuid(),
}).strict();
const purgeResultSchema = z.object({
  sourceSnapshots: z.number().int().nonnegative(), containerImages: z.number().int().nonnegative(),
  reports: z.number().int().nonnegative(), observations: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(), notificationDeliveries: z.number().int().nonnegative(),
  protectionEvents: z.number().int().nonnegative(), proposalsInvalidated: z.number().int().nonnegative(),
}).strict();
const quotaTrimResultSchema = z.object({
  runsTrimmed: z.number().int().nonnegative(), observationsTrimmed: z.number().int().nonnegative(), plansTrimmed: z.number().int().nonnegative(),
}).strict();
export type RetentionPurgeClaim = z.infer<typeof coordinatorClaimSchema>;

export function createRetentionService(database: Database) {
  function requireRole(role: Database['role'], expected: Database['role']): void {
    if (role !== expected) throw new BackendError('forbidden', 'This retention operation is not available to this service role', 403);
  }
  return {
    async getPolicy(identity: Identity, input: { organizationId: string }): Promise<WorkspaceRetentionPolicy> {
      requireRole(database.role, 'gotchu_api');
      const scope = parse(z.object({ organizationId: z.uuid() }).strict(), { organizationId: input.organizationId });
      return database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity);
        const result = await tx.query<{ source_snapshot_days: number; container_image_days: number; report_days: number; observation_days: number; run_days: number; notification_delivery_days: number; protection_event_days: number; updated_at: Date }>(
          `SELECT source_snapshot_days,container_image_days,report_days,observation_days,run_days,notification_delivery_days,protection_event_days,updated_at
           FROM gotchu.workspace_retention_policies WHERE organization_id=$1`, [scope.organizationId]);
        const row = result.rows[0];
        if (!row) throw new BackendError('not_found', 'Workspace retention policy not found', 404);
        return workspaceRetentionPolicySchema.parse({
          organizationId: scope.organizationId, sourceSnapshotDays: row.source_snapshot_days, containerImageDays: row.container_image_days,
          reportDays: row.report_days, observationDays: row.observation_days, runDays: row.run_days,
          notificationDeliveryDays: row.notification_delivery_days, protectionEventDays: row.protection_event_days,
          updatedAt: row.updated_at.toISOString(),
        });
      });
    },
    async updatePolicy(identity: Identity, input: { organizationId: string } & z.infer<typeof workspaceRetentionPolicyInputSchema>): Promise<WorkspaceRetentionPolicy> {
      requireRole(database.role, 'gotchu_api');
      const scope = parse(z.object({ organizationId: z.uuid() }).strict(), { organizationId: input.organizationId });
      const policy = parse(workspaceRetentionPolicyInputSchema, {
        sourceSnapshotDays: input.sourceSnapshotDays, containerImageDays: input.containerImageDays,
        reportDays: input.reportDays, observationDays: input.observationDays, runDays: input.runDays,
        notificationDeliveryDays: input.notificationDeliveryDays, protectionEventDays: input.protectionEventDays,
      });
      return database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity, ['owner']);
        const result = await tx.query<{ updated_at: Date }>(`INSERT INTO gotchu.workspace_retention_policies(organization_id,source_snapshot_days,container_image_days,report_days,observation_days,run_days,notification_delivery_days,protection_event_days,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT(organization_id) DO UPDATE SET source_snapshot_days=EXCLUDED.source_snapshot_days,container_image_days=EXCLUDED.container_image_days,
            report_days=EXCLUDED.report_days,observation_days=EXCLUDED.observation_days,run_days=EXCLUDED.run_days,
            notification_delivery_days=EXCLUDED.notification_delivery_days,protection_event_days=EXCLUDED.protection_event_days,
            updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
          RETURNING updated_at`, [scope.organizationId,policy.sourceSnapshotDays,policy.containerImageDays,policy.reportDays,policy.observationDays,
          policy.runDays,policy.notificationDeliveryDays,policy.protectionEventDays,identity.userId]);
        const updatedAt = result.rows[0]?.updated_at;
        if (!updatedAt) throw new Error('Updated retention policy disappeared');
        await audit(tx, scope.organizationId, identity.userId, 'retention.policy_updated', scope.organizationId, policy);
        return workspaceRetentionPolicySchema.parse({ organizationId: scope.organizationId, ...policy, updatedAt: updatedAt.toISOString() });
      });
    },
    async claimDue(input: { limit?: number; leaseMs?: number; organizationId?: string } = {}): Promise<RetentionPurgeClaim[]> {
      requireRole(database.role, 'gotchu_coordinator');
      const value = parse(z.object({ limit: z.number().int().min(1).max(50).default(10), leaseMs: z.number().int().min(1000).max(300000).default(300000), organizationId: z.uuid().optional() }).strict(), input);
      return database.tenant(systemOrganizationId, async tx => {
        const result = await tx.query('SELECT * FROM gotchu.retention_claim_due($1,$2,$3)', [value.limit,value.leaseMs,value.organizationId ?? null]);
        return z.array(coordinatorClaimSchema).max(50).parse(result.rows);
      });
    },
    async purge(claimInput: RetentionPurgeClaim): Promise<z.infer<typeof purgeResultSchema> & z.infer<typeof quotaTrimResultSchema>> {
      requireRole(database.role, 'gotchu_coordinator');
      const claim = parse(coordinatorClaimSchema, claimInput);
      return database.tenant(claim.organization_id, async tx => {
        const result = await tx.query<{ retention_purge: unknown }>('SELECT gotchu.retention_purge($1,$2,$3,$4) AS retention_purge',
          [claim.organization_id,claim.application_id,claim.job_id,claim.lease_token]);
        const quota = await tx.query<{ quota_trim: unknown }>('SELECT gotchu.retention_trim_monitoring($1,$2,$3) AS quota_trim',
          [claim.organization_id,claim.application_id,claim.job_id]);
        return { ...purgeResultSchema.parse(result.rows[0]?.retention_purge), ...quotaTrimResultSchema.parse(quota.rows[0]?.quota_trim) };
      });
    },
  };
}
