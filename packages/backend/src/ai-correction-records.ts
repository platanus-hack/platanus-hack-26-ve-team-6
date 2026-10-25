import { z } from 'zod';
import { aiCorrectionSchema, type AiCorrection, type AiCorrectionInput } from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { authorize, parse } from './core.js';
import { lockCorrectionApplication } from './corrections.js';
import { correctionAssessment, correctionBoundary, correctionModelFingerprint, restoreCorrectionInput } from './ai-correction-context.js';

export interface AiCorrectionRow {
  id: string; job_id: string; organization_id: string; application_id: string; report_id: string; finding_id: string;
  source_digest: string; state: AiCorrection['state']; summary: string | null; reason_code: string | null;
  candidate_source_id: string | null; patch_hash: string | null; validation_run_id: string | null;
  implications: unknown; risks: unknown; validation_plan: unknown; diff: unknown; created_at: Date;
}
export interface PrivateAiCorrectionRow extends AiCorrectionRow {
  base_source_id: string; requested_by: string; model_config_sha256: string;
  authorized_files: unknown; suggestion: unknown; model_patch: unknown;
}
// Public reads cannot accidentally select a raw provider patch or settings reference.
export const correctionProjectionColumns = `id,job_id,organization_id,application_id,report_id,finding_id,source_digest,state,
  summary,reason_code,candidate_source_id,patch_hash,validation_run_id,implications,risks,validation_plan,diff,created_at`;
export function projectAiCorrection(row: AiCorrectionRow): AiCorrection {
  return parse(aiCorrectionSchema, { id: row.id, jobId: row.job_id, organizationId: row.organization_id,
    applicationId: row.application_id, reportId: row.report_id, findingId: row.finding_id, sourceDigest: row.source_digest,
    state: row.state, summary: row.summary, reasonCode: row.reason_code, candidateSourceId: row.candidate_source_id,
    patchHash: row.patch_hash, validationRunId: row.validation_run_id, implications: row.implications,
    risks: row.risks, validationPlan: row.validation_plan, diff: row.diff, createdAt: row.created_at.toISOString() });
}

export const correctionRunScopeSchema = z.object({ organizationId: z.uuid(), applicationId: z.uuid(), runId: z.uuid(), correctionId: z.uuid() }).strict();
export type CorrectionRunScope = z.infer<typeof correctionRunScopeSchema>;
export const correctionJobScopeSchema = z.object({ organizationId: z.uuid(), applicationId: z.uuid(), jobId: z.uuid(), leaseToken: z.uuid() }).strict();
export type CorrectionJobScope = z.infer<typeof correctionJobScopeSchema>;

export async function lockCorrectionJob(tx: Transaction, scope: CorrectionJobScope) {
  const jobs = await tx.query(`SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND id=$3
    AND lease_token=$4 AND kind='investigation' AND state='running' AND lease_until>clock_timestamp() FOR UPDATE`,
  [scope.organizationId, scope.applicationId, scope.jobId, scope.leaseToken]);
  if (!jobs.rowCount) correctionBoundary('correction_lease_lost');
}

export async function correctionForJob(tx: Transaction, scope: { organizationId: string; applicationId: string; jobId: string }) {
  const rows = await tx.query<PrivateAiCorrectionRow>(`SELECT * FROM gotchu.ai_correction_requests
    WHERE organization_id=$1 AND application_id=$2 AND job_id=$3 FOR UPDATE`, [scope.organizationId, scope.applicationId, scope.jobId]);
  return rows.rows[0] ?? null;
}

export async function pinnedCorrectionContext(tx: Transaction, row: PrivateAiCorrectionRow, runId: string) {
  const scope = { organizationId: row.organization_id, applicationId: row.application_id, reportId: row.report_id };
  await authorize(tx, scope.organizationId, { userId: row.requested_by }, ['owner', 'operator']);
  await tx.query('SELECT gotchu.lock_ai_correction_model($1)', [scope.organizationId]);
  await lockCorrectionApplication(tx, scope);
  if (await correctionModelFingerprint(tx, scope.organizationId) !== row.model_config_sha256) correctionBoundary('model_configuration_changed');
  const assessment = await correctionAssessment(tx, { ...scope, findingId: row.finding_id, expectedSourceDigest: row.source_digest });
  if (assessment.source.id !== row.base_source_id) correctionBoundary('correction_source_mismatch');
  const input = restoreCorrectionInput({ organizationId: scope.organizationId, applicationId: scope.applicationId, runId },
    row.id, assessment, row.authorized_files, row.suggestion);
  return { input, original: { revision: assessment.source.revision, files: assessment.source.files } };
}

export async function boundCorrectionForRun(tx: Transaction, raw: CorrectionRunScope) {
  const scope = parse(correctionRunScopeSchema, raw);
  const result = await tx.query<PrivateAiCorrectionRow>(`SELECT c.* FROM gotchu.ai_correction_requests c
    JOIN gotchu.jobs j ON j.organization_id=c.organization_id AND j.application_id=c.application_id AND j.id=c.job_id
    JOIN gotchu.agent_runs r ON r.organization_id=j.organization_id AND r.application_id=j.application_id AND r.job_id=j.id
    WHERE c.organization_id=$1 AND c.application_id=$2 AND c.id=$3 AND r.id=$4
      AND c.state IN ('queued','running') AND j.kind='investigation' AND j.state='running' AND j.lease_until>clock_timestamp()
      AND j.payload->>'correctionId'=c.id::text AND j.payload->>'version'='2'
      AND j.payload->'subject'->>'kind'='finding' AND j.payload->'subject'->>'reportId'=c.report_id::text
      AND j.payload->'subject'->>'subjectId'=c.finding_id::text
      AND r.state='running' AND r.deadline>clock_timestamp() AND r.cancel_requested_at IS NULL
    FOR UPDATE OF j,r,c`, [scope.organizationId, scope.applicationId, scope.correctionId, scope.runId]);
  const row = result.rows[0];
  if (!row) correctionBoundary('correction_run_unavailable');
  return { row, scope };
}

/** Gateway-only hydration; the caller supplies a tenant transaction, never model-selected content. */
export async function loadAiCorrectionInput(tx: Transaction, scope: CorrectionRunScope): Promise<AiCorrectionInput> {
  const bound = await boundCorrectionForRun(tx, scope);
  return (await pinnedCorrectionContext(tx, bound.row, bound.scope.runId)).input;
}
