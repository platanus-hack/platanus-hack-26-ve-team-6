import { createHash } from 'node:crypto';
import {
  assertCapabilityAllowsRead, assertCapabilityScope, investigationInputSchema,
  safeCheckpointSchema, verifyRunCapability,
  type EvidenceRecord, type RunScope, type SafeInvestigationCheckpoint, type VerifiedRunCapability,
} from '@gotchu/agent';
import { createRunService } from '@gotchu/backend';
import { eventTypeSchema } from '@gotchu/contracts';
import type { Database, Transaction } from '@gotchu/database';
import type { CryptoKey } from 'jose';
import { z } from 'zod';
import {
  checkpointRequestSchema, gatewayJobPayloadSchema, gatewayOperationSchema,
  inputRequestSchema, modelRequestSchema, readRequestSchema, type GatewayOperation,
} from './contracts.js';
import { GatewayError } from './errors.js';

const runRowSchema = z.object({
  applicationId: z.uuid(), state: z.enum(['pending', 'running', 'succeeded', 'unavailable', 'failed']),
  deadline: z.date(), payload: z.unknown(),
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
  source: z.literal('signed_application_event.v1'), collectedAt: z.iso.datetime(),
  excerpt: z.string().max(1_200), truncated: z.literal(true),
}).strict();

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

export interface GatewayRequest {
  readonly token: string;
  readonly runId: string;
  readonly operation: GatewayOperation;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

export function createGatewayService(options: { database: Database; capabilityPublicKey: CryptoKey }) {
  const { database, capabilityPublicKey } = options;
  if (database.role !== 'gotchu_coordinator') throw new Error('Gateway requires its own coordinator-class database login');
  if (capabilityPublicKey.type !== 'public' || capabilityPublicKey.algorithm.name !== 'Ed25519') {
    throw new Error('Gateway accepts only an Ed25519 public verification key');
  }

  async function authenticate(token: string) {
    if (token.length > 16_000) throw new GatewayError('invalid_capability', 401);
    return verifyRunCapability(token, capabilityPublicKey);
  }

  async function request(request: GatewayRequest): Promise<unknown> {
    const capability = await authenticate(request.token);
    const operation = gatewayOperationSchema.parse(request.operation);
    const runId = z.uuid().parse(request.runId);
    if (runId !== capability.claims.runId) throw new GatewayError('capability_scope_mismatch', 403);
    const { organizationId, applicationId } = capability.claims;
    const scope: RunScope = { organizationId, applicationId, runId };

    return database.tenant(organizationId, async tx => {
      const rows = await tx.query(`SELECT r.application_id AS "applicationId", r.state,
        r.deadline, j.payload, j.state AS "jobState", j.lease_until AS "jobLeaseUntil"
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
      const active = row.state === 'running' && row.deadline.getTime() > databaseNow
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
      if (operation === 'model') {
        const input = modelRequestSchema.parse(request.body);
        assertCapabilityScope(capability, { ...input, runId });
        if (input.reservationId !== request.idempotencyKey) throw new GatewayError('idempotency_key_mismatch', 400);
        // No adapter exists: no reservation, provider I/O, or use of caller budget counters.
        throw new GatewayError('model_not_configured', 503);
      }

      const body = operation === 'input' ? inputRequestSchema.parse(request.body) : readRequestSchema.parse(request.body);
      assertCapabilityScope(capability, { ...body, runId });
      if (allowedEvidence.length !== job.evidenceIds.length) throw new GatewayError('capability_read_denied', 403);
      const incidentRows = await tx.query('SELECT rule_id AS "ruleId", status, evidence FROM gotchu.incidents WHERE organization_id=$1 AND application_id=$2 AND id=$3', [organizationId, applicationId, job.incidentId]);
      const incident = incidentSchema.safeParse(incidentRows.rows[0]);
      if (!incident.success || job.evidenceIds.some(id => !incident.data.evidence.includes(id))) {
        throw new GatewayError('evidence_unavailable', 503);
      }
      const eventRows = await tx.query(`SELECT e.id, e.payload->>'id' AS "payloadId", e.payload->>'type' AS type,
        e.payload->>'source' AS source, e.payload->>'outcome' AS outcome,
        e.received_at AS "receivedAt", e.payload_hash AS "payloadHash"
        FROM gotchu.events e JOIN gotchu.integrations i ON i.organization_id=e.organization_id
          AND i.application_id=e.application_id AND i.id=e.integration_id AND i.kind='signed_events'
        WHERE e.organization_id=$1 AND e.application_id=$2 AND e.id=ANY($3::uuid[])
        ORDER BY e.id LIMIT 21`, [organizationId, applicationId, job.evidenceIds]);
      const events = z.array(eventRowSchema).safeParse(eventRows.rows);
      // Event IDs are unique per integration, so ambiguity across integrations fails closed.
      if (!events.success || events.data.length !== job.evidenceIds.length
        || new Set(events.data.map(e => e.id)).size !== job.evidenceIds.length
        || events.data.some(e => e.payloadId.toLowerCase() !== e.id)) throw new GatewayError('evidence_unavailable', 503);

      if (operation === 'input') {
        for (const id of job.evidenceIds) assertCapabilityAllowsRead(capability, 'evidence.read', id);
        const passed = { result: 'passed', evidenceIds: job.evidenceIds };
        return investigationInputSchema.parse({ scope, requiredChecks: {
          inputIntegrity: passed, tenantScope: passed, evidenceProvenance: passed,
          deterministicDetection: {
            result: incident.data.status === 'open' && events.data.every(e => e.type === 'auth.login_failed' && e.outcome === 'failure') ? 'candidate' : 'unavailable',
            evidenceIds: job.evidenceIds,
          },
        } });
      }
      const input = readRequestSchema.parse(body);
      if (input.name !== 'evidence.read' && input.name !== 'auth.events.read') throw new GatewayError('tool_unavailable', 503);
      assertCapabilityAllowsRead(capability, input.name, input.evidenceId);
      if (!allowedEvidence.includes(input.evidenceId)) throw new GatewayError('capability_read_denied', 403);
      if (input.callId !== request.idempotencyKey) throw new GatewayError('idempotency_key_mismatch', 400);
      if (input.callType === 'required_evidence' && (input.name !== 'evidence.read'
        || input.callId !== requiredEvidenceCallId(runId, input.evidenceId))) throw new GatewayError('invalid_required_read', 403);
      const event = events.data.find(e => e.id === input.evidenceId);
      if (!event) throw new GatewayError('evidence_unavailable', 503);
      if (input.name === 'auth.events.read' && !event.type.startsWith('auth.')) throw new GatewayError('tool_unavailable', 503);
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
      if (input.callType === 'additional') await runs.consumeTool({ organizationId, runId });
      const response: EvidenceRecord = {
        ...scope, evidenceId: event.id, source: 'signed_application_event.v1',
        collectedAt: event.receivedAt.toISOString(), truncated: true,
        // No actor, IP, resource, attributes, incident summary, or caller-controlled text.
        excerpt: JSON.stringify({ type: event.type, outcome: event.outcome, payloadSha256: event.payloadHash }),
      };
      await tx.query('INSERT INTO gotchu.gateway_read_calls(organization_id,run_id,call_id,call_type,tool_name,evidence_id,response) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [organizationId, runId, input.callId, input.callType, input.name, input.evidenceId, JSON.stringify(response)]);
      return response;
    });
  }

  return { authenticate, request };
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
