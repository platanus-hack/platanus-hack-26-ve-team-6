import { modelOutputSchema, safeCheckpointSchema, type ModelOutput, type RunScope, type SafeInvestigationCheckpoint } from '@gotchu/agent';
import type { Transaction } from '@gotchu/database';
import { z } from 'zod';
import { gatewayJobPayloadSchema } from './contracts.js';
import { GatewayError } from './errors.js';

const evidenceIdsSchema = z.array(z.uuid()).max(20).refine(ids => new Set(ids).size === ids.length);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const storedInteger = z.union([integer, z.string().regex(/^\d+$/).transform(Number).pipe(integer)]);
const runSchema = z.object({
  modelCalls: integer.max(4), toolCalls: integer.max(8),
  tokensUsed: storedInteger, spendMicroUsd: storedInteger, payload: z.unknown(),
});
const fallbackSummary = 'No hay una respuesta final del proveedor validada para este punto de la investigación. La evidencia disponible no permite recuperar una conclusión; la verificación independiente sigue pendiente.';

// Only trusted server callers supply the prompt's actual loaded IDs, never a worker list.
async function loadRun(tx: Transaction, scope: RunScope) {
  safeCheckpointSchema.shape.scope.parse(scope);
  const rows = await tx.query(`SELECT r.model_calls AS "modelCalls",r.tool_calls AS "toolCalls",
    r.tokens_spent AS "tokensUsed",r.spent_micros AS "spendMicroUsd",j.payload
    FROM gotchu.agent_runs r JOIN gotchu.jobs j ON j.organization_id=r.organization_id
      AND j.application_id=r.application_id AND j.id=r.job_id AND j.kind='investigation'
    WHERE r.organization_id=$1 AND r.application_id=$2 AND r.id=$3
      AND NOT (j.payload ? 'correctionId') FOR UPDATE OF r`,
  [scope.organizationId, scope.applicationId, scope.runId]);
  if (!rows.rows[0]) throw new GatewayError('run_not_authorized', 403);
  const run = runSchema.parse(rows.rows[0]);
  return { ...run, job: gatewayJobPayloadSchema.parse(run.payload) };
}

function citations(output: ModelOutput) {
  return [...output.citedEvidenceIds, ...output.hypotheses.flatMap(item => item.evidenceIds),
    ...(output.candidateSuggestion?.evidenceIds ?? [])];
}

