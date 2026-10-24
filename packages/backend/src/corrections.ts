import { z } from 'zod';
import { customerAssessmentIntentSchema, customerAssessmentReportSchema, customerRunInputSchema, customerScopeSchema, customerSourceSnapshotSchema } from '@gotchu/contracts';
import type { Database, Transaction } from '@gotchu/database';
import { prepareCorrectionRequestSchema, type PrepareCorrectionResponse, type ReportRecommendationsResponse } from '@gotchu/scenarios/contracts';
import { buildRecipeRecommendations, correctionResponseForQueuedScan, prepareCandidatePatch, RecipeBoundaryError } from '@gotchu/scenarios/server';
import { audit, authorize, BackendError, canonicalJson, identitySchema, parse, sha256, type BaseDependencies, type Identity } from './core.js';
import { createCustomerService } from './customers.js';

export const correctionReportScopeSchema = customerScopeSchema.extend({ reportId: z.uuid() }).strict();
export const prepareCorrectionInputSchema = correctionReportScopeSchema.extend(prepareCorrectionRequestSchema.shape).strict();
export type CorrectionReportScope = z.infer<typeof correctionReportScopeSchema>;
export type PrepareCorrectionInput = z.infer<typeof prepareCorrectionInputSchema>;

async function lockApplication(tx: Transaction, scope: CorrectionReportScope) {
  const organization = await tx.query<{ exists: boolean }>('SELECT gotchu.lock_customer_organization($1) AS exists', [scope.organizationId]);
  if (!organization.rows[0]?.exists) throw new BackendError('not_found', 'Workspace not found', 404);
  const result = await tx.query<{ app: unknown }>('SELECT gotchu.lock_customer_application($1,$2) AS app', [scope.organizationId, scope.applicationId]);
  if (!result.rows[0]?.app) throw new BackendError('not_found', 'Application not found', 404);
  const app = parse(z.object({ name: z.string(), archived: z.boolean() }).strict(), result.rows[0].app);
  if (app.archived) throw new BackendError('application_archived', 'Restore the application before preparing corrections', 409);
}

function scopeMismatch(): never {
  throw new BackendError('assessment_scope_mismatch', 'Stored assessment does not match its canonical request and source', 409);
}

/** Historical reports use persisted intent, never the lease-only scanner hydration API. */
async function loadAssessment(tx: Transaction, scope: CorrectionReportScope) {
  const result = await tx.query<{ body: unknown; job_id: string; input: unknown; payload: unknown; kind: string; source_id: string | null; target_id: string | null }>(`SELECT p.body,p.job_id,r.input,r.source_id,r.target_id,j.payload,j.kind
    FROM gotchu.customer_reports p
    JOIN gotchu.customer_requests r ON r.organization_id=p.organization_id AND r.application_id=p.application_id AND r.job_id=p.job_id
    JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.application_id=r.application_id AND j.id=r.job_id
    WHERE p.organization_id=$1 AND p.application_id=$2 AND p.id=$3`, [scope.organizationId, scope.applicationId, scope.reportId]);
  const row = result.rows[0];
  if (!row) throw new BackendError('not_found', 'Report not found in this application', 404);
  const intent = parse(customerAssessmentIntentSchema, row.input);
  const report = parse(customerAssessmentReportSchema, row.body);
  if (row.kind !== 'audit' || canonicalJson(intent) !== canonicalJson(row.payload)
    || intent.organizationId !== scope.organizationId || intent.applicationId !== scope.applicationId || intent.jobId !== row.job_id
    || (intent.source?.id ?? null) !== row.source_id || (intent.target?.id ?? null) !== row.target_id
    || report.id !== scope.reportId || report.jobId !== row.job_id) scopeMismatch();
  let source = null;
  if (intent.source) {
    const sources = await tx.query<{ body: unknown; digest: string; deleted_at: Date | null }>(
      'SELECT body,digest,deleted_at FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3',
      [scope.organizationId, scope.applicationId, intent.source.id]);
    const stored = sources.rows[0];
    if (!stored || stored.deleted_at !== null || stored.body === null) throw new BackendError('source_unavailable', 'The original source snapshot is no longer available; the report remains readable', 409);
    const snapshot = parse(customerSourceSnapshotSchema, stored.body);
    if (stored.digest !== intent.source.digest || snapshot.revision !== intent.source.revision || sha256(canonicalJson(snapshot)) !== intent.source.digest) scopeMismatch();
    source = { ...snapshot, ...intent.source };
  }
  return { input: parse(customerRunInputSchema, { ...intent, source }), report };
}

