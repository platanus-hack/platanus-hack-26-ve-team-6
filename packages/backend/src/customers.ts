import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CUSTOMER_MAX_REPORT_BYTES, CUSTOMER_MAX_SOURCE_BYTES, CUSTOMER_MAX_CONTAINER_IMAGE_BYTES,
  customerApplicationSchema, customerAssessmentIntentSchema, customerAssessmentReportSchema, customerClaimSchema,
  customerCreateApplicationSchema, customerCreateWorkspaceSchema, customerUpdateWorkspaceSchema, customerDeleteSourceSchema, customerEnrollTargetSchema,
  customerContainerImageSummarySchema, customerContainerImageUploadMetadataSchema,
  customerPendingOrganizationsSchema, customerQueueSchema, customerReportSummarySchema, customerRunInputSchema, customerScopeSchema,
  customerSourceSnapshotSchema, customerSourceSummarySchema, customerTargetIdSchema, customerTargetSchema,
  customerUpdateApplicationSchema, customerUploadSourceSchema, customerWorkspaceSchema, defaultLicensePolicy,
  licensePolicySchema, workspaceLicensePolicySchema, githubCapturedSourceInputSchema,
  type CustomerApplication, type CustomerAssessmentIntent, type CustomerAssessmentReport, type CustomerClaim, type CustomerEnrollment,
  type CustomerQueueInput, type CustomerRunInput, type CustomerSourceSummary, type CustomerTarget,
  type CustomerContainerImageSummary, type LicensePolicy,
  type DependencyArtifactAnalysis, type CustomerScanProfile,
} from '@gotchu/contracts';
import { evaluateLicensePolicy, normalizeLicenseExpression, normalizeLicensePolicy } from '@gotchu/customer-assessment/supply-chain';
import { buildCycloneDx } from '@gotchu/customer-assessment/sbom';
import type { Transaction } from '@gotchu/database';
import { audit, authorize, BackendError, canonicalJson, identitySchema, parse, sha256, type BaseDependencies, type Identity } from './core.js';
import { DEMO_ASSESSMENT_SCOPE } from './demo.js';
import { completeJob, enqueue } from './jobs.js';
import { enqueueAutomaticSourceInvestigations } from './automatic-source-investigations.js';
import { loadSingleAppRepository } from './github-connections.js';

