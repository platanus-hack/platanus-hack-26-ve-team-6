import { randomUUID } from 'node:crypto';
import { assessmentReportSchema, assessmentRequestSchema, assessmentRunInputSchema, type AssessmentReport, type AssessmentRequest, type AssessmentRunInput } from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { z } from 'zod';
import { audit, authorize, BackendError, parse, type BaseDependencies, type Identity } from './core.js';
import { DEMO_ASSESSMENT_SCOPE } from './demo.js';
import { completeJob, enqueue } from './jobs.js';

export const MAX_ASSESSMENT_REPORT_BYTES = 1_048_576;
export const DEMO_ASSESSMENT_MAX_UNFINISHED = 3;
export const DEMO_ASSESSMENT_MAX_JOBS = 100;
const uuid = z.uuid().transform(id => id.toLowerCase());
const scopeSchema = z.object({ organizationId: uuid, applicationId: uuid }).strict();
const queueSchema = scopeSchema.extend({ ...assessmentRequestSchema.shape, idempotencyKey: z.string().min(1).max(200) });
const claimSchema = scopeSchema.extend({ jobId: uuid, leaseToken: uuid });
const runInputSchema = assessmentRunInputSchema.extend({ organizationId: uuid, applicationId: uuid, jobId: uuid });
const summarySchema = z.object({
  id: uuid, jobId: uuid, applicationName: assessmentReportSchema.shape.applicationName,
  ...assessmentRequestSchema.shape,
  startedAt: assessmentReportSchema.shape.startedAt, finishedAt: assessmentReportSchema.shape.finishedAt,
  findingCount: z.number().int().min(0).max(200),
}).strict();
export type AssessmentReportSummary = z.infer<typeof summarySchema>;
type Scope = z.infer<typeof scopeSchema>;
type Claim = z.infer<typeof claimSchema>;

async function requireApplication(tx: Transaction, scope: Scope) {
  const row = await tx.query('SELECT id FROM gotchu.applications WHERE organization_id=$1 AND id=$2', [scope.organizationId, scope.applicationId]);
  if (!row.rowCount) throw new BackendError('not_found', 'Application not found', 404);
}

async function lockTarget(tx: Transaction, scope: Scope): Promise<string | null> {
  const result = await tx.query<{ target_key: string | null }>('SELECT gotchu.lock_assessment_target($1,$2) AS target_key', [scope.organizationId, scope.applicationId]);
  return result.rows[0]?.target_key ?? null;
}

function sameRequest(a: AssessmentRunInput, b: AssessmentRunInput) {
  return a.organizationId === b.organizationId && a.applicationId === b.applicationId && a.jobId === b.jobId
    && a.targetKey === b.targetKey && a.mode === b.mode && a.revision === b.revision;
}

async function loadRequest(tx: Transaction, scope: Scope & { jobId: string }): Promise<AssessmentRunInput> {
  const result = await tx.query<{ input: unknown; payload: unknown; kind: string }>(`SELECT
    jsonb_build_object('organizationId',r.organization_id,'applicationId',r.application_id,'jobId',r.job_id,
      'targetKey',r.target_key,'mode',r.mode,'revision',r.revision) AS input, j.payload,j.kind
    FROM gotchu.assessment_requests r JOIN gotchu.jobs j
      ON j.organization_id=r.organization_id AND j.application_id=r.application_id AND j.id=r.job_id
    WHERE r.organization_id=$1 AND r.application_id=$2 AND r.job_id=$3`, [scope.organizationId, scope.applicationId, scope.jobId]);
  const row = result.rows[0];
  if (!row) throw new BackendError('assessment_request_not_found', 'No controlled assessment request is configured for this job', 409);
  const input = parse(runInputSchema, row.input);
  const payload = runInputSchema.safeParse(row.payload);
  if (row.kind !== 'audit' || !payload.success || !sameRequest(input, payload.data)) {
    throw new BackendError('assessment_scope_mismatch', 'Assessment request does not match durable job intent', 409);
  }
  return input;
}

