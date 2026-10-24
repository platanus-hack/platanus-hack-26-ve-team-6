import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeGitTreeSha } from '@gotchu/git-adapters';
import { canonicalJson, sha256 } from '../src/core.js';
import { createExecutionArtifactService } from '../src/execution-artifacts.js';
import { fixture, liveUrl } from '../../database/test/support.js';

const live = liveUrl ? describe : describe.skip;

live('execution artifact storage on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture({ max: 2 }); }, 30_000);
  afterAll(async () => { await f?.close(); });

  it('keeps publication bytes private to the executor, tenant scoped, and immutable', async () => {
    const candidateId = randomUUID(); const proposalId = randomUUID();
    const snapshot = { revision: 'a'.repeat(40), files: [{ path: 'src/fix.ts', content: 'export const fixed = true;\n' }] };
    const snapshotDigest = sha256(canonicalJson(snapshot));
    const patchBytes = Buffer.from(snapshot.files[0]!.content, 'utf8');
    const file = { path: 'src/fix.ts', mode: '100644', contentBase64: patchBytes.toString('base64'), sha256: createHash('sha256').update(patchBytes).digest('hex') };
    const patchTreeSha = await computeGitTreeSha([{ path: file.path, mode: '100644', content: snapshot.files[0]!.content }]);
    const epoch = await f.admin.query<{ recovery_epoch: string }>('SELECT recovery_epoch FROM gotchu.platform_state WHERE singleton');
    await f.admin.query('INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [f.a.organizationId, f.a.applicationId, candidateId, snapshotDigest, JSON.stringify(snapshot), f.a.userId]);
    await f.admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id,state,source_ref,blocking_reasons)
      VALUES($1,$2,$3,$4,'{}'::jsonb,$5,2,'source_patch_pull_request','repository.source_patch_pr','ineligible','{}'::jsonb,'[]'::jsonb)`, [f.a.organizationId, f.a.applicationId, proposalId, 'b'.repeat(64), epoch.rows[0]?.recovery_epoch]);
    await f.admin.query(`INSERT INTO gotchu.execution_artifacts(organization_id,application_id,proposal_id,candidate_source_id,base_commit,files,candidate_tree_sha,tree_sha,tree_complete,unsupported_reason,commit_message,snapshot_sha256,patch_sha256,artifact_sha256,size_bytes)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,true,NULL,$9,$10,$11,$10,$12)`, [f.a.organizationId, f.a.applicationId, proposalId, candidateId, snapshot.revision, JSON.stringify([file]), patchTreeSha, 'd'.repeat(40), 'Gotchu approved correction', snapshotDigest, 'e'.repeat(64), Buffer.byteLength(file.path) + patchBytes.byteLength]);

    const apiArtifacts = createExecutionArtifactService(f.databases.gotchu_api);
    const executorArtifacts = createExecutionArtifactService(f.databases.gotchu_executor);
    await expect(apiArtifacts.readForExecutor({ organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT files FROM gotchu.execution_artifacts WHERE proposal_id=$1', [proposalId]))).rejects.toMatchObject({ code: '42501' });
    const artifact = await executorArtifacts.readForExecutor({ organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId });
    expect(artifact).toMatchObject({ baseCommit: snapshot.revision, treeSha: 'd'.repeat(40), treeComplete: true, snapshotSha256: snapshotDigest, patchSha256: 'e'.repeat(64) });
    expect(Buffer.from(artifact.files[0]!.contentBase64, 'base64').toString('utf8')).toBe(snapshot.files[0]!.content);
    expect(await executorArtifacts.verifyCandidateDigest({ organizationId: f.a.organizationId, applicationId: f.a.applicationId, candidateSourceId: candidateId, snapshotSha256: snapshotDigest, patchSha256: 'e'.repeat(64) })).toEqual({ valid: true, treeSha: 'd'.repeat(40), unsupportedReason: null });
    expect(await executorArtifacts.verifyCandidateDigest({ organizationId: f.a.organizationId, applicationId: f.a.applicationId, candidateSourceId: candidateId, snapshotSha256: snapshotDigest, patchSha256: 'f'.repeat(64) })).toEqual({ valid: false, unsupportedReason: 'execution_artifact_digest_mismatch' });

    const hidden = await f.databases.gotchu_executor.tenant(f.b.organizationId, tx => tx.query('SELECT proposal_id FROM gotchu.execution_artifacts WHERE proposal_id=$1', [proposalId]));
    expect(hidden.rowCount).toBe(0);
    await expect(f.databases.gotchu_executor.tenant(f.a.organizationId, tx => tx.query('UPDATE gotchu.execution_artifacts SET commit_message=$2 WHERE proposal_id=$1', [proposalId, 'tampered']))).rejects.toThrow(/permission denied/);
    await expect(f.admin.query('UPDATE gotchu.execution_artifacts SET commit_message=$2 WHERE organization_id=$1 AND proposal_id=$3', [f.a.organizationId, 'tampered', proposalId])).rejects.toThrow(/execution_artifacts_are_immutable/);
    await expect(f.admin.query('DELETE FROM gotchu.execution_artifacts WHERE organization_id=$1 AND proposal_id=$2', [f.a.organizationId, proposalId])).rejects.toThrow(/execution_artifacts_are_immutable/);
  });
});
