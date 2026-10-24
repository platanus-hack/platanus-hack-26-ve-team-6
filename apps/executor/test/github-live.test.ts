import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionV2Schema, customerSourceSnapshotSchema, type ActionV2, type JobEnvelope, type ValidationEvidence } from '@gotchu/contracts';
import { createCustomerAssessmentRunner, createNpmArtifactAdapter, createNpmArtifactScanner, createNpmLicenseAdapter, createOsvAdapter, type ScannerAdapter } from '@gotchu/customer-assessment';
import { setRecoveryState } from '@gotchu/database';
import { computeGitTreeSha, computeGitTreeShaAfterPatch, createGitHubAppAdapter, deterministicBranch, GitAdapterError, type PullRequestAdapter } from '@gotchu/git-adapters';
import { actionPolicyVersion, canonicalJson, createActionVerifier, createBackend, createNpmRegistryAdapter, hashActionV2, readPinnedRootfsDigest, sha256, type VerifiedStepUp } from '@gotchu/backend';
import { createValidationWorker } from '@gotchu/validator';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { createBackendActionExecutionLedger, createExecutionJobProcessor, createGitHubActionProvider, loadGitHubWriterAppCredentials } from '../src/index.js';

const enabled = process.env.GOTCHU_TEST_GITHUB === '1';
const writerFile = process.env.GOTCHU_TEST_GITHUB_WRITER_APP_FILE;
const redisUrl = process.env.GOTCHU_TEST_REDIS_URL;
const live = enabled && liveUrl && writerFile && redisUrl ? describe : describe.skip;
const installationId = '174788477';
const owner = '0bkevin';
const repository = 'gotchu-pr-sandbox';
type PullRequestAction=Extract<ActionV2,{kind:'source_patch_pull_request'}>|Extract<ActionV2,{kind:'dependency_pull_request'}>;
const fixtureScanners: ScannerAdapter = {
  async readiness() { return { ready:true,tools:[] }; },
  async run(name,source) {
    const output: unknown = name === 'semgrep'
      ? { version:'test-only',results:[],errors:[],paths:{scanned:source.files.filter(file=>/\.[cm]?[jt]sx?$/i.test(file.path)).map(file=>file.path)} }
      : name === 'gitleaks' ? [] : { SchemaVersion:2,Results:source.files.filter(file=>/\.(?:ya?ml|json)$/i.test(file.path)).map(file=>({Target:file.path,Misconfigurations:[]})) };
    return { output,image:'test-only',version:'test-only',profileChecksum:'0'.repeat(64) };
  },
};