function recipeBoundary<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof RecipeBoundaryError) throw new BackendError(error.code, 'Correction evidence or source digest does not match this assessment', 409, { cause: error });
    throw error;
  }
}

/** Only the current tenant transaction is available to the existing customer services. */
function transactionDatabase(database: Database, organizationId: string, tx: Transaction): Database {
  const unavailable = async (): Promise<never> => { throw new Error('Correction transaction capability does not allow this operation'); };
  return {
    role: database.role,
    tenant: async (requestedOrganizationId, work) => {
      if (requestedOrganizationId !== organizationId) throw new BackendError('forbidden', 'Correction transaction cannot change tenant', 403);
      return work(tx);
    },
    integration: unavailable,
    checkHealth: unavailable,
    close: unavailable,
  };
}

export function createCorrectionService(deps: BaseDependencies) {
  return {
    async recommendations(identity: Identity, input: CorrectionReportScope): Promise<ReportRecommendationsResponse> {
      const actor = parse(identitySchema, identity); const scope = parse(correctionReportScopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, actor);
        await lockApplication(tx, scope);
        const assessment = await loadAssessment(tx, scope);
        return recipeBoundary(() => buildRecipeRecommendations(assessment.input, assessment.report));
      });
    },
    async prepare(identity: Identity, input: PrepareCorrectionInput): Promise<PrepareCorrectionResponse> {
      const actor = parse(identitySchema, identity); const value = parse(prepareCorrectionInputSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, ['owner', 'operator']);
        await lockApplication(tx, value);
        const assessment = await loadAssessment(tx, value);
        const preparation = recipeBoundary(() => prepareCandidatePatch(assessment.input, assessment.report, {
          recipeId: value.recipeId, findingId: value.findingId, expectedSourceDigest: value.expectedSourceDigest,
        }));
        if (preparation.status === 'blocked') throw new BackendError(preparation.reason, 'Correction preparation is blocked: ' + preparation.reason, 409);
        const idempotencyKey = `correction:${preparation.patchHash}`;
        // Replay precedes source/assessment admission, even if a completed candidate was later deleted.
        const prior = await tx.query<{ job_id: string; input: unknown; payload: unknown; source_id: string | null; target_id: string | null }>(`SELECT r.job_id,r.input,r.source_id,r.target_id,j.payload
          FROM gotchu.jobs j JOIN gotchu.customer_requests r ON r.organization_id=j.organization_id AND r.application_id=j.application_id AND r.job_id=j.id
          WHERE j.organization_id=$1 AND j.application_id=$2 AND j.kind='audit' AND j.idempotency_key=$3`,
        [value.organizationId, value.applicationId, idempotencyKey]);
        const replay = prior.rows[0];
        if (replay) {
          const intent = parse(customerAssessmentIntentSchema, replay.input);
          if (canonicalJson(intent) !== canonicalJson(replay.payload) || intent.organizationId !== value.organizationId || intent.applicationId !== value.applicationId
            || intent.jobId !== replay.job_id || intent.mode !== 'internal' || intent.target !== null || replay.target_id !== null
            || !intent.source || intent.source.id !== replay.source_id || intent.source.digest !== preparation.candidateSourceDigest
            || intent.source.revision !== preparation.candidateSourceSnapshot.revision) scopeMismatch();
          return correctionResponseForQueuedScan(preparation, intent.source.id, replay.job_id);
        }
        const customers = createCustomerService({ database: transactionDatabase(deps.database, value.organizationId, tx) });
        const scope = { organizationId: value.organizationId, applicationId: value.applicationId };
        const source = await customers.uploadSource(actor, { ...scope, snapshot: preparation.candidateSourceSnapshot, authorized: true });
        if (source.digest !== preparation.candidateSourceDigest) scopeMismatch();
        const job = await customers.queue(actor, { ...scope, mode: 'internal', sourceSnapshotId: source.id, targetId: null, idempotencyKey });
        await audit(tx, value.organizationId, actor.userId, 'correction.prepared', source.id, {
          applicationId: value.applicationId, reportId: value.reportId, recipeId: preparation.recipeId, recipeVersion: preparation.recipeVersion,
          findingId: preparation.findingId, originalSourceId: preparation.scope.sourceSnapshotId, sourceId: source.id, jobId: job.jobId,
          sourceDigest: preparation.scope.sourceDigest, candidateSourceDigest: source.digest, patchHash: preparation.patchHash,
          path: preparation.path, originalFileSha256: preparation.originalFileSha256, candidateFileSha256: sha256(preparation.afterBytes),
        });
        return correctionResponseForQueuedScan(preparation, source.id, job.jobId);
      });
    },
  };
}
