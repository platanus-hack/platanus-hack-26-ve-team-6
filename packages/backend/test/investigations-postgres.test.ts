import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;

live('material investigations on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;

  beforeAll(async () => {
    f = await fixture();
    api = createBackend({ database: f.databases.gotchu_api });
  }, 30_000);
  afterAll(async () => { await f?.close(); });

  it('deduplicates a material incident, cancels queued work, and resumes from its scoped evidence', async () => {
    const identity = { userId: f.a.userId };
    const evidenceId = randomUUID();
    const incidentId = randomUUID();
    await api.investigationModels.configure(identity, {
      organizationId: f.a.organizationId, provider: 'openai_compatible', endpoint: 'http://localhost:11434/v1', modelId: 'fixture-model',
      consentToExternalProcessing: true, dataScopes: ['runtime_summaries'], inputPriceMicroUsdPerMillionTokens: 0,
      outputPriceMicroUsdPerMillionTokens: 0, organizationBudgetCents: 100, organizationTokenBudget: 10_000,
    });
    await f.admin.query(`INSERT INTO gotchu.incidents(organization_id,application_id,id,rule_id,dedupe_key,summary,severity,evidence)
      VALUES($1,$2,$3,'auth.login_failures.v1.account',$4,'Synthetic material incident','medium',$5::jsonb)`,
    [f.a.organizationId, f.a.applicationId, incidentId, randomUUID(), JSON.stringify([evidenceId])]);

    const input = { organizationId: f.a.organizationId, applicationId: f.a.applicationId, subject: { kind: 'incident' as const, subjectId: incidentId } };
    expect(await api.investigations.request(identity, input)).toEqual({ status: 'accepted' });
    expect(await api.investigations.request(identity, input)).toEqual({ status: 'already_active' });
    const beforeCancel = await f.admin.query<{ id: string; payload: { evidenceIds: string[] } }>(`SELECT id,payload FROM gotchu.jobs
      WHERE organization_id=$1 AND application_id=$2 AND kind='investigation'`, [f.a.organizationId, f.a.applicationId]);
    expect(beforeCancel.rows).toHaveLength(1);
    expect(beforeCancel.rows[0]?.payload.evidenceIds).toEqual([evidenceId]);

    const originalJobId = beforeCancel.rows[0]?.id;
    if (!originalJobId) throw new Error('investigation_job_missing');
    expect(await api.investigations.cancel(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, jobId: originalJobId }))
      .toEqual({ status: 'cancel_requested' });
    expect((await api.investigations.list(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId }))[0]?.status).toBe('cancelled');

    expect(await api.investigations.resume(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, jobId: originalJobId }))
      .toEqual({ status: 'resumed' });
    const runs = await api.investigations.list(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId });
    expect(runs).toHaveLength(2);
    expect(runs.find(run => run.jobId !== originalJobId)).toMatchObject({ status: 'pending', subject: input.subject });
    expect(await api.investigations.request(identity, input)).toEqual({ status: 'already_exists' });

    await expect(api.investigations.list({ userId: f.b.userId }, { organizationId: f.a.organizationId, applicationId: f.a.applicationId }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});
