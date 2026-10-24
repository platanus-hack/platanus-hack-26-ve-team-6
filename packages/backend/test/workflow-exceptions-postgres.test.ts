import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend, type StepUpVerifier } from '../src/index.js';
import { fixture, liveUrl } from '../../database/test/support.js';

const live = liveUrl ? describe : describe.skip;
live('workflow policy exception registry on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture({ max: 3 }); }, 30_000);
  afterAll(async () => { await f?.close(); });

  async function repositoryLink(organizationId: string, applicationId: string) {
    const id = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,state,source)
      VALUES($1,$2,$3,$4,'main','granted','granted','verified','operator')`, [organizationId, applicationId, id, `catalog:${randomUUID()}`]);
    return id;
  }

  it('requires exact WebAuthn step-up, audits versions, removes immediately, and isolates tenants', async () => {
    const repositoryLinkId = await repositoryLink(f.a.organizationId, f.a.applicationId);
    const scope = { organizationId: f.a.organizationId, applicationId: f.a.applicationId, repositoryLinkId,
      workflowPath: '.github/workflows/ci.yml', rule: 'pull_request_target' as const,
      justification: 'This existing deployment workflow is reviewed and constrained.' };
    const unavailable = createBackend({ database: f.databases.gotchu_api }).workflowExceptions;
    await expect(unavailable.create({ userId: f.a.userId }, { ...scope, stepUpProof: 'opaque' }))
      .rejects.toMatchObject({ code: 'step_up_unavailable' });

    let method: 'webauthn' | 'totp' = 'webauthn';
    let mismatchHash = false;
    const stepUpVerifier: StepUpVerifier = { verify: async ({ proof, userId, organizationId, actionHash }) => ({
      proofId: proof, userId, organizationId, actionHash: mismatchHash ? 'f'.repeat(64) : actionHash,
      authenticatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), method,
    }) };
    const service = createBackend({ database: f.databases.gotchu_api, stepUpVerifier }).workflowExceptions;
    const { actionHash } = await service.getHash({ userId: f.a.userId }, scope);
    mismatchHash = true;
    await expect(service.create({ userId: f.a.userId }, { ...scope, stepUpProof: 'wrong-hash' }))
      .rejects.toMatchObject({ code: 'step_up_required' });
    mismatchHash = false; method = 'totp';
    await expect(service.create({ userId: f.a.userId }, { ...scope, stepUpProof: 'totp' }))
      .rejects.toMatchObject({ code: 'webauthn_step_up_required' });
    method = 'webauthn';

    const first = await service.create({ userId: f.a.userId }, { ...scope, stepUpProof: 'webauthn-1' });
    expect(first).toMatchObject({ version: 1, workflowPath: scope.workflowPath, rule: scope.rule });
    await expect(service.create({ userId: f.a.userId }, { ...scope, stepUpProof: 'webauthn-duplicate' }))
      .rejects.toMatchObject({ code: 'exception_already_active' });
    const auditCreated = await f.admin.query<{ detail: { exceptionHash: string; proofId: string } }>(`SELECT detail FROM gotchu.audit_records
      WHERE organization_id=$1 AND subject_id=$2 AND action='workflow.exception_created'`, [f.a.organizationId, first.id]);
    expect(auditCreated.rows[0]?.detail).toMatchObject({ exceptionHash: actionHash, proofId: 'webauthn-1' });

    const otherTenant = createBackend({ database: f.databases.gotchu_api, stepUpVerifier }).workflowExceptions;
    await expect(otherTenant.getHash({ userId: f.b.userId }, { ...scope, organizationId: f.b.organizationId, applicationId: f.b.applicationId }))
      .rejects.toMatchObject({ code: 'repository_link_unavailable' });
    await expect(otherTenant.list({ userId: f.b.userId }, { organizationId: f.b.organizationId, applicationId: f.b.applicationId }))
      .resolves.toMatchObject({ repositories: [], exceptions: [] });

    await service.remove({ userId: f.a.userId }, { organizationId: f.a.organizationId, applicationId: f.a.applicationId,
      repositoryLinkId, exceptionId: first.id, version: first.version });
    await expect(service.list({ userId: f.a.userId }, { organizationId: f.a.organizationId, applicationId: f.a.applicationId }))
      .resolves.toMatchObject({ exceptions: [] });
    const second = await service.create({ userId: f.a.userId }, { ...scope, stepUpProof: 'webauthn-2' });
    expect(second).toMatchObject({ id: first.id, version: 2 });
    const auditRemoved = await f.admin.query<{ count: number }>(`SELECT count(*)::int AS count FROM gotchu.audit_records
      WHERE organization_id=$1 AND subject_id=$2 AND action='workflow.exception_removed'`, [f.a.organizationId, first.id]);
    expect(auditRemoved.rows[0]?.count).toBe(1);
  });
});
