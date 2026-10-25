import { z } from 'zod';
import type { AiCorrection } from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { audit, canonicalJson, parse } from './core.js';
import { transactionDatabase } from './corrections.js';
import { createCustomerService } from './customers.js';
import { enqueueValidation } from './validations.js';
import { applyCorrectionPatch, correctionBoundary } from './ai-correction-context.js';
import {
  boundCorrectionForRun, correctionForJob, correctionJobScopeSchema, lockCorrectionJob, pinnedCorrectionContext,
  projectAiCorrection, type CorrectionJobScope, type CorrectionRunScope, type PrivateAiCorrectionRow,
} from './ai-correction-records.js';

/** Persist only privately, before returning the provider result to the worker. */
export async function storeAiCorrectionPatch(tx: Transaction, scope: CorrectionRunScope, patch: unknown): Promise<void> {
  const bound = await boundCorrectionForRun(tx, scope);
  const context = await pinnedCorrectionContext(tx, bound.row, bound.scope.runId);
  const prepared = applyCorrectionPatch(context.input, context.original, patch);
  if (bound.row.model_patch !== null) {
    if (canonicalJson(bound.row.model_patch) !== canonicalJson(prepared.patch)) correctionBoundary('correction_patch_conflict');
    return;
  }
  await tx.query(`UPDATE gotchu.ai_correction_requests SET model_patch=$4::jsonb,updated_at=clock_timestamp()
    WHERE organization_id=$1 AND application_id=$2 AND id=$3`,
  [scope.organizationId, scope.applicationId, scope.correctionId, JSON.stringify(prepared.patch)]);
}

/** Called in the coordinator's SAME finalization transaction, before completeJob. */
export async function completeAiCorrectionForJob(tx: Transaction, raw: CorrectionJobScope & { runId: string }): Promise<AiCorrection | null> {
  const scope = parse(correctionJobScopeSchema.extend({ runId: z.uuid() }).strict(), raw);
  await lockCorrectionJob(tx, scope);
  const row = await correctionForJob(tx, scope);
  if (!row) return null;
  if (row.state === 'prepared') return projectAiCorrection(row);
  if (row.state !== 'queued' && row.state !== 'running') return null;
  const run = await tx.query<{ cancelled: boolean; settled: boolean; payload: unknown }>(`SELECT r.cancel_requested_at IS NOT NULL AS cancelled,
      (r.reserved_micros=0 AND r.tokens_reserved=0
        AND EXISTS (SELECT 1 FROM gotchu.model_reservations m WHERE m.organization_id=r.organization_id AND m.run_id=r.id AND m.state='settled')
        AND NOT EXISTS (SELECT 1 FROM gotchu.model_reservations m WHERE m.organization_id=r.organization_id AND m.run_id=r.id
          AND (m.state<>'settled' OR m.model_config_sha256 IS DISTINCT FROM $5))) AS settled,j.payload
    FROM gotchu.agent_runs r JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.application_id=r.application_id AND j.id=r.job_id
    WHERE r.organization_id=$1 AND r.application_id=$2 AND r.job_id=$3 AND r.id=$4 FOR UPDATE OF r`,
  [scope.organizationId, scope.applicationId, scope.jobId, scope.runId, row.model_config_sha256]);
  const current = run.rows[0];
  if (!current) correctionBoundary('correction_run_unavailable');
  const payload = parse(z.object({ version: z.literal(2), correctionId: z.uuid(), subject: z.object({ kind: z.literal('finding'), reportId: z.uuid(), subjectId: z.uuid() }).strict(), evidenceIds: z.array(z.uuid()).min(1).max(20) }).strict(), current.payload);
  if (payload.correctionId !== row.id || payload.subject.reportId !== row.report_id || payload.subject.subjectId !== row.finding_id) correctionBoundary('correction_run_mismatch');
  if (current.cancelled) {
    await failAiCorrectionForJob(tx, { organizationId: scope.organizationId, applicationId: scope.applicationId, jobId: scope.jobId, leaseToken: scope.leaseToken, reasonCode: 'cancelled' });
    return null;
  }
  if (row.model_patch === null) return null;
  if (!current.settled) correctionBoundary('correction_reconciliation_required');
  const context = await pinnedCorrectionContext(tx, row, scope.runId);
  if (canonicalJson([...payload.evidenceIds].sort()) !== canonicalJson([...context.input.finding.evidenceIds].sort())) correctionBoundary('correction_evidence_mismatch');
  const prepared = applyCorrectionPatch(context.input, context.original, row.model_patch);
  const customers = createCustomerService({ database: transactionDatabase({ role: 'gotchu_coordinator' }, scope.organizationId, tx) });
  const actor = { userId: row.requested_by };
  const app = { organizationId: scope.organizationId, applicationId: scope.applicationId };
  const candidate = await customers.uploadSource(actor, { ...app, authorized: true, snapshot: prepared.snapshot });
  if (candidate.digest !== prepared.candidateDigest) correctionBoundary('correction_candidate_mismatch');
  const rescan = await customers.queue(actor, { ...app, mode: 'internal', sourceSnapshotId: candidate.id, targetId: null,
    idempotencyKey: `ai-correction:${row.id}:${prepared.patchHash}` });
  const validationRunId = await enqueueValidation(tx, { ...app, candidateSourceId: candidate.id, baseSourceId: row.base_source_id,
    targetFindingId: row.finding_id, baseDigest: row.source_digest, candidateDigest: candidate.digest, patchDigest: prepared.patchHash });
  const paths = prepared.diff.map(file => file.path);
  await audit(tx, scope.organizationId, actor.userId, 'correction.prepared', candidate.id, {
    applicationId: scope.applicationId, reportId: row.report_id, correctionId: row.id, recipeId: 'ai-source-fix', recipeVersion: '1',
    findingId: row.finding_id, originalSourceId: row.base_source_id, sourceId: candidate.id, jobId: rescan.jobId,
    sourceDigest: row.source_digest, candidateDigest: candidate.digest, candidateSourceDigest: candidate.digest, patchHash: prepared.patchHash,
    path: paths[0], paths, validationRunId,
  });
  const updated = await tx.query<PrivateAiCorrectionRow>(`UPDATE gotchu.ai_correction_requests SET state='prepared',candidate_source_id=$4,
    patch_hash=$5,validation_run_id=$6,rescan_job_id=$7,summary=$8,implications=$9::jsonb,risks=$10::jsonb,
    validation_plan=$11::jsonb,diff=$12::jsonb,reason_code=NULL,updated_at=clock_timestamp()
    WHERE organization_id=$1 AND application_id=$2 AND id=$3 RETURNING *`,
  [scope.organizationId, scope.applicationId, row.id, candidate.id, prepared.patchHash, validationRunId, rescan.jobId,
    prepared.patch.summary, JSON.stringify(prepared.patch.implications), JSON.stringify(prepared.patch.risks),
    JSON.stringify(prepared.patch.validationPlan), JSON.stringify(prepared.diff)]);
  const result = updated.rows[0];
  if (!result) correctionBoundary('correction_unavailable');
  return projectAiCorrection(result);
}