export type CustomerDependencies = BaseDependencies;
export const CUSTOMER_MAX_UNFINISHED = 3;
export const CUSTOMER_MAX_DAILY_RUNS = 20;
export const CUSTOMER_MAX_SOURCES = 10;
export const CUSTOMER_MAX_DAILY_SOURCES = 100;
export const CUSTOMER_MAX_CONTAINER_IMAGES = 10;
export const CUSTOMER_MAX_DAILY_CONTAINER_IMAGES = 100;
const discoveryTenant = '00000000-0000-0000-0000-000000000000';
const organizationSchema = customerScopeSchema.pick({ organizationId: true });
type Scope = z.infer<typeof customerScopeSchema>;
const writeRoles = ['owner', 'operator'] as const;
const capturedSourceProvenanceSchema = githubCapturedSourceInputSchema.omit({ sourceSnapshotId: true });
function principal(identity: Identity) {
  const value = parse(identitySchema, identity);
  if (value.userId === DEMO_ASSESSMENT_SCOPE.userId) throw new BackendError('forbidden', 'The demo principal cannot access customer workspaces', 403);
  return value;
}
async function lockOrganization(tx: Transaction, organizationId: string) {
  const result = await tx.query<{ exists: boolean }>('SELECT gotchu.lock_customer_organization($1) AS exists', [organizationId]);
  if (!result.rows[0]?.exists) throw new BackendError('not_found', 'Workspace not found', 404);
}
async function lockApplication(tx: Transaction, scope: Scope, allowArchived = false) {
  await lockOrganization(tx, scope.organizationId);
  const result = await tx.query<{ app: unknown }>('SELECT gotchu.lock_customer_application($1,$2) AS app', [scope.organizationId, scope.applicationId]);
  if (!result.rows[0]?.app) throw new BackendError('not_found', 'Application not found', 404);
  const app = parse(z.object({ name: z.string(), archived: z.boolean() }).strict(), result.rows[0].app);
  if (app.archived && !allowArchived) throw new BackendError('application_archived', 'Restore the application before changing or assessing it', 409);
  return app;
}
async function readApplication(tx: Transaction, scope: Scope): Promise<CustomerApplication> {
  const result = await tx.query<{ name: string; archived: boolean; created_at: Date }>('SELECT name,archived,created_at FROM gotchu.applications WHERE organization_id=$1 AND id=$2', [scope.organizationId, scope.applicationId]);
  const row = result.rows[0];
  if (!row) throw new BackendError('not_found', 'Application not found', 404);
  return parse(customerApplicationSchema, { organizationId: scope.organizationId, applicationId: scope.applicationId, name: row.name, archived: row.archived, createdAt: row.created_at.toISOString() });
}
type TargetRow = {
  id: string; origin: string; version: number; status: string; requested_by: string; requested_at: Date;
  authorized_at: Date | null; expires_at: Date | null; authorization_current: boolean;
  scan_profile: CustomerScanProfile;
};
async function targetRow(tx: Transaction, scope: Scope, targetId?: string): Promise<TargetRow | null> {
  const result = await tx.query<TargetRow>(`SELECT *,
    status='authorized' AND expires_at>clock_timestamp() AS authorization_current
    FROM gotchu.customer_targets WHERE organization_id=$1 AND application_id=$2 AND ($3::uuid IS NULL OR id=$3)`,
  [scope.organizationId, scope.applicationId, targetId ?? null]);
  return result.rows[0] ?? null;
}
function targetView(scope: Scope, row: TargetRow): CustomerTarget {
  return parse(customerTargetSchema, { organizationId: scope.organizationId, applicationId: scope.applicationId, id: row.id, origin: row.origin, version: row.version, status: row.status,
    requestedBy: row.requested_by, requestedAt: row.requested_at.toISOString(),
    authorizedAt: row.authorized_at?.toISOString() ?? null, expiresAt: row.expires_at?.toISOString() ?? null, scanProfile: row.scan_profile });
}
function requireTarget(row: TargetRow | null): TargetRow {
  if (!row) throw new BackendError('not_found', 'Target not found', 404);
  return row;
}
/** Caller holds lockApplication through the mutation, serializing with queue/getRequest. */
async function requireTargetIdle(tx: Transaction, scope: Scope, targetId: string) {
  // Neither an expired lease nor an uncertain runner failure proves that I/O stopped.
  const unfinished = await tx.query(`SELECT 1 FROM gotchu.customer_requests r
    JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.application_id=r.application_id AND j.id=r.job_id
    WHERE r.organization_id=$1 AND r.application_id=$2 AND r.target_id=$3
      AND (j.state IN ('queued','running') OR (j.state='failed' AND j.result->>'reasonCode'='assessment_reconciliation_required')) LIMIT 1`,
  [scope.organizationId, scope.applicationId, targetId]);
  if (unfinished.rowCount) throw new BackendError('target_assessment_in_progress', 'Target authorization remains active while assessments are outstanding; retry once they finish or an operator reconciles uncertain work.', 409);
}
async function checkJsonSize(tx: Transaction, serialized: string, limit: number) {
  const size = await tx.query<{ bytes: number }>('SELECT octet_length($1::jsonb::text) AS bytes', [serialized]);
  if (!size.rows[0] || size.rows[0].bytes > limit) throw new BackendError('payload_too_large', 'JSON exceeds the storage bound', 413);
}
function parseStoredIntent(value: unknown): CustomerAssessmentIntent {
  const legacy = z.object({ target: z.record(z.string(), z.unknown()).nullable() }).passthrough().safeParse(value);
  if (legacy.success && legacy.data.target && 'verifiedAt' in legacy.data.target && !('authorizedAt' in legacy.data.target)) {
    const { verifiedAt, ...target } = legacy.data.target;
    return parse(customerAssessmentIntentSchema, { ...legacy.data, target: { ...target, authorizedAt: verifiedAt } });
  }
  return parse(customerAssessmentIntentSchema, value);
}
async function loadIntent(tx: Transaction, scope: Scope & { jobId: string }): Promise<CustomerAssessmentIntent> {
  const result = await tx.query<{ input: unknown; payload: unknown; kind: string }>(`SELECT r.input,j.payload,j.kind
    FROM gotchu.customer_requests r JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.application_id=r.application_id AND j.id=r.job_id
    WHERE r.organization_id=$1 AND r.application_id=$2 AND r.job_id=$3`, [scope.organizationId, scope.applicationId, scope.jobId]);
  const row = result.rows[0];
  if (!row) throw new BackendError('customer_request_not_found', 'Customer assessment request not found', 409);
  const input = parseStoredIntent(row.input);
  const payload = parseStoredIntent(row.payload);
  if (row.kind !== 'audit' || canonicalJson(input) !== canonicalJson(payload)) throw new BackendError('assessment_scope_mismatch', 'Job payload differs from durable request', 409);
  return input;
}
async function currentRequest(tx: Transaction, claim: CustomerClaim): Promise<CustomerRunInput> {
  await lockApplication(tx, claim);
  const job = await tx.query(`SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND id=$3
    AND kind='audit' AND state='running' AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE`,
  [claim.organizationId, claim.applicationId, claim.jobId, claim.leaseToken]);
  if (!job.rowCount) throw new BackendError('stale_lease', 'Assessment requires the current scoped audit claim', 409);
  const intent = await loadIntent(tx, claim);
  let source: CustomerRunInput['source'] = null;
  if (intent.source) {
    const result = await tx.query<{ body: unknown }>('SELECT body FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND digest=$4 AND deleted_at IS NULL', [claim.organizationId, claim.applicationId, intent.source.id, intent.source.digest]);
    const row = result.rows[0];
    if (!row) throw new BackendError('source_unavailable', 'Source snapshot is no longer available', 409);
    const snapshot = parse(customerSourceSnapshotSchema, row.body);
    if (snapshot.revision !== intent.source.revision || sha256(canonicalJson(snapshot)) !== intent.source.digest) throw new BackendError('assessment_scope_mismatch', 'Stored source does not match the immutable intent', 409);
    source = { ...snapshot, ...intent.source };
  }
  let containerImage: CustomerRunInput['containerImage'] = intent.containerImage?.kind === 'registry' ? intent.containerImage : null;
  if (intent.containerImage?.kind === 'archive') {
    const result = await tx.query<{ body: Buffer | null; digest: string; size: number }>(`SELECT body,digest,size
      FROM gotchu.customer_container_images WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND deleted_at IS NULL`,
    [claim.organizationId, claim.applicationId, intent.containerImage.id]);
    const row = result.rows[0];
    if (!row?.body) throw new BackendError('container_image_unavailable', 'Container image archive is no longer available', 409);
    if (row.digest !== intent.containerImage.digest || row.size !== intent.containerImage.size
      || row.body.byteLength !== row.size || sha256(row.body) !== row.digest) {
      throw new BackendError('assessment_scope_mismatch', 'Stored container image differs from the immutable intent', 409);
    }
    containerImage = { ...intent.containerImage, archiveBase64: row.body.toString('base64') };
  }
  const input = parse(customerRunInputSchema, { ...intent, source, containerImage });
  if (input.target) {
    const target = await targetRow(tx, claim, input.target.id);
    if (!target?.authorization_current || target.version !== input.target.version || target.origin !== input.target.origin || target.scan_profile !== (input.target.scanProfile ?? 'root')
      || target.authorized_at?.toISOString() !== input.target.authorizedAt || target.expires_at?.toISOString() !== input.target.expiresAt) {
      throw new BackendError('assessment_target_changed', 'Target authorization expired, changed or was revoked', 409);
    }
  }
  return input;
}
async function currentLicensePolicy(tx: Transaction, organizationId: string) {
  const result = await tx.query<{ allow_licenses: string[]; deny_licenses: string[]; review_licenses: string[]; updated_at: Date }>(
    'SELECT allow_licenses,deny_licenses,review_licenses,updated_at FROM gotchu.customer_license_policies WHERE organization_id=$1', [organizationId]);
  const row = result.rows[0];
  if (!row) return parse(workspaceLicensePolicySchema, { organizationId, policy: defaultLicensePolicy, updatedAt: null, configured: false });
  return parse(workspaceLicensePolicySchema, { organizationId, policy: { allow: row.allow_licenses, deny: row.deny_licenses, review: row.review_licenses }, updatedAt: row.updated_at.toISOString(), configured: true });
}
function reportSubject(input: CustomerAssessmentIntent) {
  const image = input.containerImage;
  return { sourceSnapshotId: input.source?.id ?? null, sourceDigest: input.source?.digest ?? null,
    targetId: input.target?.id ?? null, targetVersion: input.target?.version ?? null, origin: input.target?.origin ?? null,
    containerImageId: image?.kind === 'archive' ? image.id : null,
    containerImageDigest: image?.digest ?? null,
    containerImageReference: image?.kind === 'registry' ? image.reference : null };
}

