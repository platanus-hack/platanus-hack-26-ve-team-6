import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { ActionV2, JobEnvelope } from '@gotchu/contracts';
import { setRecoveryState } from '@gotchu/database';
import { computeGitTreeSha, computeGitTreeShaAfterPatch, GitAdapterError, type PullRequest } from '@gotchu/git-adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionPolicyVersion, BackendError, canonicalJson, createBackend, hashActionV2, sha256, type VerifiedStepUp } from '@gotchu/backend';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { createBackendActionExecutionLedger, createExecutionJobProcessor, type ActionProvider } from '../src/index.js';

const redisUrl = process.env.GOTCHU_TEST_REDIS_URL;
const live = liveUrl && redisUrl ? describe : describe.skip;
type CrashStage = 'branch' | 'pull_request' | 'verify';

live('durable v2 execution jobs on real Postgres and Redis; injected validation, WebAuthn, and provider outcomes', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let backend: ReturnType<typeof createBackend>;
  const proofs = new Map<string, VerifiedStepUp>();
  const executorInstanceId = randomUUID();
  const now = new Date();

  beforeAll(async () => {
    f = await fixture({ max: 4 });
    await f.admin.query("INSERT INTO gotchu.action_executor_instances(instance_id,capability_id) VALUES($1,'repository.source_patch_pr')", [executorInstanceId]);
    const dependencies = {
      actionVerifier: { verify: async () => ({ eligible: true, blockingReasons: [], policyCurrent: true }) },
      stepUpVerifier: { verify: async ({ proof }: { proof: string }) => {
        const issued = proofs.get(proof);
        if (!issued) throw new BackendError('step_up_required', 'TEST ONLY: unissued fixture proof', 403);
        return issued;
      } },
    };
    api = createBackend({ ...dependencies, database: f.databases.gotchu_api });
    backend = createBackend({ ...dependencies, database: f.databases.gotchu_executor });
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'TEST ONLY: provider uses stored fixture artifact' });
  }, 30_000);

  afterAll(async () => {
    if (!f) return;
    await f.admin.query('DELETE FROM gotchu.action_executor_instances WHERE instance_id=$1', [executorInstanceId]);
    await f.close();
  });

  async function approvedJob() {
    const sourceId = randomUUID();
    const repositoryLinkId = randomUUID();
    const proposalId = randomUUID();
    const baseCommit = 'a'.repeat(40);
    const content = `export const fixed = '${randomUUID()}';\n`;
    const patchFiles = [{ path: 'src/fix.ts', content, mode: '100644' as const }];
    const candidateTreeSha = await computeGitTreeSha(patchFiles);
    const baseTree = { treeSha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', truncated: false, entries: [] };
    const expectedTreeSha = computeGitTreeShaAfterPatch(baseTree, patchFiles);
    const snapshot = { revision: baseCommit, files: [{ path: 'src/fix.ts', content }] };
    const snapshotSha256 = sha256(canonicalJson(snapshot));
    const patchSha256 = sha256(canonicalJson(patchFiles));
    const repositoryKey = `sandbox:${sourceId}`;
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,state,source,writer_installation_id,writer_verified_at,writer_verified_commit)
      VALUES($1,$2,$3,$4,'main','granted','granted','verified','operator','174788477',clock_timestamp(),$5)`, [f.a.organizationId,f.a.applicationId,repositoryLinkId,repositoryKey,'a'.repeat(40)]);
    await f.admin.query('INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [f.a.organizationId,f.a.applicationId,sourceId,snapshotSha256,JSON.stringify(snapshot),f.a.userId]);
    const policyVersion = present(actionPolicyVersion('repository.source_patch_pr'));
    const action: ActionV2 = {
      version: 2, kind: 'source_patch_pull_request', capabilityId: 'repository.source_patch_pr', organizationId: f.a.organizationId, applicationId: f.a.applicationId,
      policyVersion, target: { kind: 'repository', repositoryLinkId, repositoryKey, branch: 'main' }, baseCommit,
      expectedTreeSha, recipeId: 'test-only-correction', recipeVersion: '1', snapshotSha256, patchSha256,
      findingIdentities: ['test-finding'], validationAttestationIds: [randomUUID()],
      evidence: [{ id: sourceId, sha256: snapshotSha256, kind: 'private_correction_candidate' }],
    };
    const epochRow = await f.admin.query<{ recovery_epoch: string }>('SELECT recovery_epoch FROM gotchu.platform_state WHERE singleton');
    const recoveryEpoch = String(present(epochRow.rows[0]).recovery_epoch);
    const actionHash = hashActionV2(action, recoveryEpoch);
    await f.admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id,state,blocking_reasons)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,2,'source_patch_pull_request','repository.source_patch_pr','eligible','[]'::jsonb)`, [f.a.organizationId,f.a.applicationId,proposalId,actionHash,JSON.stringify(action),recoveryEpoch]);
    await f.admin.query(`INSERT INTO gotchu.execution_artifacts(organization_id,application_id,proposal_id,candidate_source_id,base_commit,files,candidate_tree_sha,tree_sha,tree_complete,unsupported_reason,commit_message,snapshot_sha256,patch_sha256,artifact_sha256,size_bytes)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,true,NULL,'Exact stored correction',$9,$10,$9,$11)`, [
      f.a.organizationId,f.a.applicationId,proposalId,sourceId,baseCommit,
      JSON.stringify([{ path:'src/fix.ts',mode:'100644',contentBase64:Buffer.from(content).toString('base64'),sha256:sha256(content) }]),
      candidateTreeSha,expectedTreeSha,snapshotSha256,patchSha256,Buffer.byteLength('src/fix.ts')+Buffer.byteLength(content),
    ]);
    const stepUpProof = randomUUID();
    proofs.set(stepUpProof, { proofId: stepUpProof,userId:f.a.userId,organizationId:f.a.organizationId,actionHash,authenticatedAt:now,expiresAt:new Date(now.getTime()+300_000),method:'webauthn' });
    const approval = await api.actions.approve({ userId:f.a.userId }, { organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId,actionHash,stepUpProof });
    const job = await f.admin.query<{ id:string; organization_id:string; application_id:string }>("SELECT id,organization_id,application_id FROM gotchu.jobs WHERE kind='execution' AND payload->>'approvalId'=$1", [approval.approvalId]);
    const row = present(job.rows[0]);
    return {
      approvalId: approval.approvalId,
      actionHash,
      baseCommit,
      expectedTreeSha,
      envelope: { version:1 as const,id:row.id,organizationId:row.organization_id,applicationId:row.application_id,kind:'execution' as const } satisfies JobEnvelope,
      sourceId,
    };
  }

  function providerFor(input: { baseCommit:string; expectedTreeSha:string; actionHash:string; failAfter:CrashStage }) {
    let branch: { name:string; commitSha:string } | undefined;
    let pullRequest: PullRequest | undefined;
    const failures = new Set<CrashStage>();
    let branchPublishes = 0;
    let pullRequestCreates = 0;
    const url = `https://github.com/gotchu-test/repo/pull/${Math.floor(Math.random()*100000)+1}`;
    const provider: ActionProvider = {
      async reconcile() {
        if (pullRequest) return { status:'pull_request_found',pullRequest };
        if (branch) return { status:'branch_found',branch:branch.name,commitSha:branch.commitSha };
        return { status:'definitely_not_applied' };
      },
      async publishBranch(value) {
        await value.beforeWrite();
        branchPublishes++;
        branch = { name:`gotchu/action-${input.actionHash.slice(0,16)}`,commitSha:'b'.repeat(40) };
        if (input.failAfter === 'branch' && !failures.has('branch')) { failures.add('branch'); throw new GitAdapterError('unknown_outcome'); }
        return { branch:branch.name,commitSha:branch.commitSha };
      },
      async openPullRequest(value) {
        await value.beforeWrite();
        pullRequestCreates++;
        if (!branch || value.commitSha !== branch.commitSha) throw new Error('branch did not match exact provider commit');
        pullRequest = { number:41,url,state:'open',draft:true,headSha:value.commitSha,headBranch:value.branch,baseSha:input.baseCommit,baseBranch:'main' };
        if (input.failAfter === 'pull_request' && !failures.has('pull_request')) { failures.add('pull_request'); throw new GitAdapterError('unknown_outcome'); }
        return pullRequest;
      },
      async verify(value) {
        if (!pullRequest || value.pullRequest.url !== pullRequest.url
          || value.action.kind !== 'source_patch_pull_request' || value.action.expectedTreeSha !== input.expectedTreeSha) throw new Error('exact provider effect was not present');
        if (input.failAfter === 'verify' && !failures.has('verify')) { failures.add('verify'); throw new GitAdapterError('unknown_outcome'); }
        return 'verified';
      },
    };
    return { provider, counts:() => ({ branchPublishes,pullRequestCreates }), pullRequest:() => pullRequest };
  }

  it.each(['branch','pull_request','verify'] as const)('reconciles a lost %s-stage result from Postgres and Redis without creating a second PR', async failAfter => {
    const approved = await approvedJob();
    const mockProvider = providerFor({ ...approved, failAfter });
    const queuePrefix = `executor-test-${randomUUID()}`;
    const connections: Redis[] = [];
    const connect = () => { const connection = new Redis(present(redisUrl), { maxRetriesPerRequest:null }); connections.push(connection); return connection; };
    const queue = new Queue<JobEnvelope>('gotchu-executions-v1', { connection:connect(),prefix:queuePrefix });
    const events = new QueueEvents(queue.name, { connection:connect(),prefix:queuePrefix });
    const processor = createExecutionJobProcessor({
      database:f.databases.gotchu_executor,
      backend,
      ledger:createBackendActionExecutionLedger(backend.executions),
      provider:mockProvider.provider,
      leaseMs:30_000,
      heartbeatIntervalMs:60_000,
    });
    let worker = new Worker<JobEnvelope>(queue.name, processor, { connection:connect(),prefix:queuePrefix,concurrency:1,lockDuration:30_000 });
    await Promise.all([queue.waitUntilReady(),events.waitUntilReady(),worker.waitUntilReady()]);
    let frozeRecovery = false;
    try {
      const first = await queue.add('execution', approved.envelope, { jobId:approved.envelope.id });
      const firstResult = await first.waitUntilFinished(events, 15_000);
      expect(firstResult).toMatchObject({ status:'uncertain' });
      expect((await f.admin.query('SELECT state FROM gotchu.jobs WHERE organization_id=$1 AND id=$2',[approved.envelope.organizationId,approved.envelope.id])).rows[0]?.state).toBe('running');

      await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2", [approved.envelope.organizationId,approved.envelope.id]);
      const prior = await queue.getJob(approved.envelope.id);
      await prior?.remove();
      if (failAfter === 'verify') {
        await setRecoveryState({ connectionString:present(liveUrl),mode:'freeze' });
        frozeRecovery = true;
      }
      const redelivery = await queue.add('execution', approved.envelope, { jobId:approved.envelope.id });
      await expect(redelivery.waitUntilFinished(events, 15_000)).resolves.toMatchObject({ status:'verified' });
      expect(mockProvider.counts()).toEqual({ branchPublishes:1,pullRequestCreates:1 });
      expect(mockProvider.pullRequest()).toMatchObject({ draft:true,baseSha:approved.baseCommit,headSha:'b'.repeat(40) });

      const execution = present(await backend.executions.findByApproval({ organizationId:approved.envelope.organizationId,approvalId:approved.approvalId }));
      expect(execution).toMatchObject({ state:'succeeded',providerReference:mockProvider.pullRequest()?.url,actionHash:approved.actionHash });
      const attempts = await f.admin.query<{ step:string; state:string }>('SELECT step,state FROM gotchu.executor_attempt_events WHERE organization_id=$1 AND execution_id=$2', [approved.envelope.organizationId,execution.executionId]);
      expect(attempts.rows.map(attempt => `${attempt.step}:${attempt.state}`)).toEqual(expect.arrayContaining(['claim:claimed','publish_branch:branch_published','open_pr:pr_opened','verify:verified']));
      expect((await f.admin.query('SELECT state FROM gotchu.jobs WHERE organization_id=$1 AND id=$2',[approved.envelope.organizationId,approved.envelope.id])).rows[0]?.state).toBe('succeeded');

      await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2", [approved.envelope.organizationId,approved.envelope.id]);
      const completed = await queue.getJob(approved.envelope.id);
      await completed?.remove();
      const duplicate = await queue.add('execution', approved.envelope, { jobId:approved.envelope.id });
      await expect(duplicate.waitUntilFinished(events, 15_000)).resolves.toMatchObject({ status:'already_terminal' });
      expect(mockProvider.counts()).toEqual({ branchPublishes:1,pullRequestCreates:1 });
    } finally {
      if (frozeRecovery) await setRecoveryState({ connectionString:present(liveUrl),mode:'reconciled',reconciliationReference:'TEST ONLY: completed read-only executor reconciliation' });
      await worker.close();
      await events.close();
      await queue.close();
      for (const connection of connections) await connection.quit();
    }
  }, 60_000);
});
