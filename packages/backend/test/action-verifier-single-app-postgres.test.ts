import { randomUUID } from 'node:crypto';
import { actionV2Schema } from '@gotchu/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createActionVerifier, type ActionVerifierRepositoryPort } from '../src/action-verifier.js';
import { fixture, liveUrl } from '../../database/test/support.js';

const live = liveUrl ? describe : describe.skip;
const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);

// Provider reads are synthetic; these sources exercise only persisted authority gates.
live('current GitHub writer checks for both PR kinds on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture(); }, 30_000);
  afterAll(async () => { await f?.close(); });

  async function prepare(kind: 'source_patch_pull_request' | 'dependency_pull_request') {
    const repositoryLinkId = randomUUID();
    const installationId = String(Math.floor(Math.random() * 1_000_000_000) + 1);
    const repositoryKey = `gh-${installationId}`;
    await f.admin.query(`INSERT INTO gotchu.github_installations(organization_id,installation_id,account_login,connected_by,state,connection_mode,app_id)
      VALUES($1,$2,'fixture',$3,'active','single_app','12345')`, [f.a.organizationId, installationId, f.a.userId]);
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,
      source,state,read_access,write_access,installation_id,writer_installation_id,writer_verified_at,writer_verified_commit)
      VALUES($1,$2,$3,$4,'main','github_app','verified','granted','granted',$5,$5,now(),$6)`,
    [f.a.organizationId, f.a.applicationId, repositoryLinkId, repositoryKey, installationId, commit]);
    const base = { version: 2, kind, organizationId: f.a.organizationId, applicationId: f.a.applicationId,
      policyVersion: 'fixture', target: { kind: 'repository', repositoryLinkId, repositoryKey, branch: 'main' }, baseCommit: commit,
      evidence: [{ id: randomUUID(), sha256: digest, kind: kind === 'source_patch_pull_request' ? 'private_correction_candidate' : 'dependency_candidate' }], patchSha256: digest };
    const action = actionV2Schema.parse(kind === 'source_patch_pull_request'
      ? { ...base, capabilityId: 'repository.source_patch_pr', snapshotSha256: digest, recipeId: 'fixture', recipeVersion: '1', findingIdentities: ['fixture'], validationAttestationIds: [] }
      : { ...base, capabilityId: 'repository.dependency_pr', candidateCommit: 'c'.repeat(40), changes: [{ name: 'fixture', from: '1.0.0', to: '1.0.1' }],
        advisoryIds: ['GHSA-fixture'], lockfileSha256: digest, rescanAttestationId: randomUUID(), suiteAttestationId: randomUUID() });
    function verifier(writer: Pick<ActionVerifierRepositoryPort, 'writerInstallationId' | 'writerInstallationIdFor'>) {
      return createActionVerifier({ database: f.databases.gotchu_api, pinnedRootfsDigest: digest, validationFacts: { getFacts: async () => null },
        repository: { ...writer, readHead: async () => commit, isPolicyCurrent: async () => true, inspectAutomation: async () => [] } });
    }
    return { action, verifier, repositoryLinkId, repositoryKey, installationId };
  }

  it.each(['source_patch_pull_request', 'dependency_pull_request'] as const)('uses a scoped writer and rejects a revoked installation for %s', async kind => {
    const prepared = await prepare(kind);
    const resolveWriter = vi.fn(async () => prepared.installationId);
    const verifier = prepared.verifier({ writerInstallationId: 'wrong-legacy-installation', writerInstallationIdFor: resolveWriter });
    const active = await verifier.verify(prepared.action, { phase: 'execution' });
    expect(active.blockingReasons).not.toContain('repository_write_access_not_granted');
    expect(active.blockingReasons).not.toContain('github_connection_unavailable');
    expect(resolveWriter).toHaveBeenCalledWith({ organizationId: f.a.organizationId, applicationId: f.a.applicationId,
      repositoryKey: prepared.repositoryKey, repositoryLinkId: prepared.repositoryLinkId });
    // Keep the old link/grant deliberately to exercise installation revalidation itself.
    await f.admin.query("UPDATE gotchu.github_installations SET state='revoked' WHERE organization_id=$1 AND installation_id=$2", [f.a.organizationId, prepared.installationId]);
    expect((await verifier.verify(prepared.action, { phase: 'execution' })).blockingReasons).toContain('github_connection_unavailable');
  });

  it.each(['source_patch_pull_request', 'dependency_pull_request'] as const)('does not revive a denied scoped writer through the legacy property for %s', async kind => {
    const prepared = await prepare(kind);
    for (const resolver of [async () => null, async () => 'different-installation', async (): Promise<string | null> => { throw new Error('unavailable'); }]) {
      const verifier = prepared.verifier({ writerInstallationId: prepared.installationId, writerInstallationIdFor: resolver });
      expect((await verifier.verify(prepared.action, { phase: 'execution' })).blockingReasons).toContain('repository_write_access_not_granted');
    }
    expect((await prepared.verifier({ writerInstallationId: prepared.installationId }).verify(prepared.action, { phase: 'execution' })).blockingReasons)
      .not.toContain('repository_write_access_not_granted');
    expect((await prepared.verifier({ writerInstallationId: 'different-installation' }).verify(prepared.action, { phase: 'execution' })).blockingReasons)
      .toContain('repository_write_access_not_granted');
  });
});
