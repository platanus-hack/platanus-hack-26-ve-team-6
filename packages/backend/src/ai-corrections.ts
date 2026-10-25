import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { aiCorrectionRequestSchema, aiCorrectionInputSchema, type AiCorrection, type AiCorrectionRequest } from '@gotchu/contracts';
import { audit, authorize, BackendError, identitySchema, parse, type BaseDependencies, type Identity } from './core.js';
import { correctionReportScopeSchema, lockCorrectionApplication, type CorrectionReportScope } from './corrections.js';
import { enqueue } from './jobs.js';
import { correctionAssessment, correctionBoundary, correctionModelFingerprint, selectCorrectionInput } from './ai-correction-context.js';
import {
  correctionForJob, correctionJobScopeSchema, correctionProjectionColumns, lockCorrectionJob, pinnedCorrectionContext,
  projectAiCorrection, type AiCorrectionRow, type CorrectionJobScope,
} from './ai-correction-records.js';
export { loadAiCorrectionInput } from './ai-correction-records.js';
export { storeAiCorrectionPatch, completeAiCorrectionForJob, failAiCorrectionForJob } from './ai-correction-finalization.js';

export function createAiCorrectionService(deps: BaseDependencies) {
  return {
    async request(identity: Identity, raw: CorrectionReportScope & AiCorrectionRequest): Promise<AiCorrection> {
      const actor = parse(identitySchema, identity);
      const scope = parse(correctionReportScopeSchema.extend(aiCorrectionRequestSchema.shape).strict(), raw);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, actor, ['owner', 'operator']);
        await tx.query('SELECT gotchu.lock_ai_correction_model($1)', [scope.organizationId]);
        await lockCorrectionApplication(tx, scope);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`gotchu:ai-correction:${scope.organizationId}:${scope.applicationId}`]);
        const assessment = await correctionAssessment(tx, scope);
        const fingerprint = await correctionModelFingerprint(tx, scope.organizationId);
        const prior = await tx.query<AiCorrectionRow>(`SELECT ${correctionProjectionColumns} FROM gotchu.ai_correction_requests
          WHERE organization_id=$1 AND application_id=$2 AND report_id=$3 AND finding_id=$4 AND source_digest=$5
            AND state IN ('queued','running','prepared','reconciliation_required')`,
        [scope.organizationId, scope.applicationId, scope.reportId, scope.findingId, scope.expectedSourceDigest]);
        if (prior.rows[0]) return projectAiCorrection(prior.rows[0]);
        await correctionModelFingerprint(tx, scope.organizationId, true);
        const active = await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM gotchu.ai_correction_requests
          WHERE organization_id=$1 AND application_id=$2 AND state IN ('queued','running','reconciliation_required')`, [scope.organizationId, scope.applicationId]);
        if ((active.rows[0]?.count ?? 3) >= 3) throw new BackendError('correction_capacity_exceeded', 'Three corrections are already active for this application', 429);
        const suggestions = await tx.query<{ suggestion: unknown }>(`SELECT result->'candidateSuggestion' AS suggestion FROM gotchu.jobs
          WHERE organization_id=$1 AND application_id=$2 AND kind='investigation' AND state='succeeded'
            AND payload->>'correctionId' IS NULL AND payload->'subject'->>'kind'='finding'
            AND payload->'subject'->>'reportId'=$3 AND payload->'subject'->>'subjectId'=$4
          ORDER BY completed_at DESC,id DESC LIMIT 1`, [scope.organizationId, scope.applicationId, scope.reportId, scope.findingId]);
        const suggestion = parse(aiCorrectionInputSchema.shape.suggestion, suggestions.rows[0]?.suggestion ?? null);
        const id = randomUUID();
        // UUID placeholder has the same context size as the run ID assigned when the job starts.
        const context = selectCorrectionInput({ organizationId: scope.organizationId, applicationId: scope.applicationId, runId: id }, id, assessment, suggestion);
        const jobId = await enqueue(tx, { organizationId: scope.organizationId, applicationId: scope.applicationId, id: randomUUID(), kind: 'investigation',
          idempotencyKey: `ai-correction:${id}`, payload: { version: 2, correctionId: id,
            subject: { kind: 'finding', reportId: scope.reportId, subjectId: scope.findingId }, evidenceIds: assessment.finding.evidenceIds } });
        const inserted = await tx.query<AiCorrectionRow>(`INSERT INTO gotchu.ai_correction_requests
          (organization_id,application_id,id,job_id,report_id,finding_id,base_source_id,source_digest,requested_by,model_config_sha256,authorized_files,suggestion)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb) RETURNING ${correctionProjectionColumns}`,
        [scope.organizationId, scope.applicationId, id, jobId, scope.reportId, scope.findingId, assessment.source.id, assessment.source.digest,
          actor.userId, fingerprint, JSON.stringify(context.files.map(file => ({ path: file.path, sha256: file.sha256 }))), JSON.stringify(context.suggestion)]);
        const row = inserted.rows[0];
        if (!row) correctionBoundary('correction_unavailable');
        await audit(tx, scope.organizationId, actor.userId, 'ai_correction.requested', id, {
          applicationId: scope.applicationId, reportId: scope.reportId, findingId: scope.findingId, jobId, sourceDigest: assessment.source.digest,
          paths: context.files.map(file => file.path), modelConfigurationFingerprint: fingerprint,
        });
        return projectAiCorrection(row);
      });
    },
    async list(identity: Identity, raw: CorrectionReportScope): Promise<AiCorrection[]> {
      const scope = parse(correctionReportScopeSchema, raw);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity);
        const rows = await tx.query<AiCorrectionRow>(`SELECT ${correctionProjectionColumns} FROM gotchu.ai_correction_requests
          WHERE organization_id=$1 AND application_id=$2 AND report_id=$3 ORDER BY created_at DESC,id DESC LIMIT 50`,
        [scope.organizationId, scope.applicationId, scope.reportId]);
        return rows.rows.map(projectAiCorrection);
      });
    },
    async cancel(identity: Identity, raw: CorrectionReportScope & { correctionId: string }): Promise<AiCorrection> {
      const scope = parse(correctionReportScopeSchema.extend({ correctionId: z.uuid() }).strict(), raw);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity, ['owner', 'operator']);
        const selected = await tx.query<{ job_id: string }>(`SELECT job_id FROM gotchu.ai_correction_requests
          WHERE organization_id=$1 AND application_id=$2 AND report_id=$3 AND id=$4`,
        [scope.organizationId, scope.applicationId, scope.reportId, scope.correctionId]);
        const jobId = selected.rows[0]?.job_id;
        if (!jobId) throw new BackendError('not_found', 'Correction not found', 404);
        const jobs = await tx.query<{ state: string }>('SELECT state FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND id=$3 FOR UPDATE', [scope.organizationId, scope.applicationId, jobId]);
        const row = await correctionForJob(tx, { ...scope, jobId });
        if (!row) correctionBoundary('correction_unavailable');
        if (row.state === 'cancelled') return projectAiCorrection(row);
        if (row.state !== 'queued' && row.state !== 'running') throw new BackendError('correction_terminal', 'Correction is already terminal or requires reconciliation', 409);
        const runs = await tx.query<{ reserved: boolean }>(`UPDATE gotchu.agent_runs SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp())
          WHERE organization_id=$1 AND application_id=$2 AND job_id=$3 RETURNING (reserved_micros>0 OR tokens_reserved>0) AS reserved`, [scope.organizationId, scope.applicationId, jobId]);
        if (jobs.rows[0]?.state === 'queued') await tx.query(`UPDATE gotchu.jobs SET state='failed',result='{"reasonCode":"cancelled"}'::jsonb,
          completed_at=clock_timestamp(),lease_until=NULL WHERE organization_id=$1 AND application_id=$2 AND id=$3`, [scope.organizationId, scope.applicationId, jobId]);
        const state = runs.rows[0]?.reserved ? 'reconciliation_required' : 'cancelled';
        const updated = await tx.query<AiCorrectionRow>(`UPDATE gotchu.ai_correction_requests SET state=$4,reason_code='cancelled',updated_at=clock_timestamp()
          WHERE organization_id=$1 AND application_id=$2 AND id=$3 RETURNING ${correctionProjectionColumns}`,
        [scope.organizationId, scope.applicationId, row.id, state]);
        await audit(tx, scope.organizationId, identity.userId, 'ai_correction.cancel_requested', row.id, { applicationId: scope.applicationId, state });
        const result = updated.rows[0];
        if (!result) correctionBoundary('correction_unavailable');
        return projectAiCorrection(result);
      });
    },
    async markRunning(raw: CorrectionJobScope): Promise<void> {
      const scope = parse(correctionJobScopeSchema, raw);
      await deps.database.tenant(scope.organizationId, async tx => {
        await lockCorrectionJob(tx, scope);
        const row = await correctionForJob(tx, scope);
        if (!row) return;
        if (row.state !== 'queued' && row.state !== 'running') correctionBoundary('correction_not_active');
        await pinnedCorrectionContext(tx, row, row.id);
        await tx.query(`UPDATE gotchu.ai_correction_requests SET state='running',updated_at=clock_timestamp()
          WHERE organization_id=$1 AND application_id=$2 AND id=$3`, [scope.organizationId, scope.applicationId, row.id]);
      });
    },
  };
}