live('live GitHub writer App → approved stored artifact → durable executor; signed validation and WebAuthn proof fixtures', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let tempDirectory: string;
  let api: ReturnType<typeof createBackend>;
  let executor: ReturnType<typeof createBackend>;
  let adapter: PullRequestAdapter;
  let catalogPath: string;
  let actionProvider: ReturnType<typeof createGitHubActionProvider>;
  const publications: { branch:string; pullRequestNumber?:number }[] = [];
  const proofs = new Map<string, VerifiedStepUp>();
  let sandboxRepositoryLinkId: string | undefined;
  const now = new Date();

  beforeAll(async () => {
    f = await fixture({ max:4 });
    tempDirectory = await mkdtemp(join(tmpdir(), 'gotchu-live-executor-'));
    catalogPath = join(tempDirectory, 'monitoring-repositories.json');
    await writeFile(catalogPath, JSON.stringify({
      repositoryRoot:tempDirectory,
      repositories:[{ organizationId:f.a.organizationId,applicationId:f.a.applicationId,repositoryKey:'gh-0bkevin-gotchu-pr-sandbox',displayName:'Authorized disposable GitHub sandbox',provider:'github',owner,repository }],
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
          writerInstallationId:installationId,
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
      repositoryWriteAccessVerifier:async (input:{organizationId:string;applicationId:string;repositoryLinkId:string;repositoryKey:string;branch:string}) => {
        const target=await adapter.resolveTarget(`${owner}/${repository}`);
        if (target.baseBranch!==input.branch) throw new Error('writer_base_branch_mismatch');
        return { installationId,baseCommit:await adapter.readHead(input.branch) };
      },
      npmRegistry:createNpmRegistryAdapter(),
    };
    api = createBackend({ ...dependencies,database:f.databases.gotchu_api });
    executor = createBackend({ ...dependencies,database:f.databases.gotchu_executor,actionVerifier:createActionVerifier({
      database:f.databases.gotchu_executor,pinnedRootfsDigest:readPinnedRootfsDigest(),
      validationFacts:{ getFacts:input => createBackend({ database:f.databases.gotchu_executor }).validations.getValidationFacts(input) },
      repository: {
        writerInstallationId:installationId,
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
    await f.admin.query(`INSERT INTO gotchu.action_executor_instances(instance_id,capability_id)
      VALUES($1,'repository.source_patch_pr'),($1,'repository.dependency_pr')`, [randomUUID()]);
    actionProvider=createGitHubActionProvider({database:f.databases.gotchu_executor,writer,installationId,monitoringConfigFile:catalogPath,publicAppUrl:'http://localhost:3000'});
  }, 60_000);

  afterAll(async () => {
    const cleanupErrors: unknown[]=[];
    try {
      if (adapter) {
        for (const publication of publications) {
          let pullRequest: Awaited<ReturnType<PullRequestAdapter['getPullRequest']>>|undefined;
          try {
            pullRequest=publication.pullRequestNumber
              ? await adapter.getPullRequest(publication.pullRequestNumber)
              : await adapter.findPullRequestByBranch(publication.branch);
          } catch (error) { cleanupErrors.push(error); }
          try {
            if (pullRequest?.state === 'open') await adapter.closePullRequest(pullRequest.number);
          } catch (error) { cleanupErrors.push(error); }
          try { await adapter.deleteBranch(publication.branch); }
          catch (error) { cleanupErrors.push(error); }
          if (pullRequest) {
            try {
              const closed=await adapter.getPullRequest(pullRequest.number);
              if (closed.state !== 'closed') cleanupErrors.push(new Error(`Live PR ${closed.url} remains open after cleanup`));
            } catch (error) { cleanupErrors.push(error); }
          }
          try {
            const remaining=await adapter.findPullRequestByBranch(publication.branch);
            if (remaining?.state === 'open') cleanupErrors.push(new Error(`Live PR ${remaining.url} remains open after cleanup`));
          } catch (error) { cleanupErrors.push(error); }
          try {
            await adapter.readHead(publication.branch);
            cleanupErrors.push(new Error(`Live branch ${publication.branch} remains after cleanup`));
          } catch (error) {
            if (!(error instanceof GitAdapterError) || error.code !== 'not_found') cleanupErrors.push(error);
          }
        }
      }
    } finally {
      if (tempDirectory) await rm(tempDirectory,{recursive:true,force:true});
      await f?.close();
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors,`Live GitHub PR cleanup did not complete: ${cleanupErrors.map(error=>error instanceof Error?error.message:String(error)).join('; ')}`);
  });

  async function grantWriterAccess(repositoryLinkId:string) {
    const challenge=await api.context.getRepositoryWriteAccessChallenge({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,repositoryLinkId,grant:true});
    const proofId=randomUUID();
    const authenticatedAt=new Date();
    const proof:VerifiedStepUp={proofId,userId:f.a.userId,organizationId:f.a.organizationId,actionHash:challenge.actionHash,
      authenticatedAt,expiresAt:new Date(authenticatedAt.getTime()+300_000),method:'webauthn'};
    const opaqueProof=randomUUID(); proofs.set(opaqueProof,proof);
    await api.context.setRepositoryWriteAccess({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,
      repositoryLinkId,grant:true,actionHash:challenge.actionHash,stepUpProof:opaqueProof});
  }

  async function executeApproval(input:{ approvalId:string; actionHash:string; action:PullRequestAction; candidateSourceId:string; branch:string }) {
    const jobRow=await f.admin.query<{id:string;organization_id:string;application_id:string;state:string}>(
      "SELECT id,organization_id,application_id,state FROM gotchu.jobs WHERE kind='execution' AND payload->>'approvalId'=$1",[input.approvalId]);
    const durableJob=present(jobRow.rows[0]);
    expect(durableJob.state).toBe('queued');
    expect((await f.admin.query("SELECT count(*)::int AS count FROM gotchu.outbox WHERE job_id=$1",[durableJob.id])).rows[0]?.count).toBe(1);
    const envelope={version:1 as const,id:durableJob.id,organizationId:durableJob.organization_id,applicationId:durableJob.application_id,kind:'execution' as const} satisfies JobEnvelope;
    const prefix=`executor-live-${randomUUID()}`;
    const connections:Redis[]=[];
    const connect=()=>{const connection=new Redis(present(redisUrl),{maxRetriesPerRequest:null});connections.push(connection);return connection;};
    const queue=new Queue<JobEnvelope>('gotchu-executions-v1',{connection:connect(),prefix});
    const events=new QueueEvents(queue.name,{connection:connect(),prefix});
    const processor=createExecutionJobProcessor({database:f.databases.gotchu_executor,backend:executor,
      ledger:createBackendActionExecutionLedger(executor.executions),provider:actionProvider,leaseMs:30_000,heartbeatIntervalMs:60_000});
    const worker=new Worker<JobEnvelope>(queue.name,processor,{connection:connect(),prefix,concurrency:1,lockDuration:30_000});
    await Promise.all([queue.waitUntilReady(),events.waitUntilReady(),worker.waitUntilReady()]);
    try {
      const first=await queue.add('execution',envelope,{jobId:durableJob.id});
      const executionResult=await first.waitUntilFinished(events,180_000);
      expect(executionResult,JSON.stringify(executionResult)).toMatchObject({status:'verified'});
      const pullRequest=present(await adapter.findPullRequestByBranch(input.branch));
      const publication=publications.find(item=>item.branch===input.branch);
      if (!publication) throw new Error('live_publication_cleanup_registration_missing');
      publication.pullRequestNumber=pullRequest.number;
      process.stdout.write(`Authorized sandbox verification PR: ${pullRequest.url}\n`);
      expect(pullRequest).toMatchObject({state:'open',draft:true,baseSha:input.action.baseCommit,headBranch:input.branch});
      const artifact=await executor.executionArtifacts.readForExecutor({organizationId:f.a.organizationId,applicationId:f.a.applicationId,candidateSourceId:input.candidateSourceId});
      expect(await actionProvider.verify({action:input.action,actionHash:input.actionHash,executionId:randomUUID(),artifact,pullRequest})).toBe('verified');
      if (input.action.kind==='dependency_pull_request') expect(pullRequest.headSha).toBe(input.action.candidateCommit);

      await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2",[envelope.organizationId,envelope.id]);
      const prior=await queue.getJob(envelope.id); await prior?.remove();
      const duplicate=await queue.add('execution',envelope,{jobId:envelope.id});
      await expect(duplicate.waitUntilFinished(events,15_000)).resolves.toMatchObject({status:'already_terminal'});
      expect((await adapter.findPullRequestByBranch(input.branch))?.number).toBe(pullRequest.number);
      const terminal=await executor.executions.findByApproval({organizationId:f.a.organizationId,approvalId:input.approvalId});
      expect(terminal).toMatchObject({state:'succeeded',providerReference:pullRequest.url,actionHash:input.actionHash});
    } finally {
      await worker.close(); await events.close(); await queue.close();
      for (const connection of connections) await connection.quit();
    }
  }

  it('opens one draft PR from the exact DB artifact, verifies its tree, and reconciles duplicate Redis delivery', async () => {
    const resolved = await adapter.resolveTarget(`${owner}/${repository}`);
    const baseCommit = await adapter.readHead(resolved.baseBranch);
    const baseSha = baseCommit;
    const baseTree = await adapter.readTree(baseCommit);
    if (baseTree.truncated) throw new Error('Sandbox base tree was truncated; no write was attempted');
    const sourceId = randomUUID();
    const baseSourceId = randomUUID();
    const repositoryLinkId = randomUUID();
    sandboxRepositoryLinkId = repositoryLinkId;
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

    const readerInstallationId=randomUUID().replaceAll(/\D/g,'').slice(0,20);
    await f.admin.query(`INSERT INTO gotchu.github_installations(organization_id,installation_id,account_login,connected_by,state)
      VALUES($1,$2,'live-sandbox-reader',$3,'active')`,[f.a.organizationId,readerInstallationId,f.a.userId]);
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,state,source,installation_id)
      VALUES($1,$2,$3,'gh-0bkevin-gotchu-pr-sandbox',$4,'granted','not_granted','verified','operator',$5)`, [f.a.organizationId,f.a.applicationId,repositoryLinkId,resolved.baseBranch,readerInstallationId]);
    await grantWriterAccess(repositoryLinkId);
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
      policyVersion,target:{kind:'repository',repositoryLinkId,repositoryKey:'gh-0bkevin-gotchu-pr-sandbox',branch:resolved.baseBranch},baseCommit,expectedTreeSha,
      recipeId:'live-sandbox-check',recipeVersion:'1',snapshotSha256,patchSha256,findingIdentities:[targetFinding],validationAttestationIds:validationIds,
      evidence:[{id:sourceId,sha256:snapshotSha256,kind:'private_correction_candidate'}],
    };
    const platform=await f.admin.query<{recovery_epoch:string}>('SELECT recovery_epoch FROM gotchu.platform_state WHERE singleton');
    const recoveryEpoch=String(present(platform.rows[0]).recovery_epoch);
    const actionHash=hashActionV2(action,recoveryEpoch);
    const branch=deterministicBranch(actionHash);
    publications.push({branch});
    await f.admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id,state,blocking_reasons)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,2,'source_patch_pull_request','repository.source_patch_pr','eligible','[]'::jsonb)`,[f.a.organizationId,f.a.applicationId,proposalId,actionHash,JSON.stringify(action),recoveryEpoch]);
    await f.admin.query(`INSERT INTO gotchu.execution_artifacts(organization_id,application_id,proposal_id,candidate_source_id,base_commit,files,candidate_tree_sha,tree_sha,tree_complete,unsupported_reason,commit_message,snapshot_sha256,patch_sha256,artifact_sha256,size_bytes)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,true,NULL,'Gotchu live sandbox correction',$9,$10,$9,$11)`, [
      f.a.organizationId,f.a.applicationId,proposalId,sourceId,baseCommit,
      JSON.stringify([{path,mode:'100644',contentBase64:Buffer.from(content).toString('base64'),sha256:sha256(content)}]),
      candidateTreeSha,expectedTreeSha,snapshotSha256,patchSha256,Buffer.byteLength(path)+Buffer.byteLength(content),
    ]);

    const stepUpProof=randomUUID();
    const authenticatedAt=new Date();
    proofs.set(stepUpProof,{proofId:stepUpProof,userId:f.a.userId,organizationId:f.a.organizationId,actionHash,authenticatedAt,expiresAt:new Date(authenticatedAt.getTime()+300_000),method:'webauthn'});
    const approval=await api.actions.approve({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId,actionHash,stepUpProof});
    await executeApproval({approvalId:approval.approvalId,actionHash,action,candidateSourceId:sourceId,branch});
  },180_000);

  it('resolves a real sandbox npm advisory in D06, validates the candidate in Firecracker, then opens one exact dependency PR', async () => {
    const resolved=await adapter.resolveTarget(`${owner}/${repository}`);
    const baseCommit=await adapter.readHead(resolved.baseBranch);
    const tree=await adapter.readTree(baseCommit);
    if (tree.truncated) throw new Error('Sandbox source tree was truncated; no write was attempted');
    const paths=tree.entries.filter(entry=>entry.type==='blob'
      && /(?:^|\/)(?:package\.json|package-lock\.json)$|\.(?:[cm]?js|json|ya?ml)$/i.test(entry.path)
      && !entry.path.split('/').some(part=>part==='node_modules'||part==='.git'))
      .map(entry=>entry.path);
    if (!paths.includes('package.json')||!paths.includes('package-lock.json')) throw new Error('Sandbox does not contain a root npm project');
    const files=await Promise.all(paths.map(async path=>({path,content:await adapter.readFile(path,baseCommit)})));
    const snapshot=customerSourceSnapshotSchema.parse({revision:baseCommit,files});
    const sourceFile=files.find(file=>file.path==='package.json');
    if (!sourceFile) throw new Error('Sandbox manifest is missing');
    const manifest:unknown=JSON.parse(sourceFile.content);
    if (typeof manifest!=='object'||manifest===null||!('scripts' in manifest)||typeof manifest.scripts!=='object'||manifest.scripts===null
      || !('test' in manifest.scripts)||typeof manifest.scripts.test!=='string') {
      const scripts = typeof manifest==='object' && manifest!==null && 'scripts' in manifest && typeof manifest.scripts==='object' && manifest.scripts!==null
        ? Object.keys(manifest.scripts) : [];
      throw new Error(`Sandbox must provide an npm test script for candidate validation; available scripts: ${scripts.join(',') || '(none)'}`);
    }

    const repositoryLinkId=present(sandboxRepositoryLinkId);
    const uploaded=await api.customers.uploadSource({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,snapshot,authorized:true});
    await f.admin.query(`INSERT INTO gotchu.customer_source_repository_bindings(organization_id,application_id,source_id,repository_link_id,commit_sha,source_digest)
      VALUES($1,$2,$3,$4,$5,$6)`,[f.a.organizationId,f.a.applicationId,uploaded.id,repositoryLinkId,baseCommit,uploaded.digest]);
    await api.validations.configureSuite({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,
      repositoryLinkId,scriptName:'test',suiteName:'Authorized sandbox npm smoke test',requiredCount:1});

    const request=await api.customers.queue({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,
      mode:'internal',sourceSnapshotId:uploaded.id,targetId:null,idempotencyKey:randomUUID()});
    const job=present(await createBackend({database:f.databases.gotchu_coordinator}).jobs.claim({organizationId:f.a.organizationId,jobId:request.jobId}));
    const input=await createBackend({database:f.databases.gotchu_coordinator}).customers.getRequest({organizationId:f.a.organizationId,applicationId:f.a.applicationId,jobId:request.jobId,leaseToken:job.leaseToken});
    const scanner=createCustomerAssessmentRunner({scanners:fixtureScanners,advisory:createOsvAdapter(),
      artifacts:createNpmArtifactAdapter(createNpmArtifactScanner(fixtureScanners)),licenses:createNpmLicenseAdapter()});
    const report=await scanner.run(input);
    await createBackend({database:f.databases.gotchu_coordinator}).customers.recordResult({input,report,leaseToken:job.leaseToken});
    const reportContext={organizationId:f.a.organizationId,applicationId:f.a.applicationId,reportId:report.id};
    const recommendations=await api.corrections.reportRecommendations({userId:f.a.userId},reportContext);
    const vulnerable=recommendations.dependencyFixes.find(item=>item.status==='eligible'&&item.advisoryIds.length>0);
    if (!vulnerable) throw new Error(`Sandbox scan found no eligible direct npm patch/minor fix: ${JSON.stringify(recommendations.dependencyFixes)}`);
    const findingId=present(vulnerable.findingIds[0]);
    const preparation=await api.corrections.prepareDependencyFix({userId:f.a.userId},{...reportContext,findingId,expectedSourceDigest:uploaded.digest});

    const validatorKey=generateKeyPairSync('ed25519');
    const publicKey=validatorKey.publicKey.export({type:'spki',format:'pem'}).toString();
    const keyId=createHash('sha256').update(validatorKey.publicKey.export({type:'spki',format:'der'})).digest('hex');
    const validator=createValidationWorker({database:f.databases.gotchu_validator,key:{keyId,publicKey,privateKey:validatorKey.privateKey},scanner,shutdownSignal:new AbortController().signal});
    const validationClaim=await validator.claim();
    if (!validationClaim||validationClaim.runId!==preparation.validationRunId) throw new Error('Live D06 Firecracker validation claim did not match the prepared candidate');
    await validator.processClaim(validationClaim);
    const validation=await api.validations.getStatus({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,candidateSourceId:preparation.candidateSourceId});
    expect(validation?.run.state,JSON.stringify(validation)).toBe('passed');
    expect(validation?.attestations.map(item=>item.evidence.kind)).toEqual(expect.arrayContaining(['independent_rescan','functional_suite']));

    const proposed=await api.actions.propose({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,
      kind:'dependency_pull_request',sourceRef:{type:'dependency_candidate',candidateId:preparation.candidateSourceId}});
    const stored=await f.admin.query<{body:unknown}>('SELECT body FROM gotchu.proposals WHERE organization_id=$1 AND id=$2',[f.a.organizationId,proposed.proposalId]);
    const action=actionV2Schema.parse(present(stored.rows[0]).body);
    if (action.kind!=='dependency_pull_request') throw new Error('D06 proposal did not create a dependency PR action');
    const actionRef=present(action.evidence[0]?.id);
    const validationFacts=await api.validations.getValidationFacts({organizationId:f.a.organizationId,actionRef});
    const validationRun=await f.admin.query<{id:string;state:string;sandbox_kind:string;cleanup_verified:boolean;rootfs_digest:string|null}>(
      'SELECT id,state,sandbox_kind,cleanup_verified,rootfs_digest FROM gotchu.validation_runs WHERE organization_id=$1 AND action_ref=$2',[f.a.organizationId,actionRef]);
    expect(actionRef).toBe(preparation.candidateSourceId);
    expect(validationFacts?.state).toBe('passed');
    expect(validationRun.rows[0]).toMatchObject({id:validationFacts?.runId,state:'passed',sandbox_kind:'bwrap+systemd-scope',cleanup_verified:true,rootfs_digest:readPinnedRootfsDigest()});
    expect(action.changes).toEqual([{name:vulnerable.packageName,from:preparation.fromVersion,to:preparation.toVersion}]);
    const artifact=await executor.executionArtifacts.readForExecutor({organizationId:f.a.organizationId,applicationId:f.a.applicationId,candidateSourceId:preparation.candidateSourceId});
    expect(artifact.files.map(file=>file.path).sort()).toEqual(['package-lock.json','package.json']);
    const eligibility=await api.actions.getEligibility({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId:proposed.proposalId});
    expect(eligibility,JSON.stringify(eligibility)).toMatchObject({status:'eligible'});
    const executorEligibility=await executor.actions.getEligibility({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId:proposed.proposalId});
    expect(executorEligibility,JSON.stringify(executorEligibility)).toMatchObject({status:'eligible'});
    const stepUpProof=randomUUID();
    const authenticatedAt=new Date();
    proofs.set(stepUpProof,{proofId:stepUpProof,userId:f.a.userId,organizationId:f.a.organizationId,actionHash:proposed.actionHash,
      authenticatedAt,expiresAt:new Date(authenticatedAt.getTime()+300_000),method:'webauthn'});
    const approval=await api.actions.approve({userId:f.a.userId},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,
      proposalId:proposed.proposalId,actionHash:proposed.actionHash,stepUpProof});
    const branch=deterministicBranch(proposed.actionHash);
    publications.push({branch});
    await executeApproval({approvalId:approval.approvalId,actionHash:proposed.actionHash,action,candidateSourceId:preparation.candidateSourceId,branch});
  },600_000);
});
