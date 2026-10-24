import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionV2, JobEnvelope, ValidationEvidence } from '@gotchu/contracts';
import { setRecoveryState } from '@gotchu/database';
import { computeGitTreeSha, computeGitTreeShaAfterPatch, createGitHubAppAdapter, deterministicBranch, type PullRequestAdapter } from '@gotchu/git-adapters';
import { actionPolicyVersion, canonicalJson, createActionVerifier, createBackend, hashActionV2, readPinnedRootfsDigest, sha256, type VerifiedStepUp } from '@gotchu/backend';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { createBackendActionExecutionLedger, createExecutionJobProcessor, createGitHubActionProvider, loadGitHubWriterAppCredentials } from '../src/index.js';

const enabled = process.env.GOTCHU_TEST_GITHUB === '1';
const writerFile = process.env.GOTCHU_TEST_GITHUB_WRITER_APP_FILE;
const redisUrl = process.env.GOTCHU_TEST_REDIS_URL;
const live = enabled && liveUrl && writerFile && redisUrl ? describe : describe.skip;
const installationId = '174788477';
const owner = '0bkevin';
const repository = 'gotchu-pr-sandbox';

live('live GitHub writer App → approved stored artifact → durable executor; signed validation and WebAuthn proof fixtures', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let tempDirectory: string;
  let api: ReturnType<typeof createBackend>;
  let executor: ReturnType<typeof createBackend>;
  let adapter: PullRequestAdapter;
  let catalogPath: string;
  let branchToClean: string | undefined;
  let pullRequestToClean: number | undefined;
  const proofs = new Map<string, VerifiedStepUp>();
  const now = new Date();

  beforeAll(async () => {
    f = await fixture({ max:4 });
    tempDirectory = await mkdtemp(join(tmpdir(), 'gotchu-live-executor-'));
    catalogPath = join(tempDirectory, 'monitoring-repositories.json');
    await writeFile(catalogPath, JSON.stringify({
      repositoryRoot:tempDirectory,
      repositories:[{ organizationId:f.a.organizationId,applicationId:f.a.applicationId,repositoryKey:'live-github-sandbox',displayName:'Authorized disposable GitHub sandbox',provider:'github',owner,repository }],
    }), { mode:0o600,flag:'wx' });

    const writer = await loadGitHubWriterAppCredentials(present(writerFile));
    adapter = createGitHubAppAdapter({ appId:writer.appId,privateKeyPem:writer.privateKeyPem,installationId,owner,repository });
    const resolved = await adapter.resolveTarget(`${owner}/${repository}`);
    const dependencies = {
      database: f.databases.gotchu_api,
      actionVerifier:createActionVerifier({
        database:f.databases.gotchu_api,
        pinnedRootfsDigest:readPinnedRootfsDigest(),
        validationFacts:{ getFacts:input => createBackend({ database:f.databases.gotchu_api }).validations.getValidationFacts(input) },
        repository:{
          async readHead(scope) { return adapter.readHead(scope.branch); },
          async readTree(input) { return adapter.readTree(input.commitSha); },
          async isPolicyCurrent(input) {
            if (actionPolicyVersion(input.capabilityId) !== input.policyVersion) return false;
            const result = await f.databases.gotchu_api.tenant(input.organizationId, tx => tx.query<{ active_version:string }>('SELECT active_version FROM gotchu.action_policy_registry WHERE capability_id=$1',[input.capabilityId]));
            return result.rows[0]?.active_version === input.policyVersion;
          },
          async inspectAutomation(input) { return adapter.inspectAutomation(input.baseCommit); },
        },
      }),
      stepUpVerifier:{ verify:async ({ proof }: { proof:string }) => {
        const issued=proofs.get(proof);
        if (!issued) throw new Error('TEST ONLY: unissued WebAuthn fixture proof');
        return issued;
      } },
    };
    api = createBackend({ ...dependencies,database:f.databases.gotchu_api });
    executor = createBackend({ ...dependencies,database:f.databases.gotchu_executor,actionVerifier:createActionVerifier({
      database:f.databases.gotchu_executor,pinnedRootfsDigest:readPinnedRootfsDigest(),
      validationFacts:{ getFacts:input => createBackend({ database:f.databases.gotchu_executor }).validations.getValidationFacts(input) },
      repository: {
        async readHead(scope) { return adapter.readHead(scope.branch); },
        async readTree(input) { return adapter.readTree(input.commitSha); },
        async isPolicyCurrent(input) {
          if (actionPolicyVersion(input.capabilityId) !== input.policyVersion) return false;
          const result = await f.databases.gotchu_executor.tenant(input.organizationId, tx => tx.query<{ active_version:string }>('SELECT active_version FROM gotchu.action_policy_registry WHERE capability_id=$1',[input.capabilityId]));
          return result.rows[0]?.active_version === input.policyVersion;
        },
        async inspectAutomation(input) { return adapter.inspectAutomation(input.baseCommit); },
      },
    }),stepUpVerifier:dependencies.stepUpVerifier });
    await setRecoveryState({ connectionString:present(liveUrl),mode:'reconciled',reconciliationReference:'TEST ONLY: authorized private sandbox repository' });
    await f.admin.query("INSERT INTO gotchu.action_executor_instances(instance_id,capability_id) VALUES($1,'repository.source_patch_pr')", [randomUUID()]);
  }, 60_000);

  afterAll(async () => {
    try {
      if (adapter && branchToClean) {
        const pullRequest = pullRequestToClean
          ? await adapter.getPullRequest(pullRequestToClean).catch(() => undefined)
          : await adapter.findPullRequestByBranch(branchToClean).catch(() => undefined);
        if (pullRequest?.state === 'open') await adapter.closePullRequest(pullRequest.number);
        await adapter.deleteBranch(branchToClean);
      }
    } finally {
      if (tempDirectory) await rm(tempDirectory,{recursive:true,force:true});
      await f?.close();
    }
  });

  it('opens one draft PR from the exact DB artifact, verifies its tree, and reconciles duplicate Redis delivery', async () => {
    const resolved = await adapter.resolveTarget(`${owner}/${repository}`);
    const baseCommit = await adapter.readHead(resolved.baseBranch);
    const baseSha = baseCommit;
    const baseTree = await adapter.readTree(baseCommit);
    if (baseTree.truncated) throw new Error('Sandbox base tree was truncated; no write was attempted');
    const sourceId = randomUUID();
    const baseSourceId = randomUUID();
    const repositoryLinkId = randomUUID();
    const proposalId = randomUUID();
    const runId = randomUUID();
    const suiteId = randomUUID();
    const targetFinding = randomUUID();
    const path = `gotchu-live-${randomUUID()}.ts`;
    const content = `export const gotchuLiveCheck = '${randomUUID()}';\n`;
    const patchFiles = [{ path,content,mode:'100644' as const }];
    const candidateTreeSha = await computeGitTreeSha(patchFiles);
    const expectedTreeSha = computeGitTreeShaAfterPatch(baseTree,patchFiles);
    const candidateSnapshot = { revision:baseCommit,files:[{path,content}] };
    const baseSnapshot = { revision:baseCommit,files:[{path:'README.md',content:'Sandbox source context\n'}] };
    const snapshotSha256 = sha256(canonicalJson(candidateSnapshot));
    const baseSnapshotSha256 = sha256(canonicalJson(baseSnapshot));
    const patchSha256 = sha256(canonicalJson(patchFiles));

    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,state,source)
      VALUES($1,$2,$3,'live-github-sandbox',$4,'granted','granted','verified','operator')`, [f.a.organizationId,f.a.applicationId,repositoryLinkId,resolved.baseBranch]);
    await f.admin.query(`INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor)
      VALUES($1,$2,$3,$4,$5::jsonb,$6),($1,$2,$7,$8,$9::jsonb,$6)`, [
      f.a.organizationId,f.a.applicationId,sourceId,snapshotSha256,JSON.stringify(candidateSnapshot),f.a.userId,
      baseSourceId,baseSnapshotSha256,JSON.stringify(baseSnapshot),
    ]);
    await f.admin.query('INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [
      f.a.organizationId,randomUUID(),f.a.userId,'correction.prepared',sourceId,
      JSON.stringify({ recipeId:'live-sandbox-check',recipeVersion:'1',findingId:targetFinding,patchHash:patchSha256,candidateSourceDigest:snapshotSha256,path }),
    ]);
    await f.admin.query(`INSERT INTO gotchu.validation_suite_definitions(organization_id,application_id,repository_link_id,id,version,profile,script_name,suite_name,required_count,created_by)
      VALUES($1,$2,$3,$4,1,'node24-npm-test','test','live signed fixture suite',1,$5)`, [f.a.organizationId,f.a.applicationId,repositoryLinkId,suiteId,f.a.userId]);
    const rootfsDigest=readPinnedRootfsDigest();
    const expiresAt=new Date(Date.now()+3_600_000).toISOString();
    await f.admin.query(`INSERT INTO gotchu.validation_runs(organization_id,application_id,id,action_ref,target_finding_id,candidate_source_id,base_source_id,suite_repository_link_id,suite_definition_id,suite_version,base_snapshot_digest,candidate_tree_digest,patch_digest,state,runner_profile,sandbox_kind,runner_digest,firecracker_digest,kernel_digest,rootfs_digest,limits,cleanup_verified,finished_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$4,$6,$7,$8,1,$9,$10,$11,'passed','node24-npm-test','bwrap+systemd-scope',$12,$12,$12,$13,$14::jsonb,true,clock_timestamp(),$15)`, [
      f.a.organizationId,f.a.applicationId,runId,sourceId,targetFinding,baseSourceId,repositoryLinkId,suiteId,
      baseSnapshotSha256,snapshotSha256,patchSha256,'e'.repeat(64),rootfsDigest,
      JSON.stringify({vcpu:1,memMiB:1024,pids:128,wallMs:120000,outputBytes:262144,diskMiB:2048}),expiresAt,
    ]);
    const keyPair=generateKeyPairSync('ed25519');
    const publicDer=keyPair.publicKey.export({type:'spki',format:'der'});
    const keyId=createHash('sha256').update(publicDer).digest('hex');
    const publicKey=keyPair.publicKey.export({type:'spki',format:'pem'}).toString();
    await f.admin.query('INSERT INTO gotchu.validation_keys(id,public_key) VALUES($1,$2)',[keyId,publicKey]);
    const evidence: ValidationEvidence[] = [
      {kind:'base_reproduction',result:'failed_for_target',exitCode:1,durationMs:10},
      {kind:'candidate_regression',result:'passed',exitCode:0,durationMs:10},
      {kind:'functional_suite',suiteName:'live signed fixture suite',result:'passed',counts:{passed:1,failed:0,skipped:0},baseCounts:{passed:1,failed:0,skipped:0},requiredCounts:1},
      {kind:'independent_rescan',result:'passed',before:{identities:[targetFinding],coverage:'complete'},after:{identities:[],coverage:'complete'},targetedIdentities:[targetFinding]},
    ];
    const validationIds:string[]=[];
    for (const validationEvidence of evidence) {
      const id=randomUUID(); validationIds.push(id);
      const payload={id,organizationId:f.a.organizationId,applicationId:f.a.applicationId,runId,actionRef:sourceId,evidence:validationEvidence,createdAt:now.toISOString(),expiresAt};
      const signature=sign(null,Buffer.from(JSON.stringify(payload)),keyPair.privateKey).toString('base64url');
      await f.admin.query(`INSERT INTO gotchu.validation_attestations(organization_id,application_id,run_id,id,kind,body,key_id,signature,expires_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,[f.a.organizationId,f.a.applicationId,runId,id,validationEvidence.kind,JSON.stringify(payload),keyId,signature,expiresAt]);
    }
    const policyVersion=present(actionPolicyVersion('repository.source_patch_pr'));
    const action:ActionV2={
      version:2,kind:'source_patch_pull_request',capabilityId:'repository.source_patch_pr',organizationId:f.a.organizationId,applicationId:f.a.applicationId,
      policyVersion,target:{kind:'repository',repositoryLinkId,repositoryKey:'live-github-sandbox',branch:resolved.baseBranch},baseCommit,expectedTreeSha,
      recipeId:'live-sandbox-check',recipeVersion:'1',snapshotSha256,patchSha256,findingIdentities:[targetFinding],validationAttestationIds:validationIds,
      evidence:[{id:sourceId,sha256:snapshotSha256,kind:'private_correction_candidate'}],
    };
    const platform=await f.admin.query<{recovery_epoch:string}>('SELECT recovery_epoch FROM gotchu.platform_state WHERE singleton');
    const recoveryEpoch=String(present(platform.rows[0]).recovery_epoch);
    const actionHash=hashActionV2(action,recoveryEpoch);
    branchToClean=deterministicBranch(actionHash);
    await f.admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id,state,blocking_reasons)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,2,'source_patch_pull_request','repository.source_patch_pr','eligible','[]'::jsonb)`,[f.a.organizationId,f.a.applicationId,proposalId,actionHash,JSON.stringify(action),recoveryEpoch]);
    await f.admin.query(`INSERT INTO gotchu.execution_artifacts(organization_id,application_id,proposal_id,candidate_source_id,base_commit,files,candidate_tree_sha,tree_sha,tree_complete,unsupported_reason,commit_message,snapshot_sha256,patch_sha256,artifact_sha256,size_bytes)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,true,NULL,'Gotchu live sandbox correction',$9,$10,$9,$11)`, [
      f.a.organizationId,f.a.applicationId,proposalId,sourceId,baseCommit,
      JSON.stringify([{path,mode:'100644',contentBase64:Buffer.from(content).toString('base64'),sha256:sha256(content)}]),
      candidateTreeSha,expectedTreeSha,snapshotSha256,patchSha256,Buffer.byteLength(path)+Buffer.byteLength(content),
    ]);

    const apiVerifier=createActionVerifier({database:f.databases.gotchu_api,pinnedRootfsDigest:rootfsDigest,validationFacts:{getFacts:input=>api.validations.getValidationFacts(input)},repository:{
      async readHead() { return (await adapter.readHead(resolved.baseBranch)); },
      async readTree(input) { return adapter.readTree(input.commitSha); },
      async isPolicyCurrent(input) { const row=await f.databases.gotchu_api.tenant(input.organizationId,tx=>tx.query<{active_version:string}>('SELECT active_version FROM gotchu.action_policy_registry WHERE capability_id=$1',[input.capabilityId])); return row.rows[0]?.active_version===input.policyVersion&&actionPolicyVersion(input.capabilityId)===input.policyVersion; },
      async inspectAutomation(input) { return adapter.inspectAutomation(input.baseCommit); },
    }});
    api=createBackend({database:f.databases.gotchu_api,actionVerifier:apiVerifier,stepUpVerifier:{verify:async ({proof}:{proof:string})=>present(proofs.get(proof))}});
    const stepUpProof=randomUUID();
    proofs.set(stepUpProof,{proofId:stepUpProof,userId:f.a.userId,organizationId:f.a.organizationId,actionHash,authenticatedAt:now,expiresAt:new Date(now.getTime()+300_000),method:'webauthn'});
    const approval=await api.actions.approve({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId,actionHash,stepUpProof});

    const writer=await loadGitHubWriterAppCredentials(present(writerFile));
    const actionProvider=createGitHubActionProvider({database:f.databases.gotchu_executor,writer,installationId,monitoringConfigFile:catalogPath});
    const processor=createExecutionJobProcessor({database:f.databases.gotchu_executor,backend:executor,ledger:createBackendActionExecutionLedger(executor.executions),provider:actionProvider,leaseMs:30_000,heartbeatIntervalMs:60_000});
    const jobRow=await f.admin.query<{id:string;organization_id:string;application_id:string;state:string;payload:unknown}>("SELECT id,organization_id,application_id,state,payload FROM gotchu.jobs WHERE kind='execution' AND payload->>'approvalId'=$1",[approval.approvalId]);
    const durableJob=present(jobRow.rows[0]);
    expect(durableJob.state).toBe('queued');
    expect((await f.admin.query("SELECT count(*)::int AS count FROM gotchu.outbox WHERE job_id=$1",[durableJob.id])).rows[0]?.count).toBe(1);
    const envelope={version:1 as const,id:durableJob.id,organizationId:durableJob.organization_id,applicationId:durableJob.application_id,kind:'execution' as const} satisfies JobEnvelope;
    const prefix=`executor-live-${randomUUID()}`;
    const connections:Redis[]=[];
    const connect=()=>{const connection=new Redis(present(redisUrl),{maxRetriesPerRequest:null});connections.push(connection);return connection;};
    const queue=new Queue<JobEnvelope>('gotchu-executions-v1',{connection:connect(),prefix});
    const events=new QueueEvents(queue.name,{connection:connect(),prefix});
    const worker=new Worker<JobEnvelope>(queue.name,processor,{connection:connect(),prefix,concurrency:1,lockDuration:30_000});
    await Promise.all([queue.waitUntilReady(),events.waitUntilReady(),worker.waitUntilReady()]);
    try {
      const first=await queue.add('execution',envelope,{jobId:durableJob.id});
      const firstResult=await first.waitUntilFinished(events,60_000);
      expect(firstResult).toMatchObject({status:'verified'});
      const found=await adapter.findPullRequestByBranch(present(branchToClean));
      const pullRequest = present(found);
      pullRequestToClean=pullRequest.number;
      process.stdout.write(`Authorized sandbox verification PR: ${pullRequest.url}\n`);
      expect(pullRequest).toMatchObject({state:'open',draft:true,baseSha,headBranch:branchToClean});
      expect(await actionProvider.verify({action,actionHash,executionId:randomUUID(),artifact:await executor.executionArtifacts.readForExecutor({organizationId:f.a.organizationId,applicationId:f.a.applicationId,candidateSourceId:sourceId}),pullRequest})).toBe('verified');

      await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2",[envelope.organizationId,envelope.id]);
      const prior=await queue.getJob(envelope.id); await prior?.remove();
      const duplicate=await queue.add('execution',envelope,{jobId:envelope.id});
      await expect(duplicate.waitUntilFinished(events,15_000)).resolves.toMatchObject({status:'already_terminal'});
      expect((await adapter.findPullRequestByBranch(present(branchToClean)))?.number).toBe(pullRequestToClean);
      const terminal=await executor.executions.findByApproval({organizationId:f.a.organizationId,approvalId:approval.approvalId});
      expect(terminal).toMatchObject({state:'succeeded',providerReference:pullRequest.url,actionHash});
    } finally {
      await worker.close(); await events.close(); await queue.close();
      for (const connection of connections) await connection.quit();
    }
  },180_000);
});
