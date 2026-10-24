import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertAutomationSafe, assertWorkflowPatchSafe, createGitHubAppAdapter, createLocalGitAdapter, deterministicBranch, GitAdapterError, type PullRequest } from '../src/index.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir,{recursive:true,force:true}))); });
function command(cwd:string,...args:string[]) { const result=spawnSync('git',args,{cwd,encoding:'utf8'}); if(result.status!==0) throw new Error(result.stderr); return result.stdout.trim(); }
async function localRepo() {
  const root=await mkdtemp(join(tmpdir(),'gotchu-adapter-')); dirs.push(root); const seed=join(root,'seed'); await mkdir(seed);
  command(seed,'init','-b','main'); command(seed,'-c','user.name=Test','-c','user.email=test@localhost','commit','--allow-empty','-m','base');
  const bare=join(root,'repository.git'); command(root,'clone','--bare',seed,bare); return {root,bare,base:command(seed,'rev-parse','HEAD')};
}

describe('git adapters', () => {
  it('derives a deterministic branch and rejects workflow changes', () => {
    expect(deterministicBranch('a'.repeat(64))).toBe('gotchu/aaaaaaaaaaaaaaaa');
    expect(() => assertWorkflowPatchSafe([{path:'.github/workflows/release.yml',content:'on: push'}])).toThrow(GitAdapterError);
  });

  it('rejects unsafe workflow triggers and malformed workflow data', () => {
    expect(() => assertAutomationSafe([{path:'.github/workflows/release.yml',content:'on:\n  pull_request_target:\n'}])).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe([{path:'../x',content:'on: push'}])).toThrow();
    expect(() => assertAutomationSafe([{path:'.github/workflows/ci.yml',content:'on:\n  push:\n    branches: ["gotchu/**"]'}])).toThrow(GitAdapterError);
  });

  it('publishes one local PR equivalent on duplicate delivery and refuses a moved base', async () => {
    const repo=await localRepo(); const adapter=await createLocalGitAdapter(repo.root);
    const input={actionHash:'b'.repeat(64),baseBranch:'main',baseSha:repo.base,files:[{path:'src/fix.txt',content:'fixed'}]};
    const published=await adapter.publishCommit(input);
    expect(await adapter.publishCommit(input)).toEqual(published);
    const evidenceSummary={rescan:'passed',suite:'passed',regression:'passed',runnerIsolation:'verified'} as const;
    const first=await adapter.openOrFindPullRequest({branch:published.branch,commitSha:published.commitSha,actionHash:input.actionHash,baseBranch:'main',baseSha:repo.base,evidenceSummary});
    const second=await adapter.openOrFindPullRequest({branch:published.branch,commitSha:published.commitSha,actionHash:input.actionHash,baseBranch:'main',baseSha:repo.base,evidenceSummary});
    expect(second.number).toBe(first.number);
    expect(await adapter.getPullRequest(first.number)).toEqual(first);
    expect((await adapter.listRequiredChecks(first.headSha))).toEqual([]);
    const seed=join(repo.root,'seed'); command(seed,'-c','user.name=Test','-c','user.email=test@localhost','commit','--allow-empty','-m','move'); command(seed,'push',repo.bare,'main');
    await expect(adapter.publishCommit(input)).rejects.toMatchObject({code:'conflict'});
    await adapter.closePullRequest(first.number);
    expect(await adapter.getPullRequest(first.number)).toMatchObject({state:'closed'});
  });

  it('zod rejects a malformed GitHub repository response', async () => {
    const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
    const adapter=createGitHubAppAdapter({appId:'1234',installationId:'5',privateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}).toString(),owner:'owner',repository:'repo',fetchImplementation:async()=>new Response(JSON.stringify({unexpected:true}),{status:200})});
    await expect(adapter.resolveTarget('owner/repo')).rejects.toMatchObject({code:'malformed_response'});
  });
});

