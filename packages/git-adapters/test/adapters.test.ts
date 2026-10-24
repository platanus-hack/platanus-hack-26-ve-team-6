import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertAutomationSafe, assertWorkflowPatchSafe, computeGitTreeSha, computeGitTreeShaAfterPatch, createGitHubAppAdapter, createLocalGitAdapter, deterministicBranch, GitAdapterError, inspectWorkflowPolicy, verifyPublishedTree, type PullRequest } from '../src/index.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir,{recursive:true,force:true}))); });
function command(cwd:string,...args:string[]) { const result=spawnSync('git',args,{cwd,encoding:'utf8'}); if(result.status!==0) throw new Error(result.stderr); return result.stdout.trim(); }
async function localRepo() {
  const root=await mkdtemp(join(tmpdir(),'gotchu-adapter-')); dirs.push(root); const seed=join(root,'seed'); await mkdir(seed);
  command(seed,'init','-b','main'); await mkdir(join(seed,'src')); await writeFile(join(seed,'README.md'),'base readme\n'); await writeFile(join(seed,'src','unchanged.ts'),'export const unchanged = true;\n');
  command(seed,'add','--all'); command(seed,'-c','user.name=Test','-c','user.email=test@localhost','commit','-m','base');
  const bare=join(root,'repository.git'); command(root,'clone','--bare',seed,bare); return {root,bare,seed,base:command(seed,'rev-parse','HEAD')};
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
    expect(() => assertAutomationSafe([{path:'.github/workflows/ci.yml',content:'on: push\njobs: {}'}])).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe([{path:'.github/workflows/ci.yml',content:'on: pull_request\njobs:\n  test:\n    steps:\n      - run: echo ${{ secrets.NPM_TOKEN }}'}])).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe([{path:'.github/workflows/ci.yml',content:'on: ['}])).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe([{path:'.github/workflows/ci.yml',content:'on: pull_request\njobs:\n  test:\n    steps:\n      - run: echo ${{ secrets.GITHUB_TOKEN }}'}])).not.toThrow();
    expect(() => assertAutomationSafe([{path:'.github/workflows/ci.yml',content:'on:\n  pull_request_target:\n'}], [{path:'.github/workflows/ci.yml',rule:'pull_request_target'}])).not.toThrow();
    expect(() => assertAutomationSafe([{path:'.github/workflows/other.yml',content:'on:\n  pull_request_target:\n'}], [{path:'.github/workflows/ci.yml',rule:'pull_request_target'}])).toThrow(GitAdapterError);
  });

  it('reports each workflow rule with its path', () => {
    const cases = [
      ['on: [', 'invalid_yaml'],
      ['- not-a-workflow-document', 'invalid_document'],
      ['on: pull_request_target', 'pull_request_target'],
      ['on: push', 'push_without_branch_filter'],
      ['on:\n  push:\n    branches: ["gotchu/**"]', 'push_to_gotchu_branch'],
      ['on: pull_request\njobs:\n  test:\n    steps:\n      - run: echo ${{ secrets.NPM_TOKEN }}', 'forbidden_pull_request_secret'],
    ] as const;
    for (const [content, rule] of cases) expect(inspectWorkflowPolicy([{ path: '.github/workflows/ci.yml', content }])).toContainEqual({ path: '.github/workflows/ci.yml', rule });
  });

  it('computes the same candidate tree as git and verifies a published PR tree', async () => {
    const files = [{ path: 'src/fix.txt', content: 'fixed\n' }, { path: 'bin/tool', content: 'tool\n', mode: '100755' as const }];
    const repo = await localRepo();
    const treeRoot = await mkdtemp(join(tmpdir(), 'gotchu-tree-reference-')); dirs.push(treeRoot);
    command(treeRoot, 'init', '--quiet');
    for (const file of files) { const target = join(treeRoot, file.path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, file.content, { mode: file.mode === '100755' ? 0o755 : 0o644 }); }
    command(treeRoot, 'add', '--all');
    const expected = command(treeRoot, 'write-tree');
    expect(await computeGitTreeSha(files)).toBe(expected);
    const adapter = await createLocalGitAdapter(repo.root);
    const baseSha = repo.base;
    const artifactTreeSha = computeGitTreeShaAfterPatch(await adapter.readTree(baseSha), files);
    const published = await adapter.publishCommit({ actionHash: 'e'.repeat(64), baseBranch: 'main', baseSha, files });
    expect(await adapter.readTreeSha(published.commitSha)).toBe(artifactTreeSha);
    expect(await verifyPublishedTree({ adapter, headCommitSha: published.commitSha, artifactTreeSha })).toBe(true);
    expect(await verifyPublishedTree({ adapter, headCommitSha: published.commitSha, artifactTreeSha: 'f'.repeat(40) })).toBe(false);
  });

  it('overlays a patch onto a complete base tree and matches a real Git tree object', async () => {
    const repo=await localRepo(); const adapter=await createLocalGitAdapter(repo.root);
    const baseTree=await adapter.readTree(repo.base);
    const patch=[{path:'src/unchanged.ts',content:'export const unchanged = false;\n'},{path:'src/new.ts',content:'export const added = true;\n'}];
    const candidate=await mkdtemp(join(tmpdir(),'gotchu-tree-overlay-')); dirs.push(candidate);
    await mkdir(join(candidate,'src'),{recursive:true});
    await writeFile(join(candidate,'README.md'),'base readme\n');
    await writeFile(join(candidate,'src','unchanged.ts'),patch[0]!.content);
    await writeFile(join(candidate,'src','new.ts'),patch[1]!.content);
    command(candidate,'init','--quiet'); command(candidate,'add','--all');
    const expected=command(candidate,'write-tree');
    expect(computeGitTreeShaAfterPatch(baseTree,patch)).toBe(expected);
    expect(await adapter.readTreeSha(repo.base)).toBe(baseTree.treeSha);
    expect(() => computeGitTreeShaAfterPatch({...baseTree,truncated:true},patch)).toThrow(GitAdapterError);
  });

  it('reads workflow files from the approved local base commit and reports the exact policy rule', async () => {
    const root=await mkdtemp(join(tmpdir(),'gotchu-workflow-inspection-')); dirs.push(root);
    const seed=join(root,'seed'); await mkdir(join(seed,'.github','workflows'),{recursive:true});
    await writeFile(join(seed,'.github','workflows','unsafe.yml'),'on: pull_request_target\n');
    command(seed,'init','-b','main'); command(seed,'add','--all'); command(seed,'-c','user.name=Test','-c','user.email=test@localhost','commit','-m','workflow');
    command(root,'clone','--bare',seed,join(root,'repository.git'));
    const adapter=await createLocalGitAdapter(root);
    const base=command(seed,'rev-parse','HEAD');
    await expect(adapter.inspectAutomation(base)).resolves.toEqual([{path:'.github/workflows/unsafe.yml',rule:'pull_request_target'}]);
    const input={actionHash:'a'.repeat(64),baseBranch:'main',baseSha:base,files:[{path:'src/fix.ts',content:'fixed\n'}]};
    await expect(adapter.publishCommit(input)).rejects.toMatchObject({code:'repository_automation_unsafe'});
    await expect(adapter.publishCommit({...input,workflowExceptions:[{path:'.github/workflows/unsafe.yml',rule:'pull_request_target'}]})).resolves.toMatchObject({branch:'gotchu/aaaaaaaaaaaaaaaa'});
  });

  it('evaluates push inclusion and exclusion filters against the proposed owned branch', () => {
    const workflow=(filter:string)=>[{path:'.github/workflows/ci.yml',content:`on:\n  push:\n    ${filter}\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe`}];
    const branch='gotchu/aaaaaaaaaaaaaaaa';
    expect(() => assertAutomationSafe(workflow('branches-ignore: [main]'))).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe(workflow('branches: [gotchu/a*]'))).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe(workflow('branches: [main]'))).not.toThrow();
    expect(() => assertAutomationSafe(workflow('branches-ignore: ["gotchu/**"]'))).not.toThrow();
    expect(() => assertAutomationSafe(workflow('branches: ["gotchu/**", "!gotchu/a*"]'),false,branch)).not.toThrow();
    expect(() => assertAutomationSafe(workflow('branches: ["gotchu/**", "!gotchu/b*"]'),false,branch)).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe(workflow('branches-ignore: ["gotchu/**"]'),false,branch)).not.toThrow();
    expect(() => assertAutomationSafe(workflow('branches-ignore: [main]'),false,branch)).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe(workflow('branches-ignore: ["!gotchu/**"]'),false,branch)).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe(workflow('branches: ["gotchu/[ab]*"]'),false,branch)).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe(workflow('branches: ["gotchu/**", "!gotchu/**"]'))).toThrow(GitAdapterError);
  });

  it('rejects unsupported question-mark branch patterns in exact and namespace modes', () => {
    const branch = 'gotchu/aaaaaaaaaaaaaaaa';
    const workflow = (filter: string) => [{path:'.github/workflows/ci.yml',content:`on:\n  push:\n    ${filter}\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe`}];
    for (const filter of [
      'branches: ["gotchu/**", "!gotchu/aaaaaaaaaaaaaaa?"]',
      'branches: [main, "!gotchu/aaaaaaaaaaaaaaa?"]',
      'branches: ["main?"]',
      'branches-ignore: ["gotchu/aaaaaaaaaaaaaaa?"]',
    ]) {
      expect(() => assertAutomationSafe(workflow(filter), false, branch)).toThrow(GitAdapterError);
      expect(() => assertAutomationSafe(workflow(filter))).toThrow(GitAdapterError);
    }
  });

  it('checks secret expressions throughout pull request workflows', () => {
    const workflow=(extra:string)=>[{path:'.github/workflows/ci.yml',content:`on: pull_request\n${extra}\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe`}];
    for (const value of [
      'env:\n  TOKEN: "${{ secrets.NPM_TOKEN }}"',
      'env:\n  TOKEN: "${{ SeCrEtS [ \'NPM_TOKEN\' ] }}"',
      'env:\n  TOKEN: "${{ toJSON(secrets) }}"',
      'env:\n  TOKEN: "${{ secrets[inputs.name] }}"',
      'env:\n  TOKEN: "${{ secrets.NPM_TOKEN"',
      'env:\n  PRIVATE: ${{ format(\'x}}{0}\', secrets.NPM_TOKEN) }}',
      'env:\n  PRIVATE: ${{ format(\'x}}{0}\'\' escaped\', secrets.NPM_TOKEN) }}',
      'env:\n  PRIVATE: ${{ format(\'x}}{0}\', secrets.GITHUB_TOKEN) }} and ${{ secrets.NPM_TOKEN }}',
    ]) expect(() => assertAutomationSafe(workflow(value))).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe([{path:'.github/workflows/ci.yml',content:'on: pull_request\njobs:\n  check:\n    steps:\n      - run: echo "${{ secrets[format(\'TOKEN_{0}\', inputs.name)] }}"'}])).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe([{path:'.github/workflows/ci.yml',content:'on: pull_request\njobs:\n  check:\n    env:\n      "${{ secrets.NPM_TOKEN }}": value'}])).toThrow(GitAdapterError);
    expect(() => assertAutomationSafe(workflow('env:\n  TOKEN: "${{ secrets.GITHUB_TOKEN }}"'))).not.toThrow();
    expect(() => assertAutomationSafe(workflow('env:\n  TOKEN: "${{ SeCrEtS [ \'GITHUB_TOKEN\' ] }}"'))).not.toThrow();
    expect(() => assertAutomationSafe(workflow('env:\n  TOKEN: ${{ format(\'x}}{0}\'\' escaped\', secrets.GITHUB_TOKEN) }}'))).not.toThrow();
    expect(() => assertAutomationSafe(workflow('env:\n  TOKEN: "${{ secrets.GITHUB_TOKEN }}"'),true)).not.toThrow();
  });

  it('publishes one local PR equivalent on duplicate delivery and refuses a moved base', async () => {
    const repo=await localRepo(); const adapter=await createLocalGitAdapter(repo.root);
    const input={actionHash:'b'.repeat(64),baseBranch:'main',baseSha:repo.base,files:[{path:'src/fix.txt',content:'fixed'}]};
    const published=await adapter.publishCommit(input);
    expect(await adapter.publishCommit(input)).toEqual(published);
    expect(command(repo.root,'--git-dir',repo.bare,'show',`${published.commitSha}:src/fix.txt`)).toBe('fixed');
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

  it('never follows tracked symlinks outside the local repository when publishing', async () => {
    const ancestorRepo=await localRepo();
    const ancestorSentinel=join(ancestorRepo.root,'outside-ancestor.txt');
    await writeFile(ancestorSentinel,'unchanged');
    await symlink(ancestorRepo.root,join(ancestorRepo.root,'seed','src'));
    command(join(ancestorRepo.root,'seed'),'add','src');
    command(join(ancestorRepo.root,'seed'),'-c','user.name=Test','-c','user.email=test@localhost','commit','-m','tracked ancestor symlink');
    command(join(ancestorRepo.root,'seed'),'push',ancestorRepo.bare,'main');
    const ancestorBase=command(join(ancestorRepo.root,'seed'),'rev-parse','HEAD');
    const ancestorAdapter=await createLocalGitAdapter(ancestorRepo.root);
    const ancestorPublish=ancestorAdapter.publishCommit({actionHash:'c'.repeat(64),baseBranch:'main',baseSha:ancestorBase,files:[{path:'src/outside-ancestor.txt',content:'overwritten'}]});
    await expect(ancestorPublish).rejects.toThrow();
    expect(await readFile(ancestorSentinel,'utf8')).toBe('unchanged');

    const leafRepo=await localRepo();
    const leafSentinel=join(leafRepo.root,'outside-leaf.txt');
    await writeFile(leafSentinel,'unchanged');
    await mkdir(join(leafRepo.root,'seed','src'));
    await symlink(leafSentinel,join(leafRepo.root,'seed','src','link.txt'));
    command(join(leafRepo.root,'seed'),'add','src/link.txt');
    command(join(leafRepo.root,'seed'),'-c','user.name=Test','-c','user.email=test@localhost','commit','-m','tracked leaf symlink');
    command(join(leafRepo.root,'seed'),'push',leafRepo.bare,'main');
    const leafBase=command(join(leafRepo.root,'seed'),'rev-parse','HEAD');
    const leafAdapter=await createLocalGitAdapter(leafRepo.root);
    const leafPublish=await leafAdapter.publishCommit({actionHash:'d'.repeat(64),baseBranch:'main',baseSha:leafBase,files:[{path:'src/link.txt',content:'safe replacement'}]});
    expect(await readFile(leafSentinel,'utf8')).toBe('unchanged');
    expect(command(leafRepo.root,'--git-dir',leafRepo.bare,'show',`${leafPublish.commitSha}:src/link.txt`)).toBe('safe replacement');
  });

  it('zod rejects a malformed GitHub repository response', async () => {
    const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
    const adapter=createGitHubAppAdapter({appId:'1234',installationId:'5',privateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}).toString(),owner:'owner',repository:'repo',fetchImplementation:async()=>new Response(JSON.stringify({unexpected:true}),{status:200})});
    await expect(adapter.resolveTarget('owner/repo')).rejects.toMatchObject({code:'malformed_response'});
  });
});

