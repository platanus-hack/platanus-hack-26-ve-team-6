import { createHash, randomUUID } from 'node:crypto';
import {
  customerAssessmentReportSchema,
  investigationActionSchema,
  investigationDataScopeSchema,
  investigationRunSchema,
  investigationModelSettingsSchema,
  investigationSubjectSchema,
  operationObservationSchema,
  requestInvestigationSchema,
  type InvestigationSubject,
} from '@gotchu/contracts';
import type { Database, Transaction } from '@gotchu/database';
import { z } from 'zod';
import { audit, authorize, BackendError, canonicalJson, parse, type Identity } from './core.js';
import { enqueue } from './jobs.js';

const uuid = z.uuid();
const payloadSchema = z.union([
  z.object({ incidentId: uuid, evidenceIds: z.array(uuid).min(1).max(20) }).strict(),
  z.object({ version: z.literal(2), subject: investigationSubjectSchema, evidenceIds: z.array(uuid).min(1).max(20), resumeOf: uuid.optional() }).strict(),
]);
const severityRank = { unknown: 0, informational: 0, info: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;

async function applicationActive(tx: Parameters<Parameters<Database['tenant']>[1]>[0], organizationId: string, applicationId: string) {
  const result = await tx.query<{ archived: boolean }>('SELECT archived FROM gotchu.applications WHERE organization_id=$1 AND id=$2', [organizationId, applicationId]);
  const row = result.rows[0];
  if (!row) throw new BackendError('not_found', 'Application not found', 404);
  if (row.archived) throw new BackendError('application_archived', 'Restore the application before investigating it', 409);
}

async function requireInvestigationConsent(tx: Transaction, organizationId: string, requiredScopes: z.infer<typeof investigationDataScopeSchema>[]) {
  const rows = await tx.query<{ model_opt_in: boolean; model_budget_micros: string; model_token_budget: string; provider: string | null; secret_ref: string | null; consent: boolean | null; data_scopes: unknown }>(`SELECT o.model_opt_in,o.model_budget_micros,o.model_token_budget,s.provider,s.secret_ref,
    s.consent_to_external_processing AS consent,s.data_scopes FROM gotchu.organizations o
    LEFT JOIN gotchu.investigation_model_settings s ON s.organization_id=o.id WHERE o.id=$1`, [organizationId]);
  const row = rows.rows[0];
  const scopes = row ? investigationModelSettingsSchema.shape.dataScopes.safeParse(row.data_scopes ?? []) : null;
  if (!row || !row.model_opt_in || !row.consent || !scopes?.success || !requiredScopes.every(scope => scopes.data.includes(scope))
    || row.provider === null || row.provider !== 'openai_compatible' && !row.secret_ref
    || BigInt(row.model_budget_micros) <= 0n || BigInt(row.model_token_budget) <= 0n) {
    throw new BackendError('investigation_disabled', 'Model investigation is not configured and consented for this data category', 409);
  }
}

async function materialEvidence(tx: Parameters<Parameters<Database['tenant']>[1]>[0], scope: { organizationId: string; applicationId: string }, subject: InvestigationSubject): Promise<string[]> {
  if (subject.kind === 'finding') {
    const rows = await tx.query<{ body: unknown }>('SELECT body FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND id=$3', [scope.organizationId, scope.applicationId, subject.reportId]);
    const report = rows.rows[0] ? customerAssessmentReportSchema.safeParse(rows.rows[0].body) : null;
    if (!report?.success || report.data.id !== subject.reportId) throw new BackendError('not_found', 'Finding report is not available in this application', 404);
    const finding = [...report.data.internal?.findings ?? [], ...report.data.external?.findings ?? []].find(item => item.id === subject.subjectId);
    if (!finding) throw new BackendError('not_found', 'Finding is not part of the selected report', 404);
    if (severityRank[finding.severity] < severityRank.medium) throw new BackendError('finding_not_material', 'Only medium or higher findings can start an investigation', 409);
    return finding.evidenceIds;
  }
  if (subject.kind === 'alert') {
    const rows = await tx.query<{ body: unknown; state: string; fresh: boolean }>(`SELECT o.body,a.state,o.expires_at>clock_timestamp() AS fresh
      FROM gotchu.operation_alerts a JOIN gotchu.operation_observations o ON o.organization_id=a.organization_id
        AND o.application_id=a.application_id AND o.id=a.observation_id
      WHERE a.organization_id=$1 AND a.application_id=$2 AND a.id=$3`, [scope.organizationId, scope.applicationId, subject.subjectId]);
    const row = rows.rows[0];
    const observation = row ? operationObservationSchema.safeParse(row.body) : null;
    if (!row || !observation?.success || row.state === 'resolved') throw new BackendError('not_found', 'Alert is not available for investigation', 404);
    if (!row.fresh || severityRank[observation.data.severity] < severityRank.medium) throw new BackendError('alert_not_material', 'Only fresh medium or higher alerts can start an investigation', 409);
    return [subject.subjectId];
  }
  const rows = await tx.query<{ severity: string; status: string; evidence: unknown }>('SELECT severity,status,evidence FROM gotchu.incidents WHERE organization_id=$1 AND application_id=$2 AND id=$3', [scope.organizationId, scope.applicationId, subject.subjectId]);
  const row = rows.rows[0];
  const incident = row ? z.object({ severity: z.enum(['info','low','medium','high','critical']), status: z.enum(['open','resolved']), evidence: z.array(uuid).min(1).max(20) }).safeParse(row) : null;
  if (!incident?.success || incident.data.status === 'resolved') throw new BackendError('not_found', 'Incident is not available for investigation', 404);
  if (severityRank[incident.data.severity] < severityRank.medium) throw new BackendError('incident_not_material', 'Only medium or higher incidents can start an investigation', 409);
  return incident.data.evidence;
}

function publicRun(row: {
  organization_id: string; application_id: string; id: string; payload: unknown; state: 'queued'|'running'|'succeeded'|'failed'; result: unknown;
  created_at: Date; cancel_requested_at: Date | null; tokens_spent: string; tokens_reserved: string; spent_micros: string; reserved_micros: string;
}) {
  const payload = payloadSchema.parse(row.payload);
  const subject = 'version' in payload ? payload.subject : { kind: 'incident' as const, subjectId: payload.incidentId };
  const result = z.object({
    status: z.enum(['investigated','inconclusive','delayed']).optional(),
    assessment: z.enum(['candidate_issue','no_issue_supported','inconclusive']).optional(),
    summary: z.string().max(2_000).optional(), citedEvidenceIds: z.array(uuid).max(20).optional(),
    hypotheses: investigationRunSchema.shape.hypotheses.optional(),
    candidateSuggestion: investigationRunSchema.shape.candidateSuggestion.optional(),
    reasonCode: z.string().max(100).optional(),
  }).passthrough().safeParse(row.result);
  const body = result.success ? result.data : undefined;
  const reserved = Number(row.reserved_micros);
  const tokensReserved = Number(row.tokens_reserved);
  const terminal = row.state === 'succeeded' || row.state === 'failed';
  const status = reserved > 0 || tokensReserved > 0 ? 'reconciliation_required'
    : body?.reasonCode === 'cancelled' || row.cancel_requested_at !== null && terminal ? 'cancelled'
      : row.state === 'queued' ? 'pending' : row.state === 'running' ? 'investigating' : body?.status ?? 'inconclusive';
  return investigationRunSchema.parse({
    organizationId: row.organization_id, applicationId: row.application_id, jobId: row.id, subject,
    state: row.state, status, summary: body?.summary ?? null, assessment: body?.assessment ?? null,
    citedEvidenceIds: body?.citedEvidenceIds ?? [], hypotheses: body?.hypotheses ?? [], candidateSuggestion: body?.candidateSuggestion ?? null,
    tokensSpent: Number(row.tokens_spent), costMicroUsd: Number(row.spent_micros), reservedCostMicroUsd: reserved,
    reservedTokens: tokensReserved,
    createdAt: row.created_at.toISOString(), cancelRequested: row.cancel_requested_at !== null,
  });
}

export function createInvestigationService(database: Database) {
  return {
    async request(identity: Identity, raw: unknown) {
      const value = parse(requestInvestigationSchema, raw);
      return database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner','operator']);
        await applicationActive(tx, value.organizationId, value.applicationId);
        const requiredScopes = value.subject.kind === 'finding' ? ['finding_details'] as const : ['runtime_summaries'] as const;
        await requireInvestigationConsent(tx, value.organizationId, [...requiredScopes]);
        const evidenceIds = await materialEvidence(tx, value, value.subject);
        const payload = { version: 2 as const, subject: value.subject, evidenceIds };
        const digest = createHash('sha256').update(canonicalJson(payload)).digest('hex');
        const id = randomUUID();
        const jobId = await enqueue(tx, { organizationId: value.organizationId, applicationId: value.applicationId, id, kind: 'investigation',
          idempotencyKey: `investigate:${value.subject.kind}:${value.subject.subjectId}:${digest}`, payload });
        const job = await tx.query<{ state: 'queued'|'running'|'succeeded'|'failed' }>('SELECT state FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND id=$3', [value.organizationId, value.applicationId, jobId]);
        await audit(tx, value.organizationId, identity.userId, 'investigation.requested', jobId, { subjectKind: value.subject.kind, subjectId: value.subject.subjectId, evidenceCount: evidenceIds.length });
        return investigationActionSchema.parse({ status: jobId === id ? 'accepted' : (job.rows[0]?.state === 'queued' || job.rows[0]?.state === 'running' ? 'already_active' : 'already_exists') });
      });
    },
    async list(identity: Identity, input: { organizationId: string; applicationId: string }) {
      const value = parse(z.object({ organizationId: uuid, applicationId: uuid }).strict(), input);
      return database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity);
        const rows = await tx.query<{ organization_id: string; application_id: string; id: string; payload: unknown; state: 'queued'|'running'|'succeeded'|'failed'; result: unknown; created_at: Date; cancel_requested_at: Date | null; tokens_spent: string; tokens_reserved: string; spent_micros: string; reserved_micros: string }>(`SELECT j.organization_id,j.application_id,j.id,j.payload,j.state,j.result,j.created_at,
          r.cancel_requested_at,COALESCE(r.tokens_spent,0)::text AS tokens_spent,COALESCE(r.tokens_reserved,0)::text AS tokens_reserved,COALESCE(r.spent_micros,0)::text AS spent_micros,
          COALESCE(r.reserved_micros,0)::text AS reserved_micros
          FROM gotchu.jobs j LEFT JOIN gotchu.agent_runs r ON r.organization_id=j.organization_id AND r.application_id=j.application_id AND r.job_id=j.id
          WHERE j.organization_id=$1 AND j.application_id=$2 AND j.kind='investigation' ORDER BY j.created_at DESC,j.id DESC LIMIT 50`, [value.organizationId, value.applicationId]);
        return rows.rows.map(publicRun);
      });
    },
    async cancel(identity: Identity, input: { organizationId: string; applicationId: string; jobId: string }) {
      const value = parse(z.object({ organizationId: uuid, applicationId: uuid, jobId: uuid }).strict(), input);
      return database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner','operator']);
        const row = await tx.query<{ state: string; run_id: string | null }>(`SELECT j.state,r.id AS run_id FROM gotchu.jobs j LEFT JOIN gotchu.agent_runs r
          ON r.organization_id=j.organization_id AND r.application_id=j.application_id AND r.job_id=j.id
          WHERE j.organization_id=$1 AND j.application_id=$2 AND j.id=$3 AND j.kind='investigation'`, [value.organizationId, value.applicationId, value.jobId]);
        const current = row.rows[0];
        if (!current) throw new BackendError('not_found', 'Investigation not found', 404);
        if (current.state === 'queued') {
          const cancelled = await tx.query("UPDATE gotchu.jobs SET state='failed',result=$3::jsonb,completed_at=clock_timestamp(),lease_until=NULL WHERE organization_id=$1 AND id=$2 AND state='queued' RETURNING id", [value.organizationId, value.jobId, JSON.stringify({ reasonCode: 'cancelled' })]);
          if (!cancelled.rowCount) throw new BackendError('investigation_terminal', 'Investigation is already terminal', 409);
        } else if (current.state === 'running' && current.run_id) {
          const cancelled = await tx.query("UPDATE gotchu.agent_runs SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()) WHERE organization_id=$1 AND id=$2 AND state='running' RETURNING id", [value.organizationId, current.run_id]);
          if (!cancelled.rowCount) throw new BackendError('investigation_terminal', 'Investigation is already terminal', 409);
        } else throw new BackendError('investigation_terminal', 'Investigation is already terminal', 409);
        await audit(tx, value.organizationId, identity.userId, 'investigation.cancel_requested', value.jobId, {});
        return investigationActionSchema.parse({ status: 'cancel_requested' });
      });
    },
    async resume(identity: Identity, input: { organizationId: string; applicationId: string; jobId: string }) {
      const value = parse(z.object({ organizationId: uuid, applicationId: uuid, jobId: uuid }).strict(), input);
      return database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner','operator']);
        const prior = await tx.query<{ payload: unknown; state: string; result: unknown; run_id: string | null; reserved_micros: string | null; tokens_reserved: string | null }>(`SELECT j.payload,j.state,j.result,r.id AS run_id,r.reserved_micros,r.tokens_reserved
          FROM gotchu.jobs j LEFT JOIN gotchu.agent_runs r ON r.organization_id=j.organization_id AND r.application_id=j.application_id AND r.job_id=j.id
          WHERE j.organization_id=$1 AND j.application_id=$2 AND j.id=$3 AND j.kind='investigation'`, [value.organizationId, value.applicationId, value.jobId]);
        const previous = prior.rows[0];
        if (!previous) throw new BackendError('not_found', 'Investigation not found', 404);
        if (previous.state === 'queued' || previous.state === 'running') return investigationActionSchema.parse({ status: 'already_active' });
        if ((previous.reserved_micros !== null && BigInt(previous.reserved_micros) > 0n)
          || (previous.tokens_reserved !== null && BigInt(previous.tokens_reserved) > 0n)) {
          throw new BackendError('investigation_reconciliation_required', 'Uncertain model usage is still reserved and cannot be resumed', 409);
        }
        const oldResult = z.object({ status: z.enum(['investigated','inconclusive','delayed']).optional() }).passthrough().safeParse(previous.result);
        if (oldResult.success && oldResult.data.status === 'investigated') throw new BackendError('investigation_complete', 'This investigation already has a completed explanation', 409);
        const payload = payloadSchema.parse(previous.payload);
        const subject = 'version' in payload ? payload.subject : { kind: 'incident' as const, subjectId: payload.incidentId };
        const evidenceIds = payload.evidenceIds;
        const priorResumes = await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='investigation' AND payload->>'resumeOf'=$3", [value.organizationId, value.applicationId, value.jobId]);
        const activeResume = await tx.query("SELECT 1 FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='investigation' AND payload->>'resumeOf'=$3 AND state IN ('queued','running') LIMIT 1", [value.organizationId, value.applicationId, value.jobId]);
        if (activeResume.rowCount) return investigationActionSchema.parse({ status: 'already_active' });
        const next = (priorResumes.rows[0]?.count ?? 0) + 1;
        const id = randomUUID();
        await enqueue(tx, { organizationId: value.organizationId, applicationId: value.applicationId, id, kind: 'investigation',
          idempotencyKey: `resume:${value.jobId}:${next}`, payload: { version: 2, subject, evidenceIds, resumeOf: value.jobId } });
        await audit(tx, value.organizationId, identity.userId, 'investigation.resumed', id, { resumedFrom: value.jobId, restartFromEvidence: true });
        return investigationActionSchema.parse({ status: 'resumed' });
      });
    },
  };
}
