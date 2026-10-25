import { createHash } from 'node:crypto';
import {
  assertCapabilityAllowsRead, assertCapabilityScope, CODING_SYSTEM_INSTRUCTION, investigationInputSchema, runReadToolSchema,
  safeCheckpointSchema, verifyRunCapability,
  type EvidenceRecord, type RunScope, type SafeInvestigationCheckpoint, type VerifiedRunCapability,
} from '@gotchu/agent';
import { createModelEndpointValidator, createRunService, loadAiCorrectionInput, modelConfigurationFingerprint, storeAiCorrectionPatch, verifyModelProbeToken, type ModelEndpointValidator, type ModelProbeClaims, type ModelSecretStore } from '@gotchu/backend';
import { aiCorrectionPatchSchema, customerAssessmentReportSchema, customerSourceSnapshotSchema, eventTypeSchema, investigationDataScopeSchema, investigationModelEndpointSchema, investigationModelProbeRequestSchema, investigationModelProbeResultSchema, investigationModelProviderForPreset, investigationProviderCatalog, investigationProviderPresetIdSchema, modelProviderSchema, operationObservationSchema } from '@gotchu/contracts';
import type { Database, Transaction } from '@gotchu/database';
import type { CryptoKey } from 'jose';
import { z } from 'zod';
import {
  checkpointRequestSchema, gatewayJobPayloadSchema, gatewayOperationSchema,
  inputRequestSchema, modelRequestSchema, readRequestSchema, type GatewayOperation,
} from './contracts.js';
import { GatewayError } from './errors.js';
import { createModelPort, ModelProviderError, type ModelCompletion, type ModelCompletionRequest, type ModelPort } from './model-provider.js';
import { buildInvestigationReadMenu, INVESTIGATION_SYSTEM_INSTRUCTION, investigationReadDataScope, MAX_ADDITIONAL_TOOL_CALLS } from './investigation-prompt.js';
import { boundedInvestigationContext } from './investigation-context.js';