const live = process.env.GOTCHU_TEST_GITHUB === '1' ? describe : describe.skip;
const readerCredentialsPath=process.env.GOTCHU_TEST_GITHUB_READER_APP;
live('real provider checks: GitHub App Reader sandbox', () => {
  it('reads the sandbox repository workflows without writing to GitHub', async () => {
    if(!readerCredentialsPath) throw new Error('GOTCHU_TEST_GITHUB_READER_APP is required for the read-only GitHub check');
    const raw: unknown=JSON.parse(await readFile(readerCredentialsPath,'utf8'));
    const credentials=z.object({
      id:z.union([z.string(),z.number()]).transform(String).optional(), appId:z.union([z.string(),z.number()]).transform(String).optional(),
      app_id:z.union([z.string(),z.number()]).transform(String).optional(),
      installationId:z.union([z.string(),z.number()]).transform(String).optional(), installation_id:z.union([z.string(),z.number()]).transform(String).optional(),
      privateKeyPem:z.string().optional(), privateKey:z.string().optional(), private_key:z.string().optional(),
    }).passthrough().parse(raw);
    const appId=credentials.id??credentials.appId??credentials.app_id;
    const privateKeyPem=credentials.privateKeyPem??credentials.privateKey??credentials.private_key;
    const installationId=credentials.installationId??credentials.installation_id??process.env.GOTCHU_TEST_GITHUB_READER_INSTALLATION_ID;
    if(!appId||!privateKeyPem||!installationId) throw new Error('Reader App credentials are missing required fields');
    const adapter=createGitHubAppAdapter({appId,installationId,privateKeyPem,owner:'0bkevin',repository:'gotchu-pr-sandbox'});
    const target=await adapter.resolveTarget('0bkevin/gotchu-pr-sandbox');
    const base=await adapter.readHead(target.baseBranch);
    await expect(adapter.inspectAutomation(base)).resolves.toEqual([]);
  },30_000);
});
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
