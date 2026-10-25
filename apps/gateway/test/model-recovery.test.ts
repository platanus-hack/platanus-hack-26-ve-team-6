import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelOutput, RunScope, SafeInvestigationCheckpoint } from '@gotchu/agent';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { migrateGateway } from '../src/migrate.js';
import { recordValidatedModelReply, recoverTrustedCheckpoint } from '../src/model-recovery.js';

// PostgreSQL regression source. Seeded settlement records exercise recovery, not provider billing.
const live = liveUrl ? describe : describe.skip;
live('server-owned investigation replies', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture();
    await migrateGateway({ connectionString: present(liveUrl) });
  }, 30_000);
  afterAll(async () => { await f?.close(); });

  async function seed() {
    const scope: RunScope = { organizationId: f.a.organizationId, applicationId: f.a.applicationId, runId: randomUUID() };
    const jobId = randomUUID();
    const evidenceId = randomUUID();
    const unreadId = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key,payload)
      VALUES ($1,$2,$3,'investigation',$5,$4::jsonb)`,
    [scope.organizationId, scope.applicationId, jobId, JSON.stringify({ incidentId: randomUUID(), evidenceIds: [evidenceId, unreadId] }), jobId]);
    await f.admin.query(`INSERT INTO gotchu.agent_runs(organization_id,application_id,id,job_id,state,deadline)
      VALUES ($1,$2,$3,$4,'running',clock_timestamp()+interval '5 minutes')`,
    [scope.organizationId, scope.applicationId, scope.runId, jobId]);
    await f.admin.query(`INSERT INTO gotchu.gateway_read_calls(organization_id,run_id,call_id,call_type,tool_name,evidence_id,response)
      VALUES ($1,$2,$3,'required_evidence','evidence.read',$4,$5::jsonb)`,
    [scope.organizationId, scope.runId, randomUUID(), evidenceId, JSON.stringify({ ...scope, evidenceId })]);
    const reservationId = await reserve(scope, 1, 'settled');
    const output: ModelOutput = {
      assessment: 'candidate_issue', summary: 'La evidencia indica una configuración incompleta; no demuestra explotación.',
      citedEvidenceIds: [evidenceId], hypotheses: [{ statement: 'Falta una configuración explícita.', evidenceIds: [evidenceId] }],
      candidateSuggestion: {
        kind: 'configuration_change', summary: 'Declarar la configuración.', path: 'src/server.ts', evidenceIds: [evidenceId],
        implications: ['Cambia las cabeceras.'], risks: ['Puede afectar a clientes antiguos.'], validationPlan: ['Revisión independiente pendiente.'],
        validationRequired: 'D05',
      }, requestedReads: [],
    };
    const checkpoint: SafeInvestigationCheckpoint = {
      version: 1, scope, sequence: 1, stage: 'completed', modelCalls: 1, additionalReadToolCalls: 0, tokensUsed: 0, spendMicroUsd: 0,
      result: {
        status: 'investigated', assessment: 'no_issue_supported', summary: 'WORKER INJECTION', citedEvidenceIds: [unreadId],
        hypotheses: [{ statement: 'WORKER INJECTION', evidenceIds: [unreadId] }],
        candidateSuggestion: { ...present(output.candidateSuggestion), summary: 'WORKER INJECTION', evidenceIds: [unreadId] },
        reasonCode: 'completed', independentVerification: 'not_verified',
        counters: { modelCalls: 0, additionalReadToolCalls: 0, tokensUsed: 0, spendMicroUsd: 0, activeMs: 10 },
      },
    };
    return { scope, jobId, evidenceId, unreadId, reservationId, output, checkpoint };
  }

  async function reserve(scope: RunScope, call: number, state: 'settled' | 'unknown') {
    const id = randomUUID();
    await f.admin.query(`UPDATE gotchu.agent_runs SET model_calls=$3,
      tokens_spent=tokens_spent+$4,spent_micros=spent_micros+$5 WHERE organization_id=$1 AND id=$2`,
    [scope.organizationId, scope.runId, call, state === 'settled' ? 700 : 0, state === 'settled' ? 13 : 0]);
    await f.admin.query(`INSERT INTO gotchu.model_reservations
      (organization_id,id,run_id,amount_micros,reserved_tokens,state,charged_micros,charged_tokens,settled_at)
      VALUES ($1,$2,$3,20,1000,$4,$5,$6,CASE WHEN $4='settled' THEN clock_timestamp() ELSE NULL END)`,
    [scope.organizationId, id, scope.runId, state, state === 'settled' ? 13 : null, state === 'settled' ? 700 : null]);
    return id;
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  const record = (s: Seed, output: unknown = s.output, ids = [s.evidenceId]) => f.databases.gotchu_coordinator.tenant(s.scope.organizationId,
    tx => recordValidatedModelReply(tx, s.scope, s.reservationId, output, ids));
  const recover = (s: Seed, checkpoint = s.checkpoint, allowed = [s.evidenceId, s.unreadId], modelCalls = checkpoint.modelCalls) =>
    f.databases.gotchu_coordinator.tenant(s.scope.organizationId,
      tx => recoverTrustedCheckpoint(tx, s.scope, checkpoint, allowed, { modelCalls, toolCalls: 0 }));

  it('restores provider prose and all structured fields, ignores worker text, and preserves server usage', async () => {
    const s = await seed();
    await record(s);
    await record(s); // Identical replay is immutable/idempotent.
    const saved = await recover(s);
    expect(saved.result).toMatchObject({ summary: s.output.summary, assessment: s.output.assessment,
      citedEvidenceIds: s.output.citedEvidenceIds, hypotheses: s.output.hypotheses, candidateSuggestion: s.output.candidateSuggestion });
    expect(saved.result?.independentVerification).toBe('not_verified');
    expect(saved.tokensUsed).toBe(700);
    expect(saved.spendMicroUsd).toBe(13);
    expect(saved.result?.counters).toMatchObject({ modelCalls: 1, tokensUsed: 700, spendMicroUsd: 13 });
    expect(JSON.stringify(saved)).not.toContain('WORKER INJECTION');
    expect(await recover(s, saved)).toEqual(saved);
    await expect(record(s, { ...s.output, summary: 'Otro resultado.' })).rejects.toMatchObject({ code: 'model_reply_reservation_conflict' });
    await f.admin.query("UPDATE gotchu.agent_runs SET state='succeeded' WHERE organization_id=$1 AND id=$2", [s.scope.organizationId, s.scope.runId]);
    expect(await recover(s, saved)).toEqual(saved); // Coordinator replay after the run is terminal.
  });

  it.each(['top', 'hypothesis', 'suggestion'] as const)('rejects an authorized but unloaded %s citation', async location => {
    const s = await seed();
    const output = { ...s.output,
      ...(location === 'top' ? { citedEvidenceIds: [s.unreadId] } : {}),
      ...(location === 'hypothesis' ? { hypotheses: [{ statement: 'No cargado.', evidenceIds: [s.unreadId] }] } : {}),
      ...(location === 'suggestion' ? { candidateSuggestion: { ...present(s.output.candidateSuggestion), evidenceIds: [s.unreadId] } } : {}),
    };
    await expect(record(s, output)).rejects.toMatchObject({ code: 'unsupported_evidence' });
    await expect(record(s, output, [s.evidenceId, s.unreadId])).rejects.toMatchObject({ code: 'unsupported_evidence' });
    const saved = await recover(s);
    expect(saved.result).toMatchObject({ assessment: 'inconclusive', candidateSuggestion: null, hypotheses: [], citedEvidenceIds: [] });
    expect(saved.tokensUsed).toBe(700);
  });

  it.each(['unknown', 'invalid', 'nonfinal'] as const)('never resurrects an older suggestion after a %s reply', async kind => {
    const s = await seed();
    await record(s);
    const reservationId = await reserve(s.scope, 2, kind === 'unknown' ? 'unknown' : 'settled');
    const next = { ...s, reservationId };
    if (kind === 'nonfinal') await record(next, { ...s.output, requestedReads: [{ name: 'evidence.read', evidenceId: s.unreadId }] });
    if (kind === 'invalid') await expect(record(next, { invalid: true })).rejects.toMatchObject({ code: 'invalid_model_output' });
    const checkpoint = { ...s.checkpoint, modelCalls: 2 };
    const saved = await recover(s, checkpoint);
    expect(saved.result?.candidateSuggestion).toBeNull();
    expect(saved.result?.reasonCode).toBe('model_unavailable');
    expect(saved.tokensUsed).toBe(kind === 'unknown' ? 700 : 1400);
    expect((await recover(s, s.checkpoint, undefined, 2)).result?.candidateSuggestion).toBeNull();
  });

  it('preserves unavailable metadata even with a trusted earlier completion', async () => {
    const s = await seed();
    await record(s);
    const delayed: SafeInvestigationCheckpoint = { ...s.checkpoint, stage: 'delayed', result: {
      ...present(s.checkpoint.result), status: 'delayed', reasonCode: 'read_unavailable',
    } };
    const saved = await recover(s, delayed);
    expect(saved).toMatchObject({ stage: 'delayed', result: { status: 'delayed', reasonCode: 'read_unavailable', candidateSuggestion: null } });
    expect(saved.result?.summary).toContain('No hay una respuesta final');
    expect((await recover(s, { ...s.checkpoint, stage: 'running' })).result).toBeUndefined();
  });

  it('does not assign a late older completion to the newest server slot', async () => {
    const s = await seed();
    await reserve(s.scope, 2, 'settled'); // Newer reply is invalid and therefore has no trusted row.
    await f.admin.query('UPDATE gotchu.model_reservations SET settled_at=clock_timestamp() WHERE organization_id=$1 AND id=$2',
      [s.scope.organizationId, s.reservationId]);
    await expect(record(s)).rejects.toMatchObject({ code: 'model_reply_reservation_conflict' });
    const saved = await recover(s, { ...s.checkpoint, modelCalls: 2 });
    expect(saved.result?.candidateSuggestion).toBeNull();
    expect(saved.tokensUsed).toBe(1400);
  });

  it('rechecks nested citations against current authorization on replay', async () => {
    const s = await seed();
    await record(s, { ...s.output, citedEvidenceIds: [] });
    expect((await recover(s, s.checkpoint, [])).result?.candidateSuggestion).toBeNull();
  });

  it.each(['inconclusive', 'no_issue_supported'] as const)('restores the actual %s assessment', async assessment => {
    const s = await seed();
    await record(s, { ...s.output, assessment, candidateSuggestion: null });
    expect((await recover(s)).result).toMatchObject({ assessment, candidateSuggestion: null,
      status: assessment === 'inconclusive' ? 'inconclusive' : 'investigated',
      reasonCode: assessment === 'inconclusive' ? 'model_inconclusive' : 'completed' });
  });

  it('bounds and sanitizes every prose field without storing patches', async () => {
    const s = await seed();
    const prose = 'Dato: token=example-sensitive-value';
    await record(s, { ...s.output, summary: prose, hypotheses: [{ statement: prose, evidenceIds: [s.evidenceId] }],
      candidateSuggestion: { ...present(s.output.candidateSuggestion), summary: prose, path: '../private.ts',
        implications: [prose], risks: [prose], validationPlan: [prose] } });
    const saved = await recover(s);
    expect(JSON.stringify(saved)).not.toContain('example-sensitive-value');
    expect(saved.result?.summary).toBe('Dato: token=[OMITIDO]');
    expect(saved.result?.candidateSuggestion?.path).toBeNull();
    expect(await recover(s, saved)).toEqual(saved);
    for (const summary of ['```ts\nconst secret = 1;\n```', 'diff --git a/a b/a\n+source', 'x'.repeat(2001)]) {
      const fresh = await seed();
      await expect(record(fresh, { ...fresh.output, summary })).rejects.toMatchObject({ code: 'invalid_model_output' });
    }
    const fresh = await seed();
    const lines = Array.from({ length: 5 }, () => '界'.repeat(500));
    await expect(record(fresh, { ...fresh.output, summary: '界'.repeat(2000),
      hypotheses: Array.from({ length: 8 }, () => ({ statement: '界'.repeat(500), evidenceIds: [fresh.evidenceId] })),
      candidateSuggestion: { ...present(fresh.output.candidateSuggestion), implications: lines, risks: lines, validationPlan: lines },
    })).rejects.toMatchObject({ code: 'model_reply_too_large' });
  });

  it('rejects mismatched full scope, reservations, and coding jobs', async () => {
    const s = await seed();
    const other = await seed();
    await expect(record({ ...s, reservationId: other.reservationId })).rejects.toMatchObject({ code: 'model_reply_reservation_conflict' });
    await expect(record({ ...s, scope: { ...s.scope, applicationId: f.b.applicationId } })).rejects.toMatchObject({ code: 'run_not_authorized' });
    await expect(recover(s, { ...s.checkpoint, scope: other.scope })).rejects.toMatchObject({ code: 'capability_scope_mismatch' });
    await expect(f.databases.gotchu_coordinator.tenant(f.b.organizationId,
      tx => recordValidatedModelReply(tx, s.scope, s.reservationId, s.output, [s.evidenceId])))
      .rejects.toMatchObject({ code: 'run_not_authorized' });
    await f.admin.query(`UPDATE gotchu.jobs SET payload=payload || $3::jsonb WHERE organization_id=$1 AND id=$2`,
      [s.scope.organizationId, s.jobId, JSON.stringify({ correctionId: randomUUID() })]);
    await expect(record(s)).rejects.toMatchObject({ code: 'run_not_authorized' });
  });

  it('keeps rows private and immutable and enforces the scoped reservation FK and bounds', async () => {
    const s = await seed();
    await record(s);
    for (const role of ['gotchu_api', 'gotchu_ingest', 'gotchu_executor', 'gotchu_validator'] as const) {
      await expect(f.databases[role].tenant(s.scope.organizationId,
        tx => tx.query('SELECT * FROM gotchu.gateway_validated_model_replies'))).rejects.toMatchObject({ code: '42501' });
    }
    const hidden = await f.databases.gotchu_coordinator.tenant(f.b.organizationId,
      tx => tx.query('SELECT * FROM gotchu.gateway_validated_model_replies WHERE organization_id=$1', [s.scope.organizationId]));
    expect(hidden.rowCount).toBe(0);
    await expect(f.databases.gotchu_coordinator.tenant(s.scope.organizationId,
      tx => tx.query('DELETE FROM gotchu.gateway_validated_model_replies WHERE run_id=$1', [s.scope.runId])))
      .rejects.toMatchObject({ code: '42501' });
    const other = await seed();
    await expect(f.admin.query('UPDATE gotchu.gateway_validated_model_replies SET reservation_id=$2 WHERE run_id=$1',
      [s.scope.runId, other.reservationId])).rejects.toMatchObject({ code: '23503' });
    await expect(f.admin.query('UPDATE gotchu.gateway_validated_model_replies SET model_call=5 WHERE run_id=$1',
      [s.scope.runId])).rejects.toMatchObject({ code: '23514' });
    await expect(f.admin.query('UPDATE gotchu.gateway_validated_model_replies SET output=$2::jsonb WHERE run_id=$1',
      [s.scope.runId, JSON.stringify({ summary: 'x'.repeat(24576) })])).rejects.toMatchObject({ code: '23514' });
  });
});