const runRowSchema = z.object({
  applicationId: z.uuid(), state: z.enum(['pending', 'running', 'succeeded', 'unavailable', 'failed']),
  deadline: z.date(), payload: z.unknown(), cancelRequested: z.boolean(),
  jobState: z.enum(['queued', 'running', 'succeeded', 'failed']),
  jobLeaseUntil: z.date().nullable(),
});
const eventRowSchema = z.object({
  id: z.uuid(), type: eventTypeSchema, source: z.literal('application'),
  outcome: z.enum(['success', 'failure', 'blocked', 'unknown']),
  payloadId: z.uuid(), receivedAt: z.date(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const incidentSchema = z.object({
  ruleId: z.enum(['auth.login_failures.v1.account', 'auth.login_failures.v1.ip']),
  status: z.enum(['open', 'resolved']),
  evidence: z.array(z.uuid()).min(1).max(100),
});
const storedReadSchema = readRequestSchema.pick({ callType: true, name: true, evidenceId: true }).extend({ response: z.unknown() });
const safeEvidenceSchema = z.object({
  evidenceId: z.uuid(), organizationId: z.uuid(), applicationId: z.uuid(), runId: z.uuid(),
  source: z.enum(['signed_application_event.v1','customer_assessment_evidence.v1','runtime_observation.v1','application_context.v1','triage_revision.v1','validation_result.v1']),
  collectedAt: z.iso.datetime(), excerpt: z.string().max(1_200), truncated: z.boolean(),
}).strict();

function redactSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?key|client[_-]?secret|token|secret|password|cookie)["']?\s*[:=]\s*)(["'`]?)[^\s,;"'`}\]]+/gi, '$1$2[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]{20,})\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .slice(0, 1_200);
}

const sensitivePropertyNames = new Set(['authorization', 'apikey', 'accesskey', 'clientsecret', 'secret', 'secretref', 'password', 'cookie', 'privatekey', 'credential', 'credentials', 'token', 'accesstoken', 'refreshtoken']);
function redactStructuredValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactStructuredValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, sensitivePropertyNames.has(key.toLowerCase().replaceAll(/[-_]/g, '')) ? '[REDACTED]' : redactStructuredValue(item),
    ]));
  }
  return value;
}

export function redactEvidenceExcerpt(value: unknown): string {
  return redactSecrets(JSON.stringify(redactStructuredValue(value)) ?? 'null');
}

function evidenceRecord(scope: RunScope, evidenceId: string, source: z.infer<typeof safeEvidenceSchema>['source'], excerpt: unknown, collectedAt = new Date().toISOString()): EvidenceRecord {
  return safeEvidenceSchema.parse({ ...scope, evidenceId, source, collectedAt, excerpt: redactEvidenceExcerpt(excerpt), truncated: true });
}

function findingInReport(report: z.infer<typeof customerAssessmentReportSchema>, findingId: string) {
  return [...report.internal?.findings ?? [], ...report.external?.findings ?? []].find(finding => finding.id === findingId);
}

/** Matches the worker's deterministic required-evidence identity; never trusts callType alone. */
export function requiredEvidenceCallId(runId: string, evidenceId: string): string {
  const hex = createHash('sha256').update(`${runId}\0required-evidence\0${evidenceId}`).digest('hex').slice(0, 32);
  const variant = (Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8;
  const value = `${hex.slice(0, 12)}5${hex.slice(13, 16)}${variant.toString(16)}${hex.slice(17)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

// Reuse the actual backend APIs in the authorization transaction. Their mutations, the
// read ledger, and revocations serialize on the same run row and commit together.
function transactionRuns(database: Database, organizationId: string, tx: Transaction) {
  return createRunService({ database: {
    ...database,
    tenant: async (id, work) => {
      if (id !== organizationId) throw new Error('Cross-tenant nested transaction');
      return work(tx);
    },
  } });
}

type GatewayJob = z.infer<typeof gatewayJobPayloadSchema>;

async function getReportFinding(tx: Transaction, scope: RunScope, job: GatewayJob) {
  if (!('version' in job) || job.subject.kind !== 'finding') throw new GatewayError('tool_out_of_scope', 403);
  const rows = await tx.query<{ body: unknown }>('SELECT body FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND id=$3', [scope.organizationId, scope.applicationId, job.subject.reportId]);
  const report = rows.rows[0] ? customerAssessmentReportSchema.safeParse(rows.rows[0].body) : null;
  if (!report?.success || report.data.id !== job.subject.reportId || report.data.applicationId !== scope.applicationId || report.data.organizationId !== scope.organizationId) {
    throw new GatewayError('evidence_unavailable', 503);
  }
  const finding = findingInReport(report.data, job.subject.subjectId);
  if (!finding || finding.evidenceIds.length !== job.evidenceIds.length || finding.evidenceIds.some(id => !job.evidenceIds.includes(id))) {
    throw new GatewayError('evidence_unavailable', 503);
  }
  return { report: report.data, finding };
}

async function loadRuntimeEvents(tx: Transaction, scope: RunScope, job: GatewayJob) {
  const incidentId = 'version' in job ? job.subject.kind === 'incident' ? job.subject.subjectId : null : job.incidentId;
  if (!incidentId) return [] as z.infer<typeof eventRowSchema>[];
  const incidentRows = await tx.query('SELECT rule_id AS "ruleId",status,evidence FROM gotchu.incidents WHERE organization_id=$1 AND application_id=$2 AND id=$3', [scope.organizationId, scope.applicationId, incidentId]);
  const incident = incidentSchema.safeParse(incidentRows.rows[0]);
  if (!incident.success || incident.data.status !== 'open' || incident.data.evidence.length !== job.evidenceIds.length || job.evidenceIds.some(id => !incident.data.evidence.includes(id))) {
    throw new GatewayError('evidence_unavailable', 503);
  }
  const eventRows = await tx.query(`SELECT e.id,e.payload->>'id' AS "payloadId",e.payload->>'type' AS type,
    e.payload->>'source' AS source,e.payload->>'outcome' AS outcome,e.received_at AS "receivedAt",e.payload_hash AS "payloadHash"
    FROM gotchu.events e JOIN gotchu.integrations i ON i.organization_id=e.organization_id AND i.application_id=e.application_id
      AND i.id=e.integration_id AND i.kind='signed_events'
    WHERE e.organization_id=$1 AND e.application_id=$2 AND e.id=ANY($3::uuid[]) ORDER BY e.id LIMIT 21`, [scope.organizationId, scope.applicationId, job.evidenceIds]);
  const events = z.array(eventRowSchema).safeParse(eventRows.rows);
  if (!events.success || events.data.length !== job.evidenceIds.length || new Set(events.data.map(event => event.id)).size !== job.evidenceIds.length
    || events.data.some(event => event.payloadId.toLowerCase() !== event.id)) throw new GatewayError('evidence_unavailable', 503);
  return events.data;
}

async function validateMaterialJob(tx: Transaction, scope: RunScope, job: GatewayJob) {
  if (!('version' in job)) return loadRuntimeEvents(tx, scope, job);
  if (job.subject.kind === 'finding') {
    await getReportFinding(tx, scope, job);
    return [] as z.infer<typeof eventRowSchema>[];
  }
  if (job.subject.kind === 'incident') return loadRuntimeEvents(tx, scope, job);
  if (job.evidenceIds.length !== 1 || job.evidenceIds[0] !== job.subject.subjectId) throw new GatewayError('evidence_unavailable', 503);
  const rows = await tx.query<{ body: unknown; state: string; fresh: boolean }>(`SELECT o.body,a.state,o.expires_at>clock_timestamp() AS fresh FROM gotchu.operation_alerts a
    JOIN gotchu.operation_observations o ON o.organization_id=a.organization_id AND o.application_id=a.application_id AND o.id=a.observation_id
    WHERE a.organization_id=$1 AND a.application_id=$2 AND a.id=$3`, [scope.organizationId, scope.applicationId, job.subject.subjectId]);
  const alert = rows.rows[0];
  const observation = alert ? operationObservationSchema.safeParse(alert.body) : null;
  if (!alert || !observation?.success || alert.state === 'resolved' || !alert.fresh
    || !['medium', 'high', 'critical'].includes(observation.data.severity)) throw new GatewayError('evidence_unavailable', 503);
  return [] as z.infer<typeof eventRowSchema>[];
}

async function readScopedTool(tx: Transaction, scope: RunScope, job: GatewayJob, name: z.infer<typeof runReadToolSchema>, evidenceId: string, events: readonly z.infer<typeof eventRowSchema>[]) {
  if (!job.evidenceIds.includes(evidenceId)) throw new GatewayError('capability_read_denied', 403);
  if (name === 'evidence.read' || name === 'auth.events.read') {
    if ('version' in job && job.subject.kind === 'finding') {
      const { report, finding } = await getReportFinding(tx, scope, job);
      const evidence = [...report.internal?.evidence ?? [], ...report.external?.evidence ?? []].find(item => item.id === evidenceId);
      if (!evidence || !finding.evidenceIds.includes(evidenceId)) throw new GatewayError('evidence_unavailable', 503);
      if (name === 'auth.events.read') throw new GatewayError('tool_out_of_scope', 403);
      return evidenceRecord(scope, evidenceId, 'customer_assessment_evidence.v1', {
        kind: evidence.kind, origin: evidence.origin, locator: evidence.locator,
        checksum: evidence.checksum, tool: evidence.tool, snapshotRef: evidence.snapshotRef,
      }, evidence.collectedAt);
    }
    if ('version' in job && job.subject.kind === 'alert') {
      if (name === 'auth.events.read' || evidenceId !== job.subject.subjectId) throw new GatewayError('tool_out_of_scope', 403);
      const rows = await tx.query<{ body: unknown }>(`SELECT o.body FROM gotchu.operation_alerts a JOIN gotchu.operation_observations o
        ON o.organization_id=a.organization_id AND o.application_id=a.application_id AND o.id=a.observation_id
        WHERE a.organization_id=$1 AND a.application_id=$2 AND a.id=$3`, [scope.organizationId, scope.applicationId, evidenceId]);
      const observation = rows.rows[0] ? operationObservationSchema.safeParse(rows.rows[0].body) : null;
      if (!observation?.success) throw new GatewayError('evidence_unavailable', 503);
      return evidenceRecord(scope, evidenceId, 'runtime_observation.v1', {
        kind: observation.data.kind, severity: observation.data.severity, summary: observation.data.summary,
        confidence: observation.data.confidence,
        evidence: observation.data.evidence.map(item => ({ source: item.source, reference: item.reference, checksum: item.checksum })),
      }, observation.data.observedAt);
    }
    const event = events.find(item => item.id === evidenceId);
    if (!event || name === 'auth.events.read' && !event.type.startsWith('auth.')) throw new GatewayError('tool_out_of_scope', 403);
    return evidenceRecord(scope, event.id, 'signed_application_event.v1', {
      type: event.type, outcome: event.outcome, payloadSha256: event.payloadHash,
    }, event.receivedAt.toISOString());
  }
  if (name === 'finding.details.read' || name === 'source.excerpt.read' || name === 'assessment.diff.read' || name === 'validation.results.read') {
    const { report, finding } = await getReportFinding(tx, scope, job);
    if (!finding.evidenceIds.includes(evidenceId)) throw new GatewayError('tool_out_of_scope', 403);
    if (name === 'finding.details.read') return evidenceRecord(scope, evidenceId, 'customer_assessment_evidence.v1', {
      findingId: finding.id, ruleId: finding.ruleId, title: finding.title, location: finding.location,
      description: finding.description, severity: finding.severity, confidence: finding.confidence,
      exploitability: finding.exploitability, impact: finding.impact, recommendation: finding.recommendation,
      limitations: finding.limitations,
    }, report.finishedAt);
    if (name === 'assessment.diff.read') {
      const comparison = report.comparison.find(item => item.key === finding.correlationKey);
      if (!comparison) throw new GatewayError('evidence_unavailable', 503);
      return evidenceRecord(scope, evidenceId, 'customer_assessment_evidence.v1', { findingId: finding.id, comparison }, report.finishedAt);
    }
    if (name === 'validation.results.read') {
      const rows = await tx.query<{ state: string; reason: string | null; validation_run_id: string }>(`SELECT v.state,v.reason,v.id AS validation_run_id FROM gotchu.dependency_fix_candidates c
        JOIN gotchu.validation_runs v ON v.organization_id=c.organization_id AND v.application_id=c.application_id AND v.id=c.validation_run_id
        WHERE c.organization_id=$1 AND c.application_id=$2 AND c.report_id=$3 AND c.finding_id=$4 LIMIT 5`,
      [scope.organizationId, scope.applicationId, report.id, finding.id]);
      return evidenceRecord(scope, evidenceId, 'validation_result.v1', { validations: rows.rows, validationMeaning: 'D05_validation_only_not_a_finding_verification' }, report.finishedAt);
    }
    if (!report.subject.sourceSnapshotId || finding.origin !== 'internal') throw new GatewayError('tool_out_of_scope', 403);
    const evidence = report.internal?.evidence.find(item => item.id === evidenceId);
    if (!evidence) throw new GatewayError('evidence_unavailable', 503);
    const sourceRows = await tx.query<{ body: unknown; deleted_at: Date | null }>('SELECT body,deleted_at FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3', [scope.organizationId, scope.applicationId, report.subject.sourceSnapshotId]);
    const source = sourceRows.rows[0] && sourceRows.rows[0].deleted_at === null ? customerSourceSnapshotSchema.safeParse(sourceRows.rows[0].body) : null;
    if (!source?.success) throw new GatewayError('source_unavailable', 503);
    const locator = /^(.+?)(?::([0-9]{1,9}))?$/.exec(finding.location);
    const path = locator?.[1];
    const line = locator?.[2] ? Number(locator[2]) : 1;
    const file = path ? source.data.files.find(item => item.path === path) : undefined;
    if (!file) throw new GatewayError('source_location_unavailable', 404);
    const lines = file.content.split('\n');
    const start = Math.max(0, line - 7 - 1);
    const excerpt = lines.slice(start, Math.min(lines.length, line + 6)).map((item, index) => `${start + index + 1}: ${item}`).join('\n');
    return evidenceRecord(scope, evidenceId, 'customer_assessment_evidence.v1', { path: file.path, excerpt: redactSecrets(excerpt) }, report.finishedAt);
  }
  if (name === 'application.context.read') {
    const environments = await tx.query(`SELECT id,name,kind,state,source FROM gotchu.application_environments WHERE organization_id=$1 AND application_id=$2 AND NOT archived ORDER BY name LIMIT 10`, [scope.organizationId, scope.applicationId]);
    const services = await tx.query(`SELECT id,environment_id,name,kind,state,source FROM gotchu.application_services WHERE organization_id=$1 AND application_id=$2 ORDER BY name LIMIT 50`, [scope.organizationId, scope.applicationId]);
    const dependencies = await tx.query(`SELECT id,service_id,kind,provider,component,state,source FROM gotchu.application_dependencies WHERE organization_id=$1 AND application_id=$2 ORDER BY component LIMIT 50`, [scope.organizationId, scope.applicationId]);
    return evidenceRecord(scope, evidenceId, 'application_context.v1', { environments: environments.rows, services: services.rows, dependencies: dependencies.rows });
  }
  if (name === 'triage.results.read') {
    let incidentId: string | null = 'version' in job && job.subject.kind === 'incident' ? job.subject.subjectId : null;
    if ('version' in job && job.subject.kind === 'alert') {
      const rows = await tx.query<{ body: unknown }>(`SELECT o.body FROM gotchu.operation_alerts a JOIN gotchu.operation_observations o
        ON o.organization_id=a.organization_id AND o.application_id=a.application_id AND o.id=a.observation_id
        WHERE a.organization_id=$1 AND a.application_id=$2 AND a.id=$3`, [scope.organizationId, scope.applicationId, job.subject.subjectId]);
      const observation = rows.rows[0] ? operationObservationSchema.safeParse(rows.rows[0].body) : null;
      incidentId = observation?.success ? observation.data.incidentId : null;
    }
    if (!incidentId) throw new GatewayError('triage_unavailable', 404);
    const rows = await tx.query(`SELECT body,evidence_refs AS "evidenceRefs",revision,created_at AS "createdAt" FROM gotchu.triage_revisions
      WHERE organization_id=$1 AND application_id=$2 AND incident_id=$3 ORDER BY revision DESC LIMIT 1`, [scope.organizationId, scope.applicationId, incidentId]);
    if (!rows.rowCount) throw new GatewayError('triage_unavailable', 404);
    return evidenceRecord(scope, evidenceId, 'triage_revision.v1', rows.rows[0]);
  }
  throw new GatewayError('tool_unavailable', 503);
}

export interface GatewayRequest {
  readonly token: string;
  readonly runId: string;
  readonly operation: GatewayOperation;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

export function createGatewayService(options: {
  database: Database;
  capabilityPublicKey: CryptoKey;
  modelProbeSecret?: Uint8Array;
  modelPort?: ModelPort;
  modelSecrets?: ModelSecretStore;
  modelEndpointValidator?: ModelEndpointValidator;
}) {
  const { database, capabilityPublicKey } = options;
  const modelPort = options.modelPort ?? createModelPort();
  if (database.role !== 'gotchu_coordinator') throw new Error('Gateway requires its own coordinator-class database login');
  if (capabilityPublicKey.type !== 'public' || capabilityPublicKey.algorithm.name !== 'Ed25519') {
    throw new Error('Gateway accepts only an Ed25519 public verification key');
  }

  async function authenticate(token: string) {
    if (token.length > 16_000) throw new GatewayError('invalid_capability', 401);
    return verifyRunCapability(token, capabilityPublicKey);
  }

  async function probe(token: string, raw: unknown): Promise<ModelProbeResult> {
    if (!options.modelProbeSecret) return probeUnavailable();
    const input = investigationModelProbeRequestSchema.parse(raw);
    let claims: ModelProbeClaims;
    try { claims = verifyModelProbeToken(options.modelProbeSecret, token); }
    catch { throw new GatewayError('invalid_probe_capability', 401); }
    if (claims.organizationId !== input.organizationId || claims.requestId !== input.requestId) {
      throw new GatewayError('probe_capability_scope_mismatch', 403);
    }
    return invokeModelProbe({ database, modelPort, ...(options.modelSecrets ? { modelSecrets: options.modelSecrets } : {}),
      ...(options.modelEndpointValidator ? { modelEndpointValidator: options.modelEndpointValidator } : {}), ...input });
  }

  async function request(request: GatewayRequest): Promise<unknown> {
    const capability = await authenticate(request.token);
    const operation = gatewayOperationSchema.parse(request.operation);
    const runId = z.uuid().parse(request.runId);
    if (runId !== capability.claims.runId) throw new GatewayError('capability_scope_mismatch', 403);
    const { organizationId, applicationId } = capability.claims;
    const scope: RunScope = { organizationId, applicationId, runId };

    if (operation === 'model') return invokeModel(request, capability, scope, modelPort, options.modelSecrets, database, options.modelEndpointValidator);

    return database.tenant(organizationId, async tx => {
      const rows = await tx.query(`SELECT r.application_id AS "applicationId", r.state,
        r.deadline, r.cancel_requested_at IS NOT NULL AS "cancelRequested", j.payload, j.state AS "jobState", j.lease_until AS "jobLeaseUntil"
        FROM gotchu.agent_runs r JOIN gotchu.jobs j ON j.organization_id=r.organization_id
          AND j.application_id=r.application_id AND j.id=r.job_id AND j.kind='investigation'
        WHERE r.organization_id=$1 AND r.id=$2 FOR UPDATE OF r,j`, [organizationId, runId]);
      const raw = rows.rows[0];
      if (!raw) throw new GatewayError('run_not_authorized', 403);
      const row = runRowSchema.parse(raw);
      const databaseNow = z.date().parse((await tx.query('SELECT clock_timestamp() AS now')).rows[0]?.now).getTime();
      if (row.applicationId !== applicationId || capability.claims.exp * 1000 > row.deadline.getTime()) {
        throw new GatewayError('capability_scope_mismatch', 403);
      }
      // Recheck after acquiring the lock; waiting must not extend a capability's life.
      if (capability.claims.exp <= Math.floor(Math.max(Date.now(), databaseNow) / 1000)) throw new GatewayError('invalid_capability', 401);
      const revoked = await tx.query('SELECT 1 FROM gotchu.gateway_revoked_capabilities WHERE organization_id=$1 AND run_id=$2 AND jti=$3', [organizationId, runId, capability.claims.jti]);
      if (revoked.rowCount) throw new GatewayError('capability_revoked', 403);
      const active = row.state === 'running' && !row.cancelRequested && row.deadline.getTime() > databaseNow
        && row.jobState === 'running' && row.jobLeaseUntil !== null && row.jobLeaseUntil.getTime() > databaseNow;
      const terminalCheckpointRead = operation === 'checkpoint.load'
        && (row.state === 'succeeded' || row.state === 'unavailable' || row.state === 'failed');
      if (!active && !terminalCheckpointRead) throw new GatewayError('run_not_active', 403);
      const parsedJob = gatewayJobPayloadSchema.safeParse(row.payload);
      if (!parsedJob.success) throw new GatewayError('evidence_unavailable', 503);
      const job = parsedJob.data;
      // A broader signed claim is never permission to expand the persisted job's scope.
      const allowedEvidence = job.evidenceIds.filter(id => capability.claims.evidenceIds.includes(id));
      const runs = transactionRuns(database, organizationId, tx);

      if (operation === 'checkpoint.load') {
        const loaded = await runs.load({ organizationId, runId });
        return { version: loaded.checkpointVersion, checkpoint: loaded.checkpoint === null ? null
          : sanitizeCheckpoint(loaded.checkpoint, capability, allowedEvidence, loaded) };
      }
      if (operation === 'checkpoint.save') {
        const input = checkpointRequestSchema.parse(request.body);
        if (input.organizationId !== organizationId) throw new GatewayError('capability_scope_mismatch', 403);
        if (input.checkpoint.sequence !== input.expectedVersion + 1) throw new GatewayError('stale_checkpoint', 409);
        const loaded = await runs.load({ organizationId, runId });
        const checkpoint = sanitizeCheckpoint(input.checkpoint, capability, allowedEvidence, loaded);
        return runs.checkpoint({ organizationId, runId, expectedVersion: input.expectedVersion, checkpoint });
      }
      const body = operation === 'input' ? inputRequestSchema.parse(request.body) : readRequestSchema.parse(request.body);
      assertCapabilityScope(capability, { ...body, runId });
      if (allowedEvidence.length !== job.evidenceIds.length) throw new GatewayError('capability_read_denied', 403);
      const events = await validateMaterialJob(tx, scope, job);

      if (operation === 'input') {
        for (const id of job.evidenceIds) assertCapabilityAllowsRead(capability, 'evidence.read', id);
        if ('version' in job && job.correctionId) return loadAiCorrectionInput(tx, { ...scope, correctionId: job.correctionId });
        const passed = { result: 'passed', evidenceIds: job.evidenceIds };
        const deterministicCandidate = 'version' in job
          ? true
          : events.length > 0 && events.every(e => e.type === 'auth.login_failed' && e.outcome === 'failure');
        const requiredScope = 'version' in job && job.subject.kind === 'finding' ? 'finding_details' : 'runtime_summaries';
        const modelSettings = await tx.query<{ ready: boolean; provider: string | null; secret_ref: string | null }>(`SELECT COALESCE(o.model_opt_in AND s.consent_to_external_processing
          AND s.data_scopes ? $2 AND o.model_budget_micros>o.model_spent_micros+o.model_reserved_micros
          AND o.model_token_budget>o.model_tokens_spent+o.model_tokens_reserved
          AND s.secret_ref IS NOT NULL,false) AS ready,s.provider,s.secret_ref
          FROM gotchu.organizations o LEFT JOIN gotchu.investigation_model_settings s ON s.organization_id=o.id WHERE o.id=$1`, [organizationId, requiredScope]);
        const modelSetting = modelSettings.rows[0];
        const modelEnabled = modelSetting?.ready === true
          && (modelSetting.secret_ref === null || Boolean(options.modelSecrets));
        return investigationInputSchema.parse({ scope, requiredChecks: {
          inputIntegrity: passed, tenantScope: passed, evidenceProvenance: passed,
          deterministicDetection: {
            result: deterministicCandidate ? 'candidate' : 'unavailable',
            evidenceIds: job.evidenceIds,
          },
        }, modelEnabled });
      }
      const input = readRequestSchema.parse(body);
      assertCapabilityAllowsRead(capability, input.name, input.evidenceId);
      if (!allowedEvidence.includes(input.evidenceId)) throw new GatewayError('capability_read_denied', 403);
      if (input.callId !== request.idempotencyKey) throw new GatewayError('idempotency_key_mismatch', 400);
      if (input.callType === 'required_evidence' && (input.name !== 'evidence.read'
        || input.callId !== requiredEvidenceCallId(runId, input.evidenceId))) throw new GatewayError('invalid_required_read', 403);
      const priorRows = await tx.query('SELECT call_type AS "callType", tool_name AS name, evidence_id AS "evidenceId", response FROM gotchu.gateway_read_calls WHERE organization_id=$1 AND run_id=$2 AND call_id=$3', [organizationId, runId, input.callId]);
      const prior = priorRows.rows[0];
      if (prior) {
        const stored = storedReadSchema.parse(prior);
        if (stored.callType !== input.callType || stored.name !== input.name || stored.evidenceId !== input.evidenceId) {
          throw new GatewayError('idempotency_conflict', 409);
        }
        const response = safeEvidenceSchema.parse(stored.response);
        assertCapabilityScope(capability, response);
        if (response.evidenceId !== input.evidenceId) throw new GatewayError('stored_evidence_invalid', 503);
        return response;
      }
      if (input.callType === 'additional') {
        const count = await tx.query<{ calls: number }>(`SELECT count(*)::int AS calls FROM gotchu.gateway_read_calls
          WHERE organization_id=$1 AND run_id=$2 AND call_type='additional' AND tool_name=$3`, [organizationId, runId, input.name]);
        if ((count.rows[0]?.calls ?? 0) >= (MAX_ADDITIONAL_TOOL_CALLS[input.name] ?? 0)) throw new GatewayError('tool_budget_exhausted', 429);
        await runs.consumeTool({ organizationId, runId });
      }
      const dataScope = jobDataScope(job, input.name);
      const response = await readScopedTool(tx, scope, job, input.name, input.evidenceId, events);
      await tx.query('INSERT INTO gotchu.gateway_read_calls(organization_id,run_id,call_id,call_type,tool_name,evidence_id,response,data_scope) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [organizationId, runId, input.callId, input.callType, input.name, input.evidenceId, JSON.stringify(response), dataScope]);
      return response;
    });
  }

  return { authenticate, request, probe };
}

function sanitizeCheckpoint(
  raw: unknown, capability: VerifiedRunCapability, evidenceIds: readonly string[],
  counters: { modelCalls: number; toolCalls: number },
): SafeInvestigationCheckpoint {
  const checkpoint = safeCheckpointSchema.parse(raw);
  assertCapabilityScope(capability, checkpoint.scope);
  if (checkpoint.result?.citedEvidenceIds.some(id => !evidenceIds.includes(id))) throw new GatewayError('capability_read_denied', 403);
  // Checkpoints are agent progress, never authorization. Replace free text rather than
  // promising heuristic secret redaction. Model spending is disabled in this service.
  return safeCheckpointSchema.parse({
    ...checkpoint, modelCalls: counters.modelCalls, additionalReadToolCalls: counters.toolCalls,
    tokensUsed: 0, spendMicroUsd: 0,
    ...(checkpoint.result ? { result: {
      ...checkpoint.result, summary: 'Agent progress recorded; independent verification is unavailable.',
      counters: { ...checkpoint.result.counters, modelCalls: counters.modelCalls,
        additionalReadToolCalls: counters.toolCalls, tokensUsed: 0, spendMicroUsd: 0 },
    } } : {}),
  });
}

const modelSettingsSchema = z.object({
  provider: modelProviderSchema,
  provider_preset_id: investigationProviderPresetIdSchema,
  endpoint: investigationModelEndpointSchema,
  model_id: z.string().min(1).max(200),
  secret_ref: z.string().nullable(),
  consent_to_external_processing: z.boolean(),
  data_scopes: z.array(investigationDataScopeSchema).max(7),
  input_price_micro_usd_per_million_tokens: z.union([z.string(), z.number()]),
  output_price_micro_usd_per_million_tokens: z.union([z.string(), z.number()]),
}).strict().superRefine((value, context) => {
  const preset = investigationProviderCatalog.find(item => item.id === value.provider_preset_id);
  if (!preset || investigationModelProviderForPreset(preset) !== value.provider) {
    context.addIssue({ code: 'custom', path: ['provider_preset_id'], message: 'Provider preset and adapter do not match' });
  } else if (preset.baseUrl !== null && preset.baseUrl !== value.endpoint) {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Hosted provider endpoint differs from the fixed preset URL' });
  }
});

function jobDataScope(job: z.infer<typeof gatewayJobPayloadSchema>, tool: z.infer<typeof runReadToolSchema>) {
  return investigationReadDataScope('version' in job ? job.subject.kind : 'incident', tool);
}

function pricedUsage(inputTokens: number, outputTokens: number, inputRate: bigint, outputRate: bigint): number {
  const numerator = BigInt(inputTokens) * inputRate + BigInt(outputTokens) * outputRate;
  return Number((numerator + 999_999n) / 1_000_000n);
}

function probeTokenAllowance(presetId: z.infer<typeof investigationProviderPresetIdSchema>): number {
  return investigationProviderCatalog.find(preset => preset.id === presetId)?.probeTokenAllowance ?? 64;
}

/**
 * True only when the provider refused the request before generating anything (CLI missing, login
 * rejected, model unknown), so releasing the reservation cannot hide real usage.
 */
function rejectedBeforeGeneration(error: unknown): boolean {
  return error instanceof ModelProviderError && (error.code === 'cli_unavailable'
    || (error.code === 'request_failed' && (error.status === 401 || error.status === 403 || error.status === 404)));
}

const credentialLocks = new Map<string, Promise<ModelCompletion>>();
/**
 * Codex rotates its refresh token on use, so calls sharing one stored login run one at a time,
 * re-read the latest credential, and write any rotated tokens back. Other providers pass through.
 */
async function completeWithStoredCredential(options: {
  modelPort: ModelPort; secrets: ModelSecretStore; database: Database; organizationId: string; secretRef: string; apiKey: string;
}, request: Omit<ModelCompletionRequest, 'apiKey' | 'persistCredential'>): Promise<ModelCompletion> {
  const { modelPort, secrets, database, organizationId, secretRef } = options;
  if (request.providerPresetId !== 'codex') return modelPort.complete({ ...request, apiKey: options.apiKey });
  async function persistCredential(next: string) {
    let failure: unknown;
    try { await secrets.replace(secretRef, Buffer.from(next, 'utf8')); }
    catch (error) { failure = error; }
    // The Owner may have replaced or removed this login while the call ran; never bring its file back.
    const current = await database.tenant(organizationId, tx => tx.query<{ secret_ref: string | null }>(
      'SELECT secret_ref FROM gotchu.investigation_model_settings WHERE organization_id=$1', [organizationId]));
    if (current.rows[0]?.secret_ref !== secretRef) { await secrets.delete(secretRef); return; }
    if (failure !== undefined) throw failure;
  }
  const previous = credentialLocks.get(secretRef);
  const current = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const latest = new TextDecoder('utf-8', { fatal: true }).decode(await secrets.get(secretRef));
    return modelPort.complete({ ...request, apiKey: latest, persistCredential });
  });
  credentialLocks.set(secretRef, current);
  try { return await current; }
  finally { if (credentialLocks.get(secretRef) === current) credentialLocks.delete(secretRef); }
}

const probeOutputSchema = z.object({ ok: z.literal(true) }).strict();
const probeFailureSchema = investigationModelProbeResultSchema;
type ModelProbeResult = z.infer<typeof investigationModelProbeResultSchema>;

function probeReason(error: unknown): ModelProbeResult['reason'] {
  if (!(error instanceof ModelProviderError)) return 'network_error';
  if (error.code === 'invalid_response') return 'invalid_response';
  if (error.code === 'missing_usage') return 'missing_usage';
  if (error.code === 'cli_unavailable') return 'cli_unavailable';
  if (error.code === 'aborted') return 'provider_unavailable';
  switch (error.status) {
    case 401: return 'invalid_api_key';
    case 402: return 'billing_or_credits';
    case 403: return 'access_denied';
    case 404: return 'model_or_endpoint_not_found';
    case 429: return 'rate_limited';
    case 400: case 422: return 'request_rejected';
    default: return error.status !== undefined && error.status >= 500 ? 'provider_unavailable' : 'network_error';
  }
}

function modelSnapshot(settings: z.infer<typeof modelSettingsSchema>) {
  const inputPrice = Number(settings.input_price_micro_usd_per_million_tokens);
  const outputPrice = Number(settings.output_price_micro_usd_per_million_tokens);
  return {
    provider: settings.provider, providerPresetId: settings.provider_preset_id, endpoint: settings.endpoint,
    modelId: settings.model_id, secretRef: settings.secret_ref,
    consentToExternalProcessing: settings.consent_to_external_processing, dataScopes: settings.data_scopes,
    inputPriceMicroUsdPerMillionTokens: inputPrice, outputPriceMicroUsdPerMillionTokens: outputPrice,
  };
}

function probeConfigurationError(settings: z.infer<typeof modelSettingsSchema> | null): ModelProbeResult | null {
  if (!settings || !settings.consent_to_external_processing || settings.data_scopes.length === 0 || !settings.secret_ref) {
    return probeFailureSchema.parse({ status: 'failed', reason: 'probe_unavailable', inputTokens: null, outputTokens: null });
  }
  return null;
}

function probeUnavailable(reason: ModelProbeResult['reason'] = 'probe_unavailable'): ModelProbeResult {
  return probeFailureSchema.parse({ status: 'failed', reason, inputTokens: null, outputTokens: null });
}

async function invokeModelProbe(options: {
  database: Database; modelPort: ModelPort; modelSecrets?: ModelSecretStore;
  modelEndpointValidator?: ModelEndpointValidator; organizationId: string; requestId: string;
}): Promise<ModelProbeResult> {
  const { database, modelPort, modelSecrets, organizationId, requestId } = options;
  const settingsResult = await database.tenant(organizationId, async tx => {
    const result = await tx.query(`SELECT s.provider,s.provider_preset_id,s.endpoint,s.model_id,s.secret_ref,s.consent_to_external_processing,s.data_scopes,
      s.input_price_micro_usd_per_million_tokens,s.output_price_micro_usd_per_million_tokens
      FROM gotchu.investigation_model_settings s JOIN gotchu.organizations o ON o.id=s.organization_id
      WHERE s.organization_id=$1 AND o.model_opt_in=true`, [organizationId]);
    return modelSettingsSchema.safeParse(result.rows[0]);
  });
  const settings = settingsResult.success ? settingsResult.data : null;
  const unavailable = probeConfigurationError(settings);
  if (unavailable || !settings) return unavailable ?? probeUnavailable();
  if (!modelSecrets) return probeUnavailable();

  if (settings.provider_preset_id === 'custom_openai_compatible') {
    const validator = options.modelEndpointValidator ?? createModelEndpointValidator();
    try { await validator.validate(settings.endpoint); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      return code === 'model_endpoint_nonpublic' || code === 'model_endpoint_https_required' || code === 'model_endpoint_invalid'
        ? probeUnavailable('unsafe_endpoint') : probeUnavailable();
    }
  }

  const secretRef = settings.secret_ref ?? '';
  const probeTokens = probeTokenAllowance(settings.provider_preset_id);
  let apiKey: string;
  try { apiKey = new TextDecoder('utf-8', { fatal: true }).decode(await modelSecrets.get(secretRef)); }
  catch { return probeUnavailable(); }
  if (!apiKey) return probeUnavailable();

  const snapshot = modelSnapshot(settings);
  const reservation = await database.tenant(organizationId, async tx => {
    const existing = await tx.query<{ state: string; result: unknown }>(`SELECT state,result FROM gotchu.investigation_model_probes
      WHERE organization_id=$1 AND request_id=$2 FOR UPDATE`, [organizationId, requestId]);
    const previous = existing.rows[0];
    if (previous) {
      const saved = investigationModelProbeResultSchema.safeParse(previous.result);
      return { kind: 'existing' as const, result: saved.success ? saved.data : probeUnavailable() };
    }
    // Locking the organization row suffices: every settings change also updates it in the same transaction,
    // and row locks on the settings table would need an UPDATE grant the gateway must not have.
    const currentResult = await tx.query(`SELECT s.provider,s.provider_preset_id,s.endpoint,s.model_id,s.secret_ref,s.consent_to_external_processing,s.data_scopes,
      s.input_price_micro_usd_per_million_tokens,s.output_price_micro_usd_per_million_tokens,
      o.model_budget_micros,o.model_spent_micros,o.model_reserved_micros,o.model_token_budget,o.model_tokens_spent,o.model_tokens_reserved
      FROM gotchu.investigation_model_settings s JOIN gotchu.organizations o ON o.id=s.organization_id
      WHERE s.organization_id=$1 AND o.model_opt_in=true FOR UPDATE OF o`, [organizationId]);
    const row = currentResult.rows[0];
    const current = modelSettingsSchema.safeParse(row ? {
      provider: row.provider, provider_preset_id: row.provider_preset_id, endpoint: row.endpoint, model_id: row.model_id,
      secret_ref: row.secret_ref, consent_to_external_processing: row.consent_to_external_processing, data_scopes: row.data_scopes,
      input_price_micro_usd_per_million_tokens: row.input_price_micro_usd_per_million_tokens,
      output_price_micro_usd_per_million_tokens: row.output_price_micro_usd_per_million_tokens,
    } : undefined);
    if (!current.success || !current.data.consent_to_external_processing || current.data.data_scopes.length === 0
      || !current.data.secret_ref || modelConfigurationFingerprint(modelSnapshot(current.data)) !== modelConfigurationFingerprint(snapshot)) {
      return { kind: 'existing' as const, result: probeUnavailable() };
    }
    const limits = z.object({
      model_budget_micros: z.union([z.string(), z.number()]), model_spent_micros: z.union([z.string(), z.number()]),
      model_reserved_micros: z.union([z.string(), z.number()]), model_token_budget: z.union([z.string(), z.number()]),
      model_tokens_spent: z.union([z.string(), z.number()]), model_tokens_reserved: z.union([z.string(), z.number()]),
    }).safeParse(row);
    if (!limits.success) return { kind: 'existing' as const, result: probeUnavailable() };
    const budgetMicros = BigInt(limits.data.model_budget_micros);
    const spendAndReserve = BigInt(limits.data.model_spent_micros) + BigInt(limits.data.model_reserved_micros);
    const tokenBudget = BigInt(limits.data.model_token_budget);
    const tokensAndReserve = BigInt(limits.data.model_tokens_spent) + BigInt(limits.data.model_tokens_reserved);
    if (tokenBudget - tokensAndReserve < BigInt(probeTokens)) return { kind: 'existing' as const, result: probeUnavailable('budget_exhausted') };
    const inputRate = BigInt(current.data.input_price_micro_usd_per_million_tokens);
    const outputRate = BigInt(current.data.output_price_micro_usd_per_million_tokens);
    const reserveCost = Number((BigInt(probeTokens) * (inputRate > outputRate ? inputRate : outputRate) + 999_999n) / 1_000_000n) || 1;
    if (budgetMicros - spendAndReserve < BigInt(reserveCost)) return { kind: 'existing' as const, result: probeUnavailable('budget_exhausted') };
    const inserted = await tx.query(`INSERT INTO gotchu.investigation_model_probes(organization_id,request_id,state,reserved_micros,reserved_tokens)
      VALUES($1,$2,'in_flight',$3,$4) ON CONFLICT DO NOTHING RETURNING request_id`, [organizationId, requestId, reserveCost, probeTokens]);
    if (!inserted.rowCount) return { kind: 'existing' as const, result: probeUnavailable() };
    const reserved = await tx.query(`UPDATE gotchu.organizations SET model_reserved_micros=model_reserved_micros+$2,
      model_tokens_reserved=model_tokens_reserved+$3 WHERE id=$1`, [organizationId, reserveCost, probeTokens]);
    if (!reserved.rowCount) throw new GatewayError('probe_unavailable', 503);
    return { kind: 'reserved' as const, settings: current.data, reserveCost, inputRate, outputRate };
  });
  if (reservation.kind === 'existing') return reservation.result;

  const requestController = new AbortController();
  const requestTimeout = setTimeout(() => requestController.abort(), 25_000);
  requestTimeout.unref();
  let polling = false;
  const cancelPoll = setInterval(() => {
    if (polling) return;
    polling = true;
    database.tenant(organizationId, async tx => {
      const currentResult = await tx.query(`SELECT o.model_opt_in,s.provider,s.provider_preset_id,s.endpoint,s.model_id,s.secret_ref,
        s.consent_to_external_processing,s.data_scopes,s.input_price_micro_usd_per_million_tokens,s.output_price_micro_usd_per_million_tokens
        FROM gotchu.organizations o LEFT JOIN gotchu.investigation_model_settings s ON s.organization_id=o.id WHERE o.id=$1`, [organizationId]);
      const row = currentResult.rows[0];
      if (!row || row.model_opt_in !== true) return null;
      const current = modelSettingsSchema.safeParse({
        provider: row.provider, provider_preset_id: row.provider_preset_id, endpoint: row.endpoint, model_id: row.model_id,
        secret_ref: row.secret_ref, consent_to_external_processing: row.consent_to_external_processing, data_scopes: row.data_scopes,
        input_price_micro_usd_per_million_tokens: row.input_price_micro_usd_per_million_tokens,
        output_price_micro_usd_per_million_tokens: row.output_price_micro_usd_per_million_tokens,
      });
      return current.success && current.data.consent_to_external_processing && current.data.data_scopes.length > 0
        && modelConfigurationFingerprint(modelSnapshot(current.data)) === modelConfigurationFingerprint(snapshot);
    }).then(stillAuthorized => { if (!stillAuthorized) requestController.abort(); })
      .catch(() => requestController.abort()).finally(() => { polling = false; });
  }, 1_000);
  cancelPoll.unref();
  let result: ModelProbeResult;
  try {
    const completion = await completeWithStoredCredential({ modelPort, secrets: modelSecrets, database, organizationId, secretRef, apiKey }, {
      provider: reservation.settings.provider, providerPresetId: reservation.settings.provider_preset_id,
      endpoint: new URL(reservation.settings.endpoint), modelId: reservation.settings.model_id,
      systemInstruction: 'Reply with exactly this JSON object and no other text: {"ok":true}',
      userContext: 'Connection test. Return the requested JSON.', maxOutputTokens: 16, signal: requestController.signal,
    });
    const actualUsage = { inputTokens: completion.inputTokens, outputTokens: completion.outputTokens };
    if (!Number.isSafeInteger(actualUsage.inputTokens + actualUsage.outputTokens) || actualUsage.inputTokens + actualUsage.outputTokens > probeTokens) {
      throw new ModelProviderError('missing_usage');
    }
    const cost = pricedUsage(actualUsage.inputTokens, actualUsage.outputTokens, reservation.inputRate, reservation.outputRate);
    if (cost > reservation.reserveCost) throw new ModelProviderError('missing_usage');
    const output = probeOutputSchema.safeParse(completion.output);
    result = output.success
      ? investigationModelProbeResultSchema.parse({ status: 'succeeded', reason: null, ...actualUsage })
      : investigationModelProbeResultSchema.parse({ status: 'failed', reason: 'model_output_invalid', ...actualUsage });
    await database.tenant(organizationId, async tx => {
      await tx.query(`UPDATE gotchu.organizations SET model_reserved_micros=model_reserved_micros-$2,
        model_spent_micros=model_spent_micros+$3,model_tokens_reserved=model_tokens_reserved-$4,
        model_tokens_spent=model_tokens_spent+$5 WHERE id=$1`, [organizationId, reservation.reserveCost, cost, probeTokens, actualUsage.inputTokens + actualUsage.outputTokens]);
      await tx.query(`UPDATE gotchu.investigation_model_probes SET state='settled',input_tokens=$3,output_tokens=$4,
        charged_micros=$5,result=$6::jsonb,settled_at=clock_timestamp()
        WHERE organization_id=$1 AND request_id=$2 AND state='in_flight'`, [organizationId, requestId, actualUsage.inputTokens, actualUsage.outputTokens, cost, JSON.stringify(result)]);
    });
    return result;
  } catch (error) {
    result = probeUnavailable(probeReason(error));
    const released = rejectedBeforeGeneration(error);
    await database.tenant(organizationId, async tx => {
      if (released) {
        const settled = await tx.query(`UPDATE gotchu.investigation_model_probes SET state='settled',input_tokens=0,output_tokens=0,
          charged_micros=0,result=$3::jsonb,settled_at=clock_timestamp()
          WHERE organization_id=$1 AND request_id=$2 AND state='in_flight'`, [organizationId, requestId, JSON.stringify(result)]);
        if (settled.rowCount) {
          await tx.query(`UPDATE gotchu.organizations SET model_reserved_micros=model_reserved_micros-$2,
            model_tokens_reserved=model_tokens_reserved-$3 WHERE id=$1`, [organizationId, reservation.reserveCost, probeTokens]);
        }
        return;
      }
      await tx.query(`UPDATE gotchu.investigation_model_probes SET state='unknown',result=$3::jsonb
        WHERE organization_id=$1 AND request_id=$2 AND state='in_flight'`, [organizationId, requestId, JSON.stringify(result)]);
    });
    return result;
  } finally { clearTimeout(requestTimeout); clearInterval(cancelPoll); }
}


async function invokeModel(
  request: GatewayRequest,
  capability: VerifiedRunCapability,
  scope: RunScope,
  modelPort: ModelPort,
  secrets: ModelSecretStore | undefined,
  database: Database,
  modelEndpointValidator: ModelEndpointValidator | undefined,
) {
  const input = modelRequestSchema.parse(request.body);
  assertCapabilityScope(capability, { ...input, runId: scope.runId });
  if (input.reservationId !== request.idempotencyKey) throw new GatewayError('idempotency_key_mismatch', 400);
  if (input.remainingTokens > 20_000 || input.remainingSpendMicroUsd > 250_000) throw new GatewayError('model_budget_exhausted', 429);

  const authorized = await requestDatabaseRun(database, capability, scope);
  const settings = await authorized.database.tenant(scope.organizationId, async tx => {
    const row = await tx.query(`SELECT s.provider,s.provider_preset_id,s.endpoint,s.model_id,s.secret_ref,s.consent_to_external_processing,s.data_scopes,
      s.input_price_micro_usd_per_million_tokens,s.output_price_micro_usd_per_million_tokens
      FROM gotchu.investigation_model_settings s JOIN gotchu.organizations o ON o.id=s.organization_id
      WHERE s.organization_id=$1 AND o.model_opt_in=true`, [scope.organizationId]);
    const parsed = modelSettingsSchema.safeParse(row.rows[0]);
    if (!parsed.success || !parsed.data.consent_to_external_processing) throw new GatewayError('investigation_disabled', 409);
    if ('version' in authorized.job && authorized.job.correctionId) {
      const context = await loadAiCorrectionInput(tx, { ...scope, correctionId: authorized.job.correctionId });
      return { config: parsed.data, userContext: JSON.stringify(context), instruction: CODING_SYSTEM_INSTRUCTION, correctionId: context.correctionId };
    }
    const ledger = await tx.query<{ tool_name: string; data_scope: string; call_type: unknown; response: unknown }>(`SELECT tool_name,data_scope,call_type,response FROM gotchu.gateway_read_calls
      WHERE organization_id=$1 AND run_id=$2 ORDER BY created_at,call_id LIMIT 28`, [scope.organizationId, scope.runId]);
    const scopes = new Set(parsed.data.data_scopes);
    const evidence = ledger.rows.map(row => {
      const dataScope = investigationDataScopeSchema.parse(row.data_scope);
      if (!scopes.has(dataScope)) throw new GatewayError('investigation_data_scope_not_consented', 403);
      return { tool: runReadToolSchema.parse(row.tool_name), record: safeEvidenceSchema.parse(row.response), callType: z.enum(['required_evidence', 'additional']).parse(row.call_type) };
    });
    const menu = buildInvestigationReadMenu({ subjectKind: 'version' in authorized.job ? authorized.job.subject.kind : 'incident',
      evidenceIds: authorized.job.evidenceIds.filter(id => capability.claims.evidenceIds.includes(id)), allowedReadTools: capability.claims.allowedReadTools,
      dataScopes: parsed.data.data_scopes, reads: evidence.map(item => ({ tool: item.tool, evidenceId: item.record.evidenceId, callType: item.callType })) });
    const subject = 'version' in authorized.job ? authorized.job.subject : { kind: 'incident' as const, subjectId: authorized.job.incidentId };
    const context = boundedInvestigationContext(subject, evidence, menu);
    return { config: parsed.data, userContext: context, instruction: INVESTIGATION_SYSTEM_INSTRUCTION, correctionId: null };
  });

  const secretRef = settings.config.secret_ref;
  if (!secrets && secretRef) throw new GatewayError('model_secret_store_unavailable', 503);
  if (!secrets || !secretRef) throw new GatewayError('model_secret_unavailable', 503);
  let apiKey: string;
  try { apiKey = new TextDecoder('utf-8', { fatal: true }).decode(await secrets.get(secretRef)); }
  catch { throw new GatewayError('model_secret_unavailable', 503); }
  if (!apiKey) throw new GatewayError('model_secret_unavailable', 503);
  if (settings.config.provider_preset_id === 'custom_openai_compatible') {
    const endpointValidator = modelEndpointValidator ?? createModelEndpointValidator();
    try { await endpointValidator.validate(settings.config.endpoint); }
    catch { throw new GatewayError('model_endpoint_rejected', 400); }
  }

  const inputRate = BigInt(settings.config.input_price_micro_usd_per_million_tokens);
  const outputRate = BigInt(settings.config.output_price_micro_usd_per_million_tokens);
  const configSha256 = modelConfigurationFingerprint({
    provider: settings.config.provider, providerPresetId: settings.config.provider_preset_id,
    endpoint: settings.config.endpoint, modelId: settings.config.model_id,
    secretRef: settings.config.secret_ref, consentToExternalProcessing: settings.config.consent_to_external_processing,
    dataScopes: settings.config.data_scopes,
    inputPriceMicroUsdPerMillionTokens: Number(inputRate), outputPriceMicroUsdPerMillionTokens: Number(outputRate),
  });
  const reserveTokens = Math.min(input.remainingTokens, 20_000);
  const preset = investigationProviderCatalog.find(item => item.id === settings.config.provider_preset_id);
  const estimatedInputTokens = (preset?.fixedPromptTokens ?? 0)
    + Math.ceil((settings.instruction.length + settings.userContext.length) / 3);
  const maxOutputTokens = Math.min(input.maxOutputTokens, 2_048, reserveTokens - estimatedInputTokens);
  // Three characters per token deliberately overestimates the prompt size for every provider.
  if (maxOutputTokens < 64) throw new GatewayError('model_budget_exhausted', 429);
  const worstRate = inputRate > outputRate ? inputRate : outputRate;
  const estimatedCost = Number((BigInt(reserveTokens) * worstRate + 999_999n) / 1_000_000n);
  const reserveCost = Math.max(1, Math.min(input.remainingSpendMicroUsd, estimatedCost));
  const requestSha256 = createHash('sha256').update(settings.instruction).update('\0').update(settings.userContext).digest('hex');
  const runs = createRunService({ database: authorized.database });
  try {
    await runs.reserveModel({
      organizationId: scope.organizationId, runId: scope.runId, reservationId: input.reservationId,
      maxCostMicros: reserveCost, reserveTokens, requestSha256,
      configSha256, provider: settings.config.provider, modelId: settings.config.model_id,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'model_budget_exhausted') throw new GatewayError('model_budget_exhausted', 429);
    throw error;
  }
  await runs.markModelInFlight({ organizationId: scope.organizationId, reservationId: input.reservationId });

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 240_000);
  timeout.unref();
  let polling = false;
  const cancelPoll = setInterval(() => {
    if (polling) return;
    polling = true;
    authorized.database.tenant(scope.organizationId, async tx => {
      const result = await tx.query<{ cancelled: boolean; model_opt_in: boolean; provider: string | null; provider_preset_id: string | null; endpoint: string | null; model_id: string | null; secret_ref: string | null; consent_to_external_processing: boolean | null; data_scopes: unknown; input_price_micro_usd_per_million_tokens: string | number | null; output_price_micro_usd_per_million_tokens: string | number | null }>(`SELECT r.cancel_requested_at IS NOT NULL AS cancelled,o.model_opt_in,s.provider,s.provider_preset_id,s.endpoint,s.model_id,s.secret_ref,
        s.consent_to_external_processing,s.data_scopes,s.input_price_micro_usd_per_million_tokens,s.output_price_micro_usd_per_million_tokens
        FROM gotchu.agent_runs r JOIN gotchu.organizations o ON o.id=r.organization_id
        LEFT JOIN gotchu.investigation_model_settings s ON s.organization_id=o.id
        WHERE r.organization_id=$1 AND r.id=$2`, [scope.organizationId, scope.runId]);
      const row = result.rows[0];
      const current = row ? modelSettingsSchema.safeParse({
        provider: row.provider, provider_preset_id: row.provider_preset_id, endpoint: row.endpoint, model_id: row.model_id, secret_ref: row.secret_ref,
        consent_to_external_processing: row.consent_to_external_processing, data_scopes: row.data_scopes,
        input_price_micro_usd_per_million_tokens: row.input_price_micro_usd_per_million_tokens,
        output_price_micro_usd_per_million_tokens: row.output_price_micro_usd_per_million_tokens,
      }) : null;
      const currentFingerprint = current?.success ? modelConfigurationFingerprint({
        provider: current.data.provider, providerPresetId: current.data.provider_preset_id,
        endpoint: current.data.endpoint, modelId: current.data.model_id,
        secretRef: current.data.secret_ref, consentToExternalProcessing: current.data.consent_to_external_processing,
        dataScopes: current.data.data_scopes,
        inputPriceMicroUsdPerMillionTokens: Number(current.data.input_price_micro_usd_per_million_tokens),
        outputPriceMicroUsdPerMillionTokens: Number(current.data.output_price_micro_usd_per_million_tokens),
      }) : null;
      if (!row || row.cancelled || !row.model_opt_in || !current?.success || !current.data.consent_to_external_processing
        || currentFingerprint !== configSha256) abortController.abort();
    }).catch(() => abortController.abort()).finally(() => { polling = false; });
  }, 1_000);
  cancelPoll.unref();
  let usageSettled = false;
  try {
    const completion = await completeWithStoredCredential({ modelPort, secrets, database: authorized.database,
      organizationId: scope.organizationId, secretRef, apiKey }, {
      provider: settings.config.provider,
      providerPresetId: settings.config.provider_preset_id,
      endpoint: new URL(settings.config.endpoint),
      modelId: settings.config.model_id,
      systemInstruction: settings.instruction,
      userContext: settings.userContext,
      maxOutputTokens,
      signal: abortController.signal,
    });
    const totalTokens = completion.inputTokens + completion.outputTokens;
    if (!Number.isSafeInteger(totalTokens) || totalTokens > reserveTokens) throw new GatewayError('model_usage_exceeds_reservation', 409);
    const cost = pricedUsage(completion.inputTokens, completion.outputTokens, inputRate, outputRate);
    await runs.settleModel({ organizationId: scope.organizationId, reservationId: input.reservationId,
      actualCostMicros: cost, actualTokens: totalTokens, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens });
    usageSettled = true;
    const correctionId = settings.correctionId;
    if (correctionId) {
      const patch = aiCorrectionPatchSchema.safeParse(completion.output);
      if (patch.success) await authorized.database.tenant(scope.organizationId, tx => storeAiCorrectionPatch(tx, { ...scope, correctionId }, patch.data));
    }
    return { output: completion.output, usage: { inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, totalTokens, spendMicroUsd: cost } };
  } catch (error) {
    if (usageSettled) throw new GatewayError('model_result_not_persisted', 503);
    if (rejectedBeforeGeneration(error)) {
      await runs.settleModel({ organizationId: scope.organizationId, reservationId: input.reservationId,
        actualCostMicros: 0, actualTokens: 0, inputTokens: 0, outputTokens: 0 })
        .catch(() => runs.markModelUnknown({ organizationId: scope.organizationId, reservationId: input.reservationId }).catch(() => undefined));
      throw new GatewayError('model_provider_rejected', 502);
    }
    await runs.markModelUnknown({ organizationId: scope.organizationId, reservationId: input.reservationId }).catch(() => undefined);
    throw new GatewayError(abortController.signal.aborted ? 'model_call_cancelled_or_timed_out' : 'model_call_unknown_cost', 503);
  } finally {
    clearTimeout(timeout);
    clearInterval(cancelPoll);
  }
}

async function requestDatabaseRun(database: Database, capability: VerifiedRunCapability, scope: RunScope) {
  // Revalidate persisted run/job authority immediately before model spending.
  const rows = await database.tenant(scope.organizationId, async tx => {
    const result = await tx.query(`SELECT r.application_id AS "applicationId",r.state,r.deadline,r.cancel_requested_at IS NOT NULL AS "cancelRequested",j.payload,j.state AS "jobState",j.lease_until AS "jobLeaseUntil"
      FROM gotchu.agent_runs r JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.application_id=r.application_id AND j.id=r.job_id
      WHERE r.organization_id=$1 AND r.id=$2 AND j.kind='investigation'`, [scope.organizationId, scope.runId]);
    const raw = result.rows[0];
    if (!raw) throw new GatewayError('run_not_authorized', 403);
    const row = runRowSchema.parse(raw);
    const now = z.date().parse((await tx.query('SELECT clock_timestamp() AS now')).rows[0]?.now).getTime();
    if (row.applicationId !== scope.applicationId || row.state !== 'running'
      || row.deadline.getTime() <= now || row.jobState !== 'running' || row.jobLeaseUntil === null || row.jobLeaseUntil.getTime() <= now) throw new GatewayError('run_not_active', 403);
    if (capability.claims.exp <= Math.floor(Math.max(Date.now(), now) / 1000)) throw new GatewayError('invalid_capability', 401);
    const revoked = await tx.query('SELECT 1 FROM gotchu.gateway_revoked_capabilities WHERE organization_id=$1 AND run_id=$2 AND jti=$3', [scope.organizationId, scope.runId, capability.claims.jti]);
    if (revoked.rowCount) throw new GatewayError('capability_revoked', 403);
    const job = gatewayJobPayloadSchema.safeParse(row.payload);
    if (!job.success || job.data.evidenceIds.some(id => !capability.claims.evidenceIds.includes(id))) throw new GatewayError('evidence_unavailable', 503);
    if (job.data.evidenceIds.length !== capability.claims.evidenceIds.length) throw new GatewayError('capability_read_denied', 403);
    return { job: job.data };
  });
  return { database, job: rows.job };
}

/** Trusted coordinator/operator API only; deliberately absent from the HTTP surface. */
export async function revokeRunCapability(database: Database, input: { organizationId: string; runId: string; jti: string }): Promise<void> {
  if (database.role !== 'gotchu_coordinator') throw new Error('Revocation requires coordinator role');
  const scope = z.object({ organizationId: z.uuid(), runId: z.uuid(), jti: z.uuid() }).strict().parse(input);
  await database.tenant(scope.organizationId, async tx => {
    const run = await tx.query('SELECT id FROM gotchu.agent_runs WHERE organization_id=$1 AND id=$2 FOR UPDATE', [scope.organizationId, scope.runId]);
    if (!run.rowCount) throw new GatewayError('run_not_authorized', 403);
    await tx.query('INSERT INTO gotchu.gateway_revoked_capabilities(organization_id,run_id,jti) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [scope.organizationId, scope.runId, scope.jti]);
  });
}
export type GatewayService = ReturnType<typeof createGatewayService>;
