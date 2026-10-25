import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertAutomationSafe, assertWorkflowPatchSafe, computeGitTreeSha, computeGitTreeShaAfterPatch, createGitHubAppAdapter, createLocalGitAdapter, deterministicBranch, GitAdapterError, verifyPublishedTree, type PullRequest } from '../src/index.js';

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
  it('reads exact local file contents without stripping whitespace or BOMs', async () => {
    const repo = await localRepo();
    const content = '\uFEFF  export const value = true;\r\n\n';
    await writeFile(join(repo.seed, 'src', 'exact.ts'), content);
    command(repo.seed, 'add', '--all');
    command(repo.seed, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'exact bytes');
    command(repo.seed, 'push', repo.bare, 'HEAD:refs/heads/main');
    const head = command(repo.seed, 'rev-parse', 'HEAD');
    expect(await (await createLocalGitAdapter(repo.root)).readFile('src/exact.ts', head)).toBe(content);
  });

  it('encodes GitHub content paths without changing the pinned ref and accepts empty files', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ref = 'a'.repeat(40);
    const path = 'src/part?ref=main#file.ts';
    const adapter = createGitHubAppAdapter({ appId: '1234', installationId: '5', owner: 'owner', repository: 'repo',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      fetchImplementation: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 'fixture-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
        expect(init?.method).toBe('GET');
        expect(url.searchParams.get('ref')).toBe(ref);
        expect(decodeURIComponent(url.pathname)).toBe(`/repos/owner/repo/contents/${path}`);
        expect(url.hash).toBe('');
        return new Response(JSON.stringify({ path, type: 'file', encoding: 'base64', content: '' }));
      },
    });
    expect(await adapter.readFile(path, ref)).toBe('');
  });

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
    await rm(join(ancestorRepo.seed,'src'),{recursive:true});
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
    await rm(join(leafRepo.seed,'src'),{recursive:true});
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

  it('treats GitHub 422 as an already-deleted branch only when the ref is absent', async () => {
    const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
    const privateKeyPem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
    const tokenResponse=()=>new Response(JSON.stringify({token:'fixture-token',expires_at:new Date(Date.now()+3_600_000).toISOString()}),{status:201});
    const absent=createGitHubAppAdapter({appId:'1234',installationId:'5',privateKeyPem,owner:'owner',repository:'repo',fetchImplementation:async(input,init)=>{
      if(String(input).includes('/access_tokens'))return tokenResponse();
      if(init?.method==='DELETE')return new Response(JSON.stringify({message:'reference missing'}),{status:422});
      if(String(input).includes('/git/ref/heads/gotchu%2Fmissing'))return new Response(JSON.stringify({message:'not found'}),{status:404});
      throw new Error('unexpected_github_request');
    }});
    await expect(absent.deleteBranch('gotchu/missing')).resolves.toBeUndefined();

    const present=createGitHubAppAdapter({appId:'1234',installationId:'5',privateKeyPem,owner:'owner',repository:'repo',fetchImplementation:async(input,init)=>{
      if(String(input).includes('/access_tokens'))return tokenResponse();
      if(init?.method==='DELETE')return new Response(JSON.stringify({message:'reference cannot be deleted'}),{status:422});
      if(String(input).includes('/git/ref/heads/gotchu%2Fpresent'))return new Response(JSON.stringify({object:{sha:'a'.repeat(40)}}),{status:200});
      throw new Error('unexpected_github_request');
    }});
    await expect(present.deleteBranch('gotchu/present')).rejects.toMatchObject({code:'unknown_outcome'});
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