async function currentRequest(tx: Transaction, claim: Claim): Promise<AssessmentRunInput> {
  // Lock target before job in queue, read and completion to keep lock order consistent.
  const targetKey = await lockTarget(tx, claim);
  const job = await tx.query(`SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND id=$3
    AND kind='audit' AND state='running' AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE`,
  [claim.organizationId, claim.applicationId, claim.jobId, claim.leaseToken]);
  if (!job.rowCount) throw new BackendError('stale_lease', 'Assessment requires the current audit job claim', 409);
  const input = await loadRequest(tx, claim);
  if (targetKey === null || input.targetKey !== targetKey) throw new BackendError('assessment_target_changed', 'The requested assessment target is no longer enabled', 409);
  return input;
}

export function createAssessmentService(deps: BaseDependencies) {
  return {
    async queue(identity: Identity, input: Scope & AssessmentRequest & { idempotencyKey: string }): Promise<{ jobId: string }> {
      const value = parse(queueSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator'], value.applicationId);
        await requireApplication(tx, value);
        const targetKey = await lockTarget(tx, value);
        if (!targetKey) throw new BackendError('assessment_target_not_configured', 'No operator-configured assessment target is enabled', 409);
        const prior = await tx.query<{ id: string }>(`SELECT id FROM gotchu.jobs
          WHERE organization_id=$1 AND application_id=$2 AND kind='audit' AND idempotency_key=$3`,
        [value.organizationId, value.applicationId, value.idempotencyKey]);
        const priorId = prior.rows[0]?.id;
        if (priorId) {
          let request: AssessmentRunInput;
          try { request = await loadRequest(tx, { ...value, jobId: priorId }); }
          catch (error) {
            if (error instanceof BackendError && error.code === 'assessment_request_not_found') throw new BackendError('idempotency_conflict', 'This key belongs to a different audit request', 409);
            throw error;
          }
          if (request.mode !== value.mode || request.revision !== value.revision || request.targetKey !== targetKey) {
            throw new BackendError('idempotency_conflict', 'This key already identifies a different mode, revision or target', 409);
          }
          return { jobId: priorId };
        }
        if (value.organizationId === DEMO_ASSESSMENT_SCOPE.organizationId && value.applicationId === DEMO_ASSESSMENT_SCOPE.applicationId) {
          // The target lock serializes counts and insertion across all API instances.
          const counts = await tx.query<{ total: number; unfinished: number }>(`SELECT count(*)::int AS total,
            count(*) FILTER (WHERE state IN ('queued','running'))::int AS unfinished FROM gotchu.jobs
            WHERE organization_id=$1 AND application_id=$2 AND kind='audit'`, [value.organizationId, value.applicationId]);
          const count = counts.rows[0];
          if (!count) throw new Error('Assessment capacity query returned no row');
          if (count.total >= DEMO_ASSESSMENT_MAX_JOBS) throw new BackendError('demo_assessment_limit', 'Controlled demo lifetime job limit reached', 429);
          if (count.unfinished >= DEMO_ASSESSMENT_MAX_UNFINISHED) throw new BackendError('assessment_capacity_exceeded', 'Controlled demo assessment capacity is full', 429);
        }
        const request = parse(runInputSchema, { organizationId: value.organizationId, applicationId: value.applicationId, jobId: randomUUID(), targetKey, mode: value.mode, revision: value.revision });
        const jobId = await enqueue(tx, { organizationId: value.organizationId, applicationId: value.applicationId, id: request.jobId, kind: 'audit', idempotencyKey: value.idempotencyKey, payload: request });
        if (jobId !== request.jobId) throw new BackendError('idempotency_conflict', 'Concurrent audit reused this key', 409);
        await tx.query(`INSERT INTO gotchu.assessment_requests(organization_id,application_id,job_id,target_key,mode,revision)
          VALUES ($1,$2,$3,$4,$5,$6)`, [value.organizationId, value.applicationId, jobId, targetKey, value.mode, value.revision]);
        await audit(tx, value.organizationId, identity.userId, 'assessment.queued', jobId, { mode: value.mode, revision: value.revision, targetKey });
        return { jobId };
      });
    },

    async getTarget(identity: Identity, input: Scope): Promise<{ targetKey: string } | null> {
      const scope = parse(scopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity, undefined, scope.applicationId);
        await requireApplication(tx, scope);
        const result = await tx.query<{ target_key: string }>('SELECT target_key FROM gotchu.assessment_targets WHERE organization_id=$1 AND application_id=$2 AND enabled', [scope.organizationId, scope.applicationId]);
        return result.rows[0] ? { targetKey: result.rows[0].target_key } : null;
      });
    },

    async list(identity: Identity, input: Scope & { limit?: number }): Promise<AssessmentReportSummary[]> {
      const value = parse(scopeSchema.extend({ limit: z.number().int().min(1).max(50).default(20) }), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, undefined, value.applicationId);
        await requireApplication(tx, value);
        const result = await tx.query<{ summary: unknown }>(`SELECT jsonb_build_object('id',id,'jobId',job_id,'mode',mode,'revision',revision,
          'applicationName',body->>'applicationName','startedAt',body->>'startedAt','finishedAt',body->>'finishedAt',
          'findingCount',coalesce(jsonb_array_length(body->'internal'->'findings'),0)+coalesce(jsonb_array_length(body->'external'->'findings'),0)) AS summary
          FROM gotchu.assessment_reports WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at DESC,id LIMIT $3`,
        [value.organizationId, value.applicationId, value.limit]);
        return result.rows.map(row => parse(summarySchema, row.summary));
      });
    },

    async get(identity: Identity, input: Scope & { reportId: string }): Promise<AssessmentReport> {
      const value = parse(scopeSchema.extend({ reportId: uuid }), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, undefined, value.applicationId);
        const result = await tx.query<{ body: unknown }>('SELECT body FROM gotchu.assessment_reports WHERE organization_id=$1 AND application_id=$2 AND id=$3', [value.organizationId, value.applicationId, value.reportId]);
        if (!result.rows[0]) throw new BackendError('not_found', 'Assessment report not found', 404);
        return parse(assessmentReportSchema, result.rows[0].body);
      });
    },

    async getRequest(input: Claim): Promise<AssessmentRunInput> {
      const claim = parse(claimSchema, input);
      return deps.database.tenant(claim.organizationId, tx => currentRequest(tx, claim));
    },

    async recordResult(input: { input: AssessmentRunInput; leaseToken: string; report: unknown }): Promise<{ reportId: string }> {
      const value = parse(z.object({ input: runInputSchema, leaseToken: uuid, report: z.unknown() }).strict(), input);
      const validated = assessmentReportSchema.safeParse(value.report);
      if (!validated.success) throw new BackendError('assessment_invalid_report', 'Assessment output does not match the report contract', 409);
      const report = validated.data;
      const serialized = JSON.stringify(report);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_ASSESSMENT_REPORT_BYTES) throw new BackendError('assessment_report_too_large', 'Assessment report exceeds the storage bound', 413);
      const request = value.input;
      if (report.organizationId !== request.organizationId || report.applicationId !== request.applicationId || report.jobId !== request.jobId
        || report.mode !== request.mode || report.revision !== request.revision) {
        throw new BackendError('assessment_scope_mismatch', 'Assessment output does not match its request scope', 409);
      }
      return deps.database.tenant(request.organizationId, async tx => {
        const persisted = await currentRequest(tx, { organizationId: request.organizationId, applicationId: request.applicationId, jobId: request.jobId, leaseToken: value.leaseToken });
        if (!sameRequest(request, persisted)) throw new BackendError('assessment_scope_mismatch', 'Runner input does not match the persisted request', 409);
        // JSONB serialization includes whitespace; enforce that bound explicitly too.
        const size = await tx.query<{ bytes: number }>('SELECT octet_length($1::jsonb::text) AS bytes', [serialized]);
        if (!size.rows[0] || size.rows[0].bytes > MAX_ASSESSMENT_REPORT_BYTES) throw new BackendError('assessment_report_too_large', 'Assessment report exceeds the storage bound', 413);
        await tx.query(`INSERT INTO gotchu.assessment_reports(organization_id,application_id,id,job_id,target_key,mode,revision,body)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [request.organizationId, request.applicationId, report.id, request.jobId, request.targetKey, request.mode, request.revision, serialized]);
        await completeJob(tx, { organizationId: request.organizationId, jobId: request.jobId, leaseToken: value.leaseToken, result: { status: 'completed', reportId: report.id } });
        await audit(tx, request.organizationId, 'coordinator', 'assessment.recorded', report.id, { jobId: request.jobId });
        return { reportId: report.id };
      });
    },
  };
}