function containerImageSummary(scope: Scope, row: { id: string; digest: string; label: string; size: number; created_at: Date }): CustomerContainerImageSummary {
  return parse(customerContainerImageSummarySchema, { ...scope, id: row.id, digest: row.digest, label: row.label, size: row.size, createdAt: row.created_at.toISOString() });
}

export function createCustomerService(deps: CustomerDependencies) {
  async function storeSource(identity: Identity, input: z.input<typeof customerUploadSourceSchema>, capture?: z.infer<typeof capturedSourceProvenanceSchema>): Promise<CustomerSourceSummary> {
    const actor = principal(identity); const value = parse(customerUploadSourceSchema, input);
    const snapshot = { ...value.snapshot, files: [...value.snapshot.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    const serialized = canonicalJson(snapshot); const digest = sha256(serialized);
    if (capture && (capture.organizationId !== value.organizationId || capture.applicationId !== value.applicationId
      || capture.commitSha !== snapshot.revision || capture.digest !== digest)) {
      throw new BackendError('github_source_digest_mismatch', 'La fuente no coincide con la captura de GitHub.', 409);
    }
    const captureKey = capture ? sha256(canonicalJson(capture)) : '';
    return deps.database.tenant(value.organizationId, async tx => {
      await authorize(tx, value.organizationId, actor, writeRoles); await lockApplication(tx, value);
      if (capture) {
        const repository = await loadSingleAppRepository(tx, { organizationId: capture.organizationId,
          applicationId: capture.applicationId, repositoryLinkId: capture.repositoryLinkId }, capture.appId);
        if (repository.installationId !== capture.installationId || repository.repositoryId !== capture.repositoryId) {
          throw new BackendError('github_source_scope_mismatch', 'La captura no corresponde al repositorio autorizado.', 409);
        }
      }
      // Reuse old captures by their immutable binding, or an unbound retry by its
      // server-derived key. An ordinary upload cannot reserve capture provenance.
      const prior = capture
        ? await tx.query<{ id: string; created_at: Date }>(`SELECT s.id,s.created_at FROM gotchu.customer_sources s
            LEFT JOIN gotchu.customer_source_repository_bindings b
              ON b.organization_id=s.organization_id AND b.application_id=s.application_id AND b.source_id=s.id
            WHERE s.organization_id=$1 AND s.application_id=$2 AND s.digest=$3 AND s.deleted_at IS NULL
              AND ((s.capture_key=$4 AND b.source_id IS NULL) OR
                (b.repository_link_id=$5 AND b.app_id=$6 AND b.installation_id=$7 AND b.repository_id=$8
                  AND b.commit_sha=$9 AND b.tree_sha=$10 AND b.source_digest=$3))
            ORDER BY s.created_at,s.id LIMIT 1`, [value.organizationId, value.applicationId, digest, captureKey,
          capture.repositoryLinkId, capture.appId, capture.installationId, String(capture.repositoryId), capture.commitSha, capture.treeSha])
        : await tx.query<{ id: string; created_at: Date }>(`SELECT id,created_at FROM gotchu.customer_sources
            WHERE organization_id=$1 AND application_id=$2 AND digest=$3 AND deleted_at IS NULL
            ORDER BY created_at,id LIMIT 1`, [value.organizationId, value.applicationId, digest]);
      const existing = prior.rows[0];
      if (existing) return sourceSummary(value, existing.id, digest, snapshot, existing.created_at);
      const count = await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND deleted_at IS NULL', [value.organizationId, value.applicationId]);
      if ((count.rows[0]?.count ?? CUSTOMER_MAX_SOURCES) >= CUSTOMER_MAX_SOURCES) throw new BackendError('source_limit', 'Application snapshot limit reached', 429);
      const daily = await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM gotchu.customer_sources WHERE organization_id=$1 AND created_at>clock_timestamp()-interval '1 day'", [value.organizationId]);
      if ((daily.rows[0]?.count ?? CUSTOMER_MAX_DAILY_SOURCES) >= CUSTOMER_MAX_DAILY_SOURCES) throw new BackendError('source_daily_limit', 'Workspace daily snapshot admission limit reached', 429);
      await checkJsonSize(tx, serialized, CUSTOMER_MAX_SOURCE_BYTES);
      const id = randomUUID();
      const result = await tx.query<{ created_at: Date }>('INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor,capture_key) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING created_at', [value.organizationId, value.applicationId, id, digest, serialized, actor.userId, captureKey]);
      const row = result.rows[0]; if (!row) throw new Error('Source insert returned no row');
      await audit(tx, value.organizationId, actor.userId, 'source.uploaded', id, { digest });
      return sourceSummary(value, id, digest, snapshot, row.created_at);
    });
  }
  return {
    async pendingOrganizations(input: z.input<typeof customerPendingOrganizationsSchema> = {}): Promise<string[]> {
      if (deps.database.role !== 'gotchu_coordinator') throw new BackendError('forbidden', 'Pending organization discovery is coordinator-only', 403);
      const value = parse(customerPendingOrganizationsSchema, input);
      return deps.database.tenant(discoveryTenant, async tx => {
        const result = await tx.query<{ organization_id: unknown }>('SELECT organization_id FROM gotchu.customer_pending_organizations($1)', [value.limit]);
        return result.rows.map(row => parse(z.uuid(), row.organization_id));
      });
    },
    async listWorkspaces(identity: Identity) {
      const actor = principal(identity);
      return deps.database.tenant(discoveryTenant, async tx => {
        const result = await tx.query('SELECT * FROM gotchu.customer_workspaces($1)', [actor.userId]);
        return result.rows.map(row => parse(customerWorkspaceSchema, row));
      });
    },
    async createWorkspace(identity: Identity, input: z.input<typeof customerCreateWorkspaceSchema>) {
      const actor = principal(identity); const value = parse(customerCreateWorkspaceSchema, input);
      return deps.database.tenant(discoveryTenant, async tx => {
        const result = await tx.query<{ result: unknown }>('SELECT gotchu.customer_create_workspace($1,$2) AS result', [actor.userId, value.name]);
        const error = z.object({ error: z.enum(['workspace_limit', 'workspace_name_conflict']) }).safeParse(result.rows[0]?.result);
        if (error.success) throw new BackendError(error.data.error, error.data.error === 'workspace_limit' ? 'Workspace limit reached' : 'A workspace with this name already exists', error.data.error === 'workspace_limit' ? 429 : 409);
        return parse(customerWorkspaceSchema, result.rows[0]?.result);
      });
    },
    async updateWorkspace(identity: Identity, input: z.input<typeof customerUpdateWorkspaceSchema>) {
      const actor = principal(identity); const value = parse(customerUpdateWorkspaceSchema, input);
      return deps.database.tenant(discoveryTenant, async tx => {
        const result = await tx.query<{ result: unknown }>('SELECT gotchu.customer_rename_workspace($1,$2,$3) AS result', [actor.userId, value.organizationId, value.name]);
        const error = z.object({ error: z.enum(['workspace_not_found', 'workspace_name_conflict']) }).safeParse(result.rows[0]?.result);
        if (error.success) throw new BackendError(error.data.error, error.data.error === 'workspace_name_conflict' ? 'A workspace with this name already exists' : 'Workspace not found', error.data.error === 'workspace_name_conflict' ? 409 : 404);
        return parse(customerWorkspaceSchema, result.rows[0]?.result);
      });
    },
    async listApplications(identity: Identity, input: z.input<typeof organizationSchema>) {
      const actor = principal(identity); const scope = parse(organizationSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, actor);
        const result = await tx.query<{ id: string; name: string; archived: boolean; created_at: Date }>('SELECT id,name,archived,created_at FROM gotchu.applications WHERE organization_id=$1 ORDER BY created_at,id LIMIT 100', [scope.organizationId]);
        return result.rows.map(row => parse(customerApplicationSchema, { ...scope, applicationId: row.id, name: row.name, archived: row.archived, createdAt: row.created_at.toISOString() }));
      });
    },
    async createApplication(identity: Identity, input: z.input<typeof customerCreateApplicationSchema>) {
      const actor = principal(identity); const value = parse(customerCreateApplicationSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, writeRoles); await lockOrganization(tx, value.organizationId);
        const count = await tx.query<{ count: number; duplicate: boolean }>('SELECT count(*)::int AS count,coalesce(bool_or(lower(name)=lower($2)),false) AS duplicate FROM gotchu.applications WHERE organization_id=$1', [value.organizationId, value.name]);
        if (count.rows[0]?.duplicate) throw new BackendError('application_name_conflict', 'Application name already exists', 409);
        if ((count.rows[0]?.count ?? 20) >= 20) throw new BackendError('application_limit', 'Workspace application limit reached', 429);
        const applicationId = randomUUID();
        await tx.query('INSERT INTO gotchu.applications(organization_id,id,name) VALUES ($1,$2,$3)', [value.organizationId, applicationId, value.name]);
        await audit(tx, value.organizationId, actor.userId, 'application.created', applicationId);
        return readApplication(tx, { organizationId: value.organizationId, applicationId });
      });
    },
    async updateApplication(identity: Identity, input: z.input<typeof customerUpdateApplicationSchema>) {
      const actor = principal(identity); const value = parse(customerUpdateApplicationSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, writeRoles); await lockApplication(tx, value, true);
        if (value.name !== undefined) {
          const duplicate = await tx.query('SELECT id FROM gotchu.applications WHERE organization_id=$1 AND id<>$2 AND lower(name)=lower($3)', [value.organizationId, value.applicationId, value.name]);
          if (duplicate.rowCount) throw new BackendError('application_name_conflict', 'Application name already exists', 409);
        }
        await tx.query('UPDATE gotchu.applications SET name=coalesce($3,name),archived=coalesce($4,archived) WHERE organization_id=$1 AND id=$2', [value.organizationId, value.applicationId, value.name ?? null, value.archived ?? null]);
        await audit(tx, value.organizationId, actor.userId, 'application.updated', value.applicationId, { name: value.name ?? null, archived: value.archived ?? null });
        return readApplication(tx, value);
      });
    },
    async getLicensePolicy(identity: Identity, input: { organizationId: string }) {
      const actor = principal(identity); const scope = parse(organizationSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, actor);
        return currentLicensePolicy(tx, scope.organizationId);
      });
    },
    async updateLicensePolicy(identity: Identity, input: { organizationId: string; policy: LicensePolicy }) {
      const actor = principal(identity);
      const value = parse(organizationSchema.extend({ policy: licensePolicySchema }).strict(), input);
      let policy: LicensePolicy;
      try { policy = parse(licensePolicySchema, normalizeLicensePolicy(value.policy)); }
      catch (cause) { throw new BackendError('invalid_license_policy', 'La política contiene una expresión SPDX no reconocida o reglas incompatibles', 400, { cause }); }
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, writeRoles); await lockOrganization(tx, value.organizationId);
        const result = await tx.query<{ updated_at: Date }>(`INSERT INTO gotchu.customer_license_policies(organization_id,allow_licenses,deny_licenses,review_licenses,updated_by)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organization_id) DO UPDATE SET allow_licenses=EXCLUDED.allow_licenses,
          deny_licenses=EXCLUDED.deny_licenses,review_licenses=EXCLUDED.review_licenses,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
          RETURNING updated_at`, [value.organizationId, policy.allow, policy.deny, policy.review, actor.userId]);
        await audit(tx, value.organizationId, actor.userId, 'license_policy.updated', value.organizationId, { allow: policy.allow, deny: policy.deny, review: policy.review });
        return parse(workspaceLicensePolicySchema, { organizationId: value.organizationId, policy, updatedAt: result.rows[0]?.updated_at.toISOString() ?? new Date().toISOString(), configured: true });
      });
    },
    async enrollTarget(identity: Identity, input: z.input<typeof customerEnrollTargetSchema>): Promise<CustomerEnrollment> {
      const actor = principal(identity); const value = parse(customerEnrollTargetSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, writeRoles); await lockApplication(tx, value);
        const current = await targetRow(tx, value);
        if (current) await requireTargetIdle(tx, value, current.id);
        await tx.query(`INSERT INTO gotchu.customer_targets(organization_id,application_id,id,origin,version,status,requested_by,authorized_at,expires_at,scan_profile)
          VALUES ($1,$2,$3,$4,1,'authorized',$5,clock_timestamp(),clock_timestamp()+interval '7 days',$6)
          ON CONFLICT (organization_id,application_id) DO UPDATE SET origin=EXCLUDED.origin,version=customer_targets.version+1,status='authorized',
            requested_by=EXCLUDED.requested_by,requested_at=clock_timestamp(),authorized_at=clock_timestamp(),expires_at=clock_timestamp()+interval '7 days',scan_profile=EXCLUDED.scan_profile`,
        [value.organizationId, value.applicationId, randomUUID(), value.origin, actor.userId, value.scanProfile ?? 'root']);
        const row = requireTarget(await targetRow(tx, value));
        await audit(tx, value.organizationId, actor.userId, 'target.enrolled', row.id, { origin: value.origin, version: row.version, scanProfile: row.scan_profile });
        return { target: targetView(value, row) };
      });
    },
    async listTargets(identity: Identity, input: Scope): Promise<CustomerTarget[]> {
      const actor = principal(identity); const scope = parse(customerScopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, actor); await readApplication(tx, scope);
        const row = await targetRow(tx, scope); return row ? [targetView(scope, row)] : [];
      });
    },
    async revokeTarget(identity: Identity, input: z.input<typeof customerTargetIdSchema>): Promise<CustomerTarget> {
      const actor = principal(identity); const value = parse(customerTargetIdSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, writeRoles); await lockApplication(tx, value, true);
        requireTarget(await targetRow(tx, value, value.targetId));
        await requireTargetIdle(tx, value, value.targetId);
        await tx.query("UPDATE gotchu.customer_targets SET status='revoked',version=version+1,authorized_at=NULL,expires_at=NULL WHERE organization_id=$1 AND application_id=$2 AND id=$3", [value.organizationId, value.applicationId, value.targetId]);
        await audit(tx, value.organizationId, actor.userId, 'target.revoked', value.targetId);
        return targetView(value, requireTarget(await targetRow(tx, value, value.targetId)));
      });
    },
    uploadSource(identity: Identity, input: z.input<typeof customerUploadSourceSchema>): Promise<CustomerSourceSummary> {
      return storeSource(identity, input);
    },
    /** Server-only: provenance must come from an authenticated broker capture, never an HTTP upload body. */
    async uploadCapturedSource(identity: Identity, input: z.input<typeof customerUploadSourceSchema>, capture: unknown): Promise<CustomerSourceSummary> {
      if (deps.database.role !== 'gotchu_api') throw new BackendError('forbidden', 'Captured source upload requires the API role', 403);
      return storeSource(identity, input, parse(capturedSourceProvenanceSchema, capture));
    },
    async deleteSource(identity: Identity, input: z.input<typeof customerDeleteSourceSchema>): Promise<void> {
      const actor = principal(identity); const value = parse(customerDeleteSourceSchema, input);
      await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, writeRoles);
        await lockApplication(tx, value, true);
        const result = await tx.query<{ status: string }>('SELECT gotchu.customer_delete_source($1,$2,$3,$4) AS status', [value.organizationId, value.applicationId, value.sourceSnapshotId, actor.userId]).catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '55006' && error.message === 'source_in_use') {
            throw new BackendError('source_in_use', 'Wait for dependent assessments, corrections, and usage reconciliation before deleting this source', 409, { cause: error });
          }
          throw error;
        });
        const status = result.rows[0]?.status;
        if (status === 'in_use') throw new BackendError('source_in_use', 'Wait for dependent assessments, corrections, and usage reconciliation before deleting this source', 409);
        if (status === 'not_found') throw new BackendError('not_found', 'Source snapshot not found', 404);
        if (status !== 'deleted') throw new BackendError('forbidden', 'Source deletion was not authorized', 403);
      });
    },
    async listSources(identity: Identity, input: Scope): Promise<CustomerSourceSummary[]> {
      const actor = principal(identity); const scope = parse(customerScopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, actor); await readApplication(tx, scope);
        const result = await tx.query<{ id: string; digest: string; revision: string; count: number; created_at: Date }>(`SELECT id,digest,body->>'revision' AS revision,jsonb_array_length(body->'files') AS count,created_at FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 10`, [scope.organizationId, scope.applicationId]);
        return result.rows.map(row => parse(customerSourceSummarySchema, { ...scope, id: row.id, digest: row.digest, revision: row.revision, fileCount: row.count, createdAt: row.created_at.toISOString() }));
      });
    },
    async uploadContainerImage(identity: Identity, input: Scope & { label: string; authorized: true }, raw: Uint8Array): Promise<CustomerContainerImageSummary> {
      const actor = principal(identity);
      const scope = parse(customerScopeSchema, { organizationId: input.organizationId, applicationId: input.applicationId });
      const metadata = parse(customerContainerImageUploadMetadataSchema, { label: input.label, authorized: input.authorized });
      if (!(raw instanceof Uint8Array) || raw.byteLength < 1 || raw.byteLength > CUSTOMER_MAX_CONTAINER_IMAGE_BYTES) {
        throw new BackendError('payload_too_large', 'Container image archive exceeds the 8 MiB storage bound', 413);
      }
      const body = Buffer.from(raw);
      const digest = sha256(body);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, actor, writeRoles); await lockApplication(tx, scope);
        const prior = await tx.query<{ id: string; digest: string; label: string; size: number; created_at: Date }>(`SELECT id,digest,label,size,created_at
          FROM gotchu.customer_container_images WHERE organization_id=$1 AND application_id=$2 AND digest=$3 AND deleted_at IS NULL`, [scope.organizationId, scope.applicationId, digest]);
        const existing = prior.rows[0];
        if (existing) return containerImageSummary(scope, existing);
        const count = await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM gotchu.customer_container_images WHERE organization_id=$1 AND application_id=$2 AND deleted_at IS NULL', [scope.organizationId, scope.applicationId]);
        if ((count.rows[0]?.count ?? CUSTOMER_MAX_CONTAINER_IMAGES) >= CUSTOMER_MAX_CONTAINER_IMAGES) throw new BackendError('container_image_limit', 'Application container image limit reached', 429);
        const daily = await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM gotchu.customer_container_images WHERE organization_id=$1 AND created_at>clock_timestamp()-interval '1 day'", [scope.organizationId]);
        if ((daily.rows[0]?.count ?? CUSTOMER_MAX_DAILY_CONTAINER_IMAGES) >= CUSTOMER_MAX_DAILY_CONTAINER_IMAGES) throw new BackendError('container_image_daily_limit', 'Workspace daily image admission limit reached', 429);
        const id = randomUUID();
        const result = await tx.query<{ created_at: Date }>(`INSERT INTO gotchu.customer_container_images
          (organization_id,application_id,id,digest,label,size,body,consent_actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`,
        [scope.organizationId, scope.applicationId, id, digest, metadata.label, body.byteLength, body, actor.userId]);
        const row = result.rows[0]; if (!row) throw new Error('Container image insert returned no row');
        await audit(tx, scope.organizationId, actor.userId, 'container_image.uploaded', id, { digest, size: body.byteLength });
        return containerImageSummary(scope, { id, digest, label: metadata.label, size: body.byteLength, created_at: row.created_at });
      });
    },
    async listContainerImages(identity: Identity, input: Scope): Promise<CustomerContainerImageSummary[]> {
      const actor = principal(identity); const scope = parse(customerScopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, actor); await readApplication(tx, scope);
        const result = await tx.query<{ id: string; digest: string; label: string; size: number; created_at: Date }>(`SELECT id,digest,label,size,created_at
          FROM gotchu.customer_container_images WHERE organization_id=$1 AND application_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 10`,
        [scope.organizationId, scope.applicationId]);
        return result.rows.map(row => containerImageSummary(scope, row));
      });
    },
    async deleteContainerImage(identity: Identity, input: Scope & { imageId: string }): Promise<void> {
      const actor = principal(identity); const value = parse(customerScopeSchema.extend({ imageId: z.uuid() }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, writeRoles); await lockApplication(tx, value, true);
        const result = await tx.query<{ status: string }>('SELECT gotchu.customer_delete_container_image($1,$2,$3,$4) AS status', [value.organizationId, value.applicationId, value.imageId, actor.userId]);
        const status = result.rows[0]?.status;
        if (status === 'in_use') throw new BackendError('container_image_in_use', 'Wait for queued or running assessments before deleting this image', 409);
        if (status === 'not_found') throw new BackendError('not_found', 'Container image not found', 404);
        if (status !== 'deleted') throw new BackendError('forbidden', 'Container image deletion was not authorized', 403);
      });
    },
    async queue(identity: Identity, input: CustomerQueueInput): Promise<{ jobId: string }> {
      const actor = principal(identity); const value = parse(customerQueueSchema, input);
      const inputKind = value.inputKind ?? 'source_snapshot';
      const imageSelection = value.containerImage ?? null;
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, writeRoles); const app = await lockApplication(tx, value);
        const prior = await tx.query<{ id: string }>("SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='audit' AND idempotency_key=$3", [value.organizationId, value.applicationId, value.idempotencyKey]);
        const priorId = prior.rows[0]?.id;
        if (priorId) {
          const request = await loadIntent(tx, { ...value, jobId: priorId });
          const sameImage = request.containerImage?.kind === imageSelection?.kind
            && (request.containerImage?.kind === 'archive' && imageSelection?.kind === 'archive'
              ? request.containerImage.id === imageSelection.imageId
              : request.containerImage?.kind === 'registry' && imageSelection?.kind === 'registry'
                ? request.containerImage.reference === imageSelection.reference
                : request.containerImage == null && imageSelection == null);
          if (request.mode !== value.mode || (request.inputKind ?? 'source_snapshot') !== inputKind
            || (request.source?.id ?? null) !== value.sourceSnapshotId || (request.target?.id ?? null) !== value.targetId || !sameImage) {
            throw new BackendError('idempotency_conflict', 'This key identifies a different assessment', 409);
          }
          if (request.target) {
            const current = await targetRow(tx, value, request.target.id);
            if (!current || current.version !== request.target.version) throw new BackendError('idempotency_conflict', 'This key belongs to an earlier target authorization', 409);
          }
          return { jobId: priorId };
        }
        const counts = await tx.query<{ unfinished: number; daily: number }>(`SELECT
          (SELECT count(*)::int FROM gotchu.customer_requests r JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.id=r.job_id WHERE r.organization_id=$1 AND r.application_id=$2 AND j.state IN ('queued','running')) AS unfinished,
          (SELECT count(*)::int FROM gotchu.customer_requests WHERE organization_id=$1 AND created_at>clock_timestamp()-interval '1 day') AS daily`, [value.organizationId, value.applicationId]);
        const count = counts.rows[0];
        if (!count) throw new Error('Customer capacity query returned no row');
        if (count.unfinished >= CUSTOMER_MAX_UNFINISHED || count.daily >= CUSTOMER_MAX_DAILY_RUNS) throw new BackendError('assessment_capacity_exceeded', 'Assessment capacity is full; retry later', 429);
        let source: CustomerAssessmentIntent['source'] = null;
        if (value.sourceSnapshotId) {
          const result = await tx.query<{ id: string; digest: string; revision: string }>("SELECT id,digest,body->>'revision' AS revision FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND deleted_at IS NULL", [value.organizationId, value.applicationId, value.sourceSnapshotId]);
          const row = result.rows[0]; if (!row) throw new BackendError('not_found', 'Source snapshot not found in this application', 404);
          source = { revision: row.revision, id: row.id, digest: row.digest };
        }
        let target: CustomerRunInput['target'] = null;
        if (value.targetId) {
          const row = requireTarget(await targetRow(tx, value, value.targetId));
          if (!row.authorization_current || !row.authorized_at || !row.expires_at) throw new BackendError('target_not_authorized', 'Enter a target origin before requesting external assessment', 409);
          target = { id: row.id, origin: row.origin, version: row.version, authorizedAt: row.authorized_at.toISOString(), expiresAt: row.expires_at.toISOString(), scanProfile: row.scan_profile };
        }
        const licensePolicy = (await currentLicensePolicy(tx, value.organizationId)).policy;
        let containerImage: CustomerAssessmentIntent['containerImage'] = null;
        let containerImageId: string | null = null;
        if (imageSelection?.kind === 'archive') {
          const result = await tx.query<{ id: string; digest: string; size: number }>(`SELECT id,digest,size FROM gotchu.customer_container_images
            WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND deleted_at IS NULL`, [value.organizationId, value.applicationId, imageSelection.imageId]);
          const row = result.rows[0]; if (!row) throw new BackendError('not_found', 'Container image not found in this application', 404);
          containerImageId = row.id;
          containerImage = { kind: 'archive', id: row.id, digest: row.digest, size: row.size };
        } else if (imageSelection?.kind === 'registry') {
          const digest = imageSelection.reference.slice(imageSelection.reference.lastIndexOf('@sha256:') + 8);
          containerImage = { kind: 'registry', reference: imageSelection.reference, digest };
        }
        const request = parse(customerAssessmentIntentSchema, { version: 2, organizationId: value.organizationId, applicationId: value.applicationId, jobId: randomUUID(), applicationName: app.name, mode: value.mode, inputKind, source, containerImage, target, licensePolicy });
        const jobId = await enqueue(tx, { organizationId: value.organizationId, applicationId: value.applicationId, id: request.jobId, kind: 'audit', idempotencyKey: value.idempotencyKey, payload: request });
        if (jobId !== request.jobId) throw new BackendError('idempotency_conflict', 'Concurrent audit reused this key', 409);
        await tx.query('INSERT INTO gotchu.customer_requests(organization_id,application_id,job_id,source_id,target_id,container_image_id,input) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [value.organizationId, value.applicationId, jobId, value.sourceSnapshotId, value.targetId, containerImageId, JSON.stringify(request)]);
        await audit(tx, value.organizationId, actor.userId, 'customer_assessment.queued', jobId, { mode: value.mode, ...reportSubject(request) });
        return { jobId };
      });
    },
    async listReports(identity: Identity, input: Scope & { limit?: number }) {
      const actor = principal(identity); const value = parse(customerScopeSchema.extend({ limit: z.number().int().min(1).max(50).default(20) }), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor); await readApplication(tx, value);
        const result = await tx.query<{ summary: unknown }>(`SELECT jsonb_build_object('id',id,'jobId',job_id,'mode',body->'mode','applicationName',body->'applicationName',
          'startedAt',body->'startedAt','finishedAt',body->'finishedAt','subject',body->'subject',
          'findingCount',coalesce(jsonb_array_length(body->'internal'->'findings'),0)+coalesce(jsonb_array_length(body->'external'->'findings'),0)) AS summary
          FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at DESC,id LIMIT $3`, [value.organizationId, value.applicationId, value.limit]);
        return result.rows.map(row => parse(customerReportSummarySchema, row.summary));
      });
    },
    async getReport(identity: Identity, input: Scope & { reportId: string }): Promise<CustomerAssessmentReport> {
      const actor = principal(identity); const value = parse(customerScopeSchema.extend({ reportId: z.uuid() }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor);
        const result = await tx.query<{ body: unknown }>('SELECT body FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND id=$3', [value.organizationId, value.applicationId, value.reportId]);
        if (!result.rows[0]) throw new BackendError('not_found', 'Report not found', 404);
        return parse(customerAssessmentReportSchema, result.rows[0].body);
      });
    },
    async exportSbom(identity: Identity, input: Scope & { reportId: string }) {
      const actor = principal(identity); const value = parse(customerScopeSchema.extend({ reportId: z.uuid() }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor);
        const result = await tx.query<{ body: unknown }>('SELECT body FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND id=$3', [value.organizationId, value.applicationId, value.reportId]);
        if (!result.rows[0]) throw new BackendError('not_found', 'Report not found', 404);
        const report = parse(customerAssessmentReportSchema, result.rows[0].body);
        if (!report.internal?.dependencyInventory) throw new BackendError('sbom_unavailable', 'Este informe no contiene un inventario de dependencias exportable', 409);
        await audit(tx, value.organizationId, actor.userId, 'report.sbom_download_requested', value.reportId);
        return buildCycloneDx(report);
      });
    },
    async recordReportDownload(identity: Identity, input: Scope & { reportId: string }): Promise<void> {
      const actor = principal(identity); const value = parse(customerScopeSchema.extend({ reportId: z.uuid() }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor);
        const result = await tx.query('SELECT id FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND id=$3', [value.organizationId, value.applicationId, value.reportId]);
        if (!result.rowCount) throw new BackendError('not_found', 'Report not found', 404);
        await audit(tx, value.organizationId, actor.userId, 'report.download_requested', value.reportId);
      });
    },
    async getRequest(input: CustomerClaim): Promise<CustomerRunInput> {
      const claim = parse(customerClaimSchema, input);
      return deps.database.tenant(claim.organizationId, tx => currentRequest(tx, claim));
    },
    async recordResult(input: { input: CustomerRunInput; leaseToken: string; report: unknown }): Promise<{ reportId: string }> {
      const value = parse(z.object({ input: customerRunInputSchema, leaseToken: z.uuid(), report: z.unknown() }).strict(), input);
      const validated = customerAssessmentReportSchema.safeParse(value.report);
      if (!validated.success) throw new BackendError('assessment_invalid_report', 'Output does not match the customer report contract', 409);
      const report = validated.data; const request = value.input;
      if (report.organizationId !== request.organizationId || report.applicationId !== request.applicationId || report.jobId !== request.jobId
        || report.mode !== request.mode || report.applicationName !== request.applicationName || canonicalJson(report.subject) !== canonicalJson(reportSubject(request))) throw new BackendError('assessment_scope_mismatch', 'Report does not match the exact requested subject', 409);
      if (request.source !== null) {
        const policy = request.licensePolicy ?? defaultLicensePolicy;
        const inventory = report.internal?.dependencyInventory;
        if (!inventory || canonicalJson(inventory.policy) !== canonicalJson(policy)) {
          throw new BackendError('assessment_license_policy_mismatch', 'Dependency inventory must record the policy bound to the durable assessment request', 409);
        }
        if (inventory.components.some(component => component.licenseExpression !== normalizeLicenseExpression(component.declaredLicense)
          || component.licenseConfidence !== (component.declaredLicense === null ? 'unknown' : 'declared')
          || component.policyStatus !== evaluateLicensePolicy(component.licenseExpression, policy))) {
          throw new BackendError('assessment_license_result_invalid', 'Dependency license results do not match their declared metadata and workspace policy', 409);
        }
      }
      return deps.database.tenant(request.organizationId, async tx => {
        const persisted = await currentRequest(tx, { organizationId: request.organizationId, applicationId: request.applicationId, jobId: request.jobId, leaseToken: value.leaseToken });
        if (canonicalJson(request) !== canonicalJson(persisted)) throw new BackendError('assessment_scope_mismatch', 'Runner input differs from durable request', 409);
        const serialized = JSON.stringify(report); await checkJsonSize(tx, serialized, CUSTOMER_MAX_REPORT_BYTES);
        await tx.query('INSERT INTO gotchu.customer_reports(organization_id,application_id,id,job_id,body) VALUES ($1,$2,$3,$4,$5::jsonb)', [request.organizationId, request.applicationId, report.id, request.jobId, serialized]);
        const artifactAnalyses = new Map<string, { name: string; version: string; purl: string; analysis: DependencyArtifactAnalysis }>();
        for (const component of report.internal?.dependencyInventory?.components ?? []) {
          if (!component.artifactAnalysis) continue;
          const existing = artifactAnalyses.get(component.purl);
          if (existing && canonicalJson(existing.analysis) !== canonicalJson(component.artifactAnalysis)) {
            throw new BackendError('assessment_artifact_duplicate', 'A report contains conflicting artifact analyses for the same exact package', 409);
          }
          artifactAnalyses.set(component.purl, { name: component.name, version: component.version, purl: component.purl, analysis: component.artifactAnalysis });
        }
        for (const artifact of artifactAnalyses.values()) {
          await tx.query(`INSERT INTO gotchu.customer_dependency_artifact_analyses
            (organization_id,application_id,report_id,package_name,package_version,purl,analysis)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [request.organizationId, request.applicationId, report.id, artifact.name, artifact.version, artifact.purl, JSON.stringify(artifact.analysis)]);
        }
        // Locks prevent concurrent revocation; recheck time-based expiry after storage work too.
        if (request.target && !(await targetRow(tx, request, request.target.id))?.authorization_current) throw new BackendError('assessment_target_changed', 'Target authorization expired before completion', 409);
        await enqueueAutomaticSourceInvestigations(tx, report);
        await completeJob(tx, { organizationId: request.organizationId, jobId: request.jobId, leaseToken: value.leaseToken, result: { status: 'completed', reportId: report.id } });
        await enqueue(tx, { organizationId: request.organizationId, applicationId: request.applicationId, id: randomUUID(), kind: 'notification', idempotencyKey: `assessment-observation:${report.id}`, payload: { kind: 'assessment_observation', reportId: report.id } });
        await audit(tx, request.organizationId, 'coordinator', 'customer_assessment.recorded', report.id, { jobId: request.jobId });
        return { reportId: report.id };
      });
    },
  };
}
function sourceSummary(scope: Scope, id: string, digest: string, snapshot: z.infer<typeof customerSourceSnapshotSchema>, createdAt: Date): CustomerSourceSummary {
  return parse(customerSourceSummarySchema, { organizationId: scope.organizationId, applicationId: scope.applicationId, id, digest, revision: snapshot.revision, fileCount: snapshot.files.length, createdAt: createdAt.toISOString() });
}