const live = process.env.GOTCHU_TEST_GITHUB === '1' ? describe : describe.skip;
const liveCredentialsPath=process.env.GOTCHU_TEST_GITHUB_WRITER_APP;
live('real provider checks: GitHub App writer sandbox', () => {
  it('publishes one exact branch and PR, reconciles timeout, rejects a moved base, and cleans up', async () => {
    if(!liveCredentialsPath) throw new Error('GOTCHU_TEST_GITHUB_WRITER_APP is required for live GitHub checks');
    const raw: unknown=JSON.parse(await readFile(liveCredentialsPath,'utf8'));
    const credentials=z.object({id:z.union([z.string(),z.number()]).transform(String),privateKeyPem:z.string().min(100)}).passthrough().parse(raw);
    const installationId='174788477'; const owner='0bkevin'; const repository='gotchu-pr-sandbox';
    let simulateTimeout=false;
    const adapter=createGitHubAppAdapter({appId:credentials.id,installationId,privateKeyPem:credentials.privateKeyPem,owner,repository,fetchImplementation:async(input,init)=>{
      const response=await fetch(input,init);
      if(simulateTimeout&&init?.method==='POST'&&String(input).endsWith('/pulls')&&response.status===201){simulateTimeout=false;throw new Error('simulated response lost after PR creation');}
      return response;
    }});
    const target=await adapter.resolveTarget(`${owner}/${repository}`);
    const baseSha=await adapter.readHead(target.baseBranch);
    const actionHash=randomBytes(32).toString('hex');
    const branch=deterministicBranch(actionHash);
    let pr: PullRequest | undefined;
    let publishedCommit: string | undefined;
    try {
      const published=await adapter.publishCommit({actionHash,baseBranch:target.baseBranch,baseSha,files:[{path:`gotchu-evidence/${actionHash.slice(0,8)}.txt`,content:`Approved test patch ${actionHash}\n`} ]});
      publishedCommit=published.commitSha;
      expect(published.branch).toBe(branch);
      expect(await adapter.publishCommit({actionHash,baseBranch:target.baseBranch,baseSha,files:[{path:`gotchu-evidence/${actionHash.slice(0,8)}.txt`,content:`Approved test patch ${actionHash}\n`} ]})).toEqual(published);
      simulateTimeout=true;
      const evidenceSummary={rescan:'passed',suite:'passed',regression:'passed',runnerIsolation:'verified'} as const;
      pr=await adapter.openOrFindPullRequest({actionHash,branch,commitSha:published.commitSha,baseBranch:target.baseBranch,baseSha,evidenceSummary});
      expect(await adapter.getPullRequest(pr.number)).toMatchObject({state:'open',headSha:published.commitSha,baseBranch:target.baseBranch,baseSha});
      const duplicate=await adapter.openOrFindPullRequest({actionHash,branch,commitSha:published.commitSha,baseBranch:target.baseBranch,baseSha,evidenceSummary});
      expect(duplicate.number).toBe(pr.number);
      const wrongBase='0'.repeat(40);
      await expect(adapter.publishCommit({actionHash:'d'.repeat(64),baseBranch:target.baseBranch,baseSha:wrongBase,files:[{path:'gotchu-evidence/stale.txt',content:'stale'}]})).rejects.toMatchObject({code:'conflict'});
    } finally {
      try { if(pr) await adapter.closePullRequest(pr.number); }
      finally { await adapter.deleteBranch(branch); }
      if(pr&&publishedCommit) await writeLiveEvidence({createdAndClosedPullRequests:[pr.number],branch,headSha:publishedCommit,baseSha});
    }
  },60_000);

  it('classifies an invalid installation as revoked access', async () => {
    if(!liveCredentialsPath) throw new Error('GOTCHU_TEST_GITHUB_WRITER_APP is required for live GitHub checks');
    const raw: unknown=JSON.parse(await readFile(liveCredentialsPath,'utf8'));
    const credentials=z.object({id:z.union([z.string(),z.number()]).transform(String),privateKeyPem:z.string().min(100)}).passthrough().parse(raw);
    const adapter=createGitHubAppAdapter({appId:credentials.id,installationId:'1',privateKeyPem:credentials.privateKeyPem,owner:'0bkevin',repository:'gotchu-pr-sandbox'});
    await expect(adapter.resolveTarget('0bkevin/gotchu-pr-sandbox')).rejects.toMatchObject({code:'provider_access_revoked'});
  },30_000);
});

async function writeLiveEvidence(value: unknown) {
  const path=process.env.GOTCHU_TEST_GITHUB_RESULT_FILE;
  if(path) await writeFile(path,JSON.stringify(value),'utf8');
}