export async function failAiCorrectionForJob(tx: Transaction, raw: CorrectionJobScope & { reasonCode: string }): Promise<void> {
  // Keep reason codes machine-readable: provider error text must never enter public projections.
  const scope = parse(correctionJobScopeSchema.extend({ reasonCode: z.string().regex(/^[a-z0-9_]{1,100}$/) }).strict(), raw);
  await lockCorrectionJob(tx, scope);
  const row = await correctionForJob(tx, scope);
  if (!row || row.state === 'prepared' || row.state === 'failed') return;
  const runs = await tx.query<{ reserved: boolean; cancelled: boolean }>(`SELECT (reserved_micros>0 OR tokens_reserved>0) AS reserved,
    cancel_requested_at IS NOT NULL AS cancelled FROM gotchu.agent_runs
    WHERE organization_id=$1 AND application_id=$2 AND job_id=$3 FOR UPDATE`, [scope.organizationId, scope.applicationId, scope.jobId]);
  const run = runs.rows[0];
  const state = run?.reserved || scope.reasonCode.includes('reconciliation') ? 'reconciliation_required'
    : run?.cancelled || row.state === 'cancelled' || scope.reasonCode === 'cancelled' ? 'cancelled' : 'failed';
  await tx.query(`UPDATE gotchu.ai_correction_requests SET state=$4,reason_code=$5,updated_at=clock_timestamp()
    WHERE organization_id=$1 AND application_id=$2 AND id=$3`,
  [scope.organizationId, scope.applicationId, row.id, state, state === 'cancelled' ? 'cancelled' : scope.reasonCode]);
  await audit(tx, scope.organizationId, 'coordinator', 'ai_correction.finished', row.id, { applicationId: scope.applicationId, state, reasonCode: scope.reasonCode });
}