function sanitizeProse(value: string, limit: number) {
  // Normal investigation replies are descriptions. Code/patch artifacts use the correction lane.
  if (/```|~~~|<\/?(?:script|pre|code)\b|^(?:diff --git |@@ |--- |\+\+\+ |[+-](?![+-])\S|\s*(?:const|let|var|import|export|function|class)\s)/im.test(value)) {
    throw new GatewayError('invalid_model_output', 502);
  }
  const text = value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[OMITIDO]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?key|client[_-]?secret|token|secret|password|cookie)["']?\s*[:=]\s*)(["'`]?)(?:\[OMITIDO\]|[^\s,;"'`}\]]+)/gi, '$1$2[OMITIDO]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]{20,})\b/g, '[OMITIDO]')
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1[OMITIDO]@')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim().slice(0, limit);
  if (!text) throw new GatewayError('invalid_model_output', 502);
  return text;
}

function safeOutput(raw: unknown, loadedIds: readonly string[]): ModelOutput {
  const parsed = modelOutputSchema.safeParse(raw);
  if (!parsed.success) throw new GatewayError('invalid_model_output', 502);
  const output = parsed.data;
  if (citations(output).some(id => !loadedIds.includes(id))) throw new GatewayError('unsupported_evidence', 502);
  const suggestion = output.candidateSuggestion;
  const path = suggestion?.path;
  const safePath = path && !path.startsWith('/') && !path.includes('\\')
    && !path.split('/').some(part => part === '..' || part === '.')
    && /^[\p{L}\p{N}_@./ -]+$/u.test(path) ? path : null;
  return modelOutputSchema.parse({
    ...output, summary: sanitizeProse(output.summary, 2_000),
    hypotheses: output.hypotheses.map(item => ({ ...item, statement: sanitizeProse(item.statement, 500) })),
    candidateSuggestion: suggestion ? {
      ...suggestion, summary: sanitizeProse(suggestion.summary, 500), path: safePath,
      implications: suggestion.implications?.map(item => sanitizeProse(item, 500)) ?? [],
      risks: suggestion.risks?.map(item => sanitizeProse(item, 500)) ?? [],
      validationPlan: suggestion.validationPlan?.map(item => sanitizeProse(item, 500)) ?? [],
      validationRequired: 'D05',
    } : null,
  });
}

/** Await after settlement and commit before returning the provider reply to the worker.
 * Missing/invalid replies leave no row for that call; recovery never searches older slots.
 * A validation/storage failure must not undo known usage or repeat the provider call.
 */
export async function recordValidatedModelReply(
  tx: Transaction, scope: RunScope, reservationId: string, output: unknown, loadedEvidenceIds: readonly string[],
): Promise<void> {
  z.uuid().parse(reservationId);
  const loadedIds = evidenceIdsSchema.parse(loadedEvidenceIds);
  const run = await loadRun(tx, scope);
  if (loadedIds.some(id => !run.job.evidenceIds.includes(id))) throw new GatewayError('capability_read_denied', 403);
  const loaded = await tx.query(`SELECT DISTINCT evidence_id AS id FROM gotchu.gateway_read_calls
    WHERE organization_id=$1 AND run_id=$3 AND evidence_id=ANY($4::uuid[])
      AND response->>'organizationId'=$1::text AND response->>'applicationId'=$2::text
      AND response->>'runId'=$3::text AND response->>'evidenceId'=evidence_id::text`,
  [scope.organizationId, scope.applicationId, scope.runId, loadedIds]);
  const recordedIds = evidenceIdsSchema.parse(loaded.rows.map(row => row.id));
  if (loadedIds.some(id => !recordedIds.includes(id))) throw new GatewayError('unsupported_evidence', 502);
  const safe = safeOutput(output, loadedIds);
  const encoded = JSON.stringify(safe);
  // Leave room for jsonb whitespace; the database enforces its exact encoded byte limit too.
  if (Buffer.byteLength(encoded) > 23_000) throw new GatewayError('model_reply_too_large', 502);
  const inserted = await tx.query(`INSERT INTO gotchu.gateway_validated_model_replies
    (organization_id,application_id,run_id,reservation_id,model_call,tool_calls,loaded_evidence_ids,output)
    SELECT $1,$2,$3,m.id,$5::integer,$6,$7::uuid[],$8::jsonb FROM gotchu.model_reservations m
    WHERE m.organization_id=$1 AND m.run_id=$3 AND m.id=$4 AND m.state='settled'
      AND m.gateway_call_number=$5::integer
      AND m.charged_tokens IS NOT NULL AND m.charged_micros IS NOT NULL AND m.settled_at IS NOT NULL
      AND (SELECT count(*) FROM gotchu.model_reservations WHERE organization_id=$1 AND run_id=$3)=$5::integer
      AND NOT EXISTS (SELECT 1 FROM gotchu.model_reservations other
        WHERE other.organization_id=$1 AND other.run_id=$3 AND other.id<>m.id
          AND (other.state<>'settled' OR other.settled_at IS NULL))
    ON CONFLICT DO NOTHING RETURNING reservation_id`,
  [scope.organizationId, scope.applicationId, scope.runId, reservationId, run.modelCalls, run.toolCalls, loadedIds, encoded]);
  if (!inserted.rowCount) {
    const same = await tx.query(`SELECT 1 FROM gotchu.gateway_validated_model_replies
      WHERE organization_id=$1 AND application_id=$2 AND run_id=$3 AND reservation_id=$4
        AND output=$5::jsonb AND loaded_evidence_ids @> $6::uuid[] AND loaded_evidence_ids <@ $6::uuid[]`,
    [scope.organizationId, scope.applicationId, scope.runId, reservationId, encoded, loadedIds]);
    if (!same.rowCount) throw new GatewayError('model_reply_reservation_conflict', 409);
  }
}

/** Counters must come from runs.load in this transaction, never the checkpoint body.
 * Token/spend totals come directly from the server's settled run ledger, including invalid replies.
 * This also applies to coordinator terminal replay; legacy checkpoints are not trusted prose.
 */
export async function recoverTrustedCheckpoint(
  tx: Transaction, scope: RunScope, raw: unknown, allowedEvidenceIds: readonly string[],
  counters: { modelCalls: number; toolCalls: number },
): Promise<SafeInvestigationCheckpoint> {
  const checkpoint = safeCheckpointSchema.parse(raw);
  if (checkpoint.scope.organizationId !== scope.organizationId || checkpoint.scope.applicationId !== scope.applicationId
    || checkpoint.scope.runId !== scope.runId) throw new GatewayError('capability_scope_mismatch', 403);
  const allowedIds = evidenceIdsSchema.parse(allowedEvidenceIds);
  const run = await loadRun(tx, scope);
  if (run.modelCalls !== counters.modelCalls || run.toolCalls !== counters.toolCalls) throw new GatewayError('stale_checkpoint', 409);
  const base = {
    version: checkpoint.version, scope, sequence: checkpoint.sequence, stage: checkpoint.stage,
    modelCalls: run.modelCalls, additionalReadToolCalls: run.toolCalls,
    tokensUsed: run.tokensUsed, spendMicroUsd: run.spendMicroUsd,
  };
  if (checkpoint.stage === 'running') return safeCheckpointSchema.parse(base);
  const result = checkpoint.result;
  const claimsCompletion = checkpoint.stage !== 'delayed' && result && result.status !== 'delayed'
    && ['completed', 'model_inconclusive', 'run_already_completed'].includes(result.reasonCode);
  let trusted: ModelOutput | undefined;
  if (claimsCompletion && checkpoint.modelCalls === run.modelCalls && checkpoint.additionalReadToolCalls === run.toolCalls) {
    const reply = await tx.query(`SELECT v.output,v.loaded_evidence_ids AS "loadedIds"
      FROM gotchu.gateway_validated_model_replies v JOIN gotchu.model_reservations m
        ON m.organization_id=v.organization_id AND m.run_id=v.run_id AND m.id=v.reservation_id
          AND m.gateway_call_number=v.model_call
      WHERE v.organization_id=$1 AND v.application_id=$2 AND v.run_id=$3 AND v.model_call=$4
        AND v.tool_calls=$5 AND m.state='settled' AND m.charged_tokens IS NOT NULL
        AND m.charged_micros IS NOT NULL AND m.settled_at IS NOT NULL
        AND (SELECT count(*) FROM gotchu.model_reservations WHERE organization_id=$1 AND run_id=$3)=$4
        AND NOT EXISTS (SELECT 1 FROM gotchu.model_reservations other
          WHERE other.organization_id=$1 AND other.run_id=$3 AND other.id<>m.id
            AND (other.state<>'settled' OR other.settled_at IS NULL))`,
    [scope.organizationId, scope.applicationId, scope.runId, run.modelCalls, run.toolCalls]);
    const row = reply.rows[0];
    if (row) {
      const ids = evidenceIdsSchema.safeParse(row.loadedIds);
      if (ids.success) {
        try {
          const output = safeOutput(row.output, ids.data.filter(id => allowedIds.includes(id) && run.job.evidenceIds.includes(id)));
          if (output.requestedReads.length === 0) trusted = output;
        } catch (error) {
          if (!(error instanceof GatewayError)) throw error;
        }
      }
    }
  }
  const status = trusted ? trusted.assessment === 'inconclusive' ? 'inconclusive' : 'investigated'
    : result?.status === 'delayed' || checkpoint.stage === 'delayed' ? 'delayed' : 'inconclusive';
  const reasonCode = trusted ? trusted.assessment === 'inconclusive' ? 'model_inconclusive' : 'completed'
    : result && result.reasonCode !== 'completed' && result.reasonCode !== 'model_inconclusive'
      ? result.reasonCode : 'model_unavailable';
  return safeCheckpointSchema.parse({
    ...base, stage: status === 'investigated' ? 'completed' : status,
    result: {
      status, assessment: trusted?.assessment ?? 'inconclusive', summary: trusted?.summary ?? fallbackSummary,
      citedEvidenceIds: trusted?.citedEvidenceIds ?? [], hypotheses: trusted?.hypotheses ?? [],
      candidateSuggestion: trusted?.candidateSuggestion ?? null, reasonCode,
      counters: { modelCalls: run.modelCalls, additionalReadToolCalls: run.toolCalls,
        tokensUsed: run.tokensUsed, spendMicroUsd: run.spendMicroUsd, activeMs: result?.counters.activeMs ?? 0 },
      independentVerification: 'not_verified',
    },
  });
}
