import { createPrivateKey } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { SignJWT, importPKCS8 } from 'jose';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const pathSchema = z.string().min(1).max(4096).refine(path => !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && !path.includes('\\') && !path.includes('\0') && !path.split('/').some(part => part === '..' || part === '.' || part.toLowerCase() === '.git'));
const patchFileSchema = z.object({ path:pathSchema,content:z.string().max(1_048_576),mode:z.enum(['100644','100755']).optional() }).strict();
const workflowSchema = z.object({ path: pathSchema, content: z.string().max(2_000_000) }).strict();
const evidenceSummarySchema = z.object({ rescan: z.literal('passed'), suite: z.literal('passed'), regression: z.literal('passed'), runnerIsolation: z.literal('verified') }).strict();
const prSchema = z.object({ number: z.number().int().positive(), html_url: z.string().url(), state: z.enum(['open','closed']), head: z.object({ sha, ref: z.string().min(1) }), base: z.object({ sha, ref: z.string().min(1) }) }).passthrough();

export class GitAdapterError extends Error {
  constructor(readonly code: 'conflict'|'repository_automation_unsafe'|'provider_access_revoked'|'malformed_response'|'unknown_outcome'|'not_found') { super(code); this.name = 'GitAdapterError'; }
}
export interface PatchFile { readonly path: string; readonly content: string; readonly mode?: '100644'|'100755' }
export interface PullRequest { readonly number: number; readonly url: string; readonly state: 'open'|'closed'; readonly headSha: string; readonly headBranch: string; readonly baseSha: string; readonly baseBranch: string }
export interface PullRequestAdapter {
  resolveTarget(repositoryKey: string): Promise<{ repositoryKey: string; baseBranch: string }>;
  readHead(branch: string): Promise<string>;
  publishCommit(input: { actionHash: string; baseBranch: string; baseSha: string; files: readonly PatchFile[] }): Promise<{ branch: string; commitSha: string }>;
  openOrFindPullRequest(input: { actionHash: string; branch: string; commitSha: string; baseBranch: string; baseSha: string; evidenceSummary: z.infer<typeof evidenceSummarySchema> }): Promise<PullRequest>;
  getPullRequest(number: number): Promise<PullRequest>;
  closePullRequest(number: number): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  listRequiredChecks(commitSha: string): Promise<readonly { name: string; state: string }[]>;
  verifyAutomation(baseSha: string, policyAllowsUnsafe?: boolean, proposedBranch?: string): Promise<void>;
}
export const deterministicBranch = (actionHash: string) => `gotchu/${z.string().regex(/^[a-f0-9]{64}$/).parse(actionHash).slice(0,16)}`;
export function assertWorkflowPatchSafe(files: readonly PatchFile[]): void {
  const checked=z.array(patchFileSchema).max(1000).parse(files);
  if (checked.some(file => file.path === '.github/workflows' || file.path.startsWith('.github/workflows/'))) throw new GitAdapterError('repository_automation_unsafe');
}
export function assertAutomationSafe(workflows: readonly { path: string; content: string }[], policyAllowsUnsafe = false, proposedBranch?: string): void {
  const parsed = z.array(workflowSchema).parse(workflows);
  if (proposedBranch !== undefined && !/^gotchu\/[a-f0-9]{16}$/.test(proposedBranch)) throw new GitAdapterError('repository_automation_unsafe');
  for (const workflow of parsed) {
    if (!workflow.path.startsWith('.github/workflows/')) continue;
    let document: unknown;
    try { document = parseYaml(workflow.content, { maxAliasCount: 50 }); }
    catch { throw new GitAdapterError('repository_automation_unsafe'); }
    const root = z.record(z.string(), z.unknown()).safeParse(document);
    if (!root.success) throw new GitAdapterError('repository_automation_unsafe');
    if (policyAllowsUnsafe) continue;
    const triggers = root.data.on ?? root.data.true;
    const events = triggerMap(triggers);
    if (events.has('pull_request_target')) throw new GitAdapterError('repository_automation_unsafe');
    const push = events.get('push');
    if (events.has('push')) {
      const pushOptions = typeof push === 'object' && push !== null && !Array.isArray(push)
        ? push as Record<string, unknown> : {};
      const hasBranches = Object.hasOwn(pushOptions, 'branches');
      const hasBranchesIgnore = Object.hasOwn(pushOptions, 'branches-ignore');
      if (hasBranches && hasBranchesIgnore) throw new GitAdapterError('repository_automation_unsafe');
      const branchPatterns = hasBranches ? parseBranchPatterns(pushOptions.branches, true) : undefined;
      const ignoredPatterns = hasBranchesIgnore ? parseBranchPatterns(pushOptions['branches-ignore'], false) : undefined;
      if (!branchPatterns && !ignoredPatterns) throw new GitAdapterError('repository_automation_unsafe');
      const triggersOwnedBranch = proposedBranch
        ? branchPatterns ? matchesBranchPatterns(branchPatterns, proposedBranch) : !ignoredPatterns?.some(pattern => pattern.matches(proposedBranch))
        : branchPatterns ? branchPatterns.some(pattern => !pattern.negative && couldMatchOwnedBranch(pattern.tokens))
          : !ignoredPatterns?.some(pattern => pattern.source === 'gotchu/*' || pattern.source === 'gotchu/**');
      if (triggersOwnedBranch)
        throw new GitAdapterError('repository_automation_unsafe');
    }
    if (events.has('pull_request') && containsForbiddenSecret(root.data))
      throw new GitAdapterError('repository_automation_unsafe');
  }
}

function triggerMap(value: unknown): Map<string, unknown> {
  if (typeof value === 'string') return new Map([[value, {}]]);
  if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) return new Map(value.map(event => [event, {}]));
  if (typeof value === 'object' && value !== null) return new Map(Object.entries(value));
  throw new GitAdapterError('repository_automation_unsafe');
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
  return [];
}

type BranchGlobToken = { readonly kind: 'literal'; readonly value: string } | { readonly kind: 'star'|'doubleStar' };
interface BranchPattern { readonly source: string; readonly negative: boolean; readonly tokens: readonly BranchGlobToken[]; readonly matches: (branch: string) => boolean }

function parseBranchPatterns(value: unknown, allowNegation: boolean): BranchPattern[] {
  const sources = stringList(value);
  if (sources.length === 0 || sources.length > 100) throw new GitAdapterError('repository_automation_unsafe');
  let sawPositive = false;
  return sources.map(source => {
    const negative = source.startsWith('!');
    const glob = negative ? source.slice(1) : source;
    if (!glob || glob.length > 256 || (negative && !allowNegation) || (negative && !sawPositive))
      throw new GitAdapterError('repository_automation_unsafe');
    if (!negative) sawPositive = true;
    const tokens: BranchGlobToken[] = [];
    for (let index = 0; index < glob.length; index++) {
      const character = glob[index];
      if (character === '*') {
        const double = glob[index + 1] === '*';
        if (double) index++;
        if (glob[index + 1] === '*') throw new GitAdapterError('repository_automation_unsafe');
        tokens.push({ kind: double ? 'doubleStar' : 'star' });
      } else if (character && /^[A-Za-z0-9._/-]$/.test(character)) tokens.push({ kind: 'literal', value: character });
      else throw new GitAdapterError('repository_automation_unsafe');
    }
    const regex = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*/g, token => token === '**' ? '.*' : '[^/]*');
    return { source: glob, negative, tokens, matches: branch => new RegExp(`^${regex}$`).test(branch) };
  });
}

function matchesBranchPatterns(patterns: readonly BranchPattern[], branch: string): boolean {
  let included = false;
  for (const pattern of patterns) if (pattern.matches(branch)) included = !pattern.negative;
  return included;
}

function couldMatchOwnedBranch(tokens: readonly BranchGlobToken[]): boolean {
  const close = (states: Set<number>) => {
    const result = new Set(states);
    const pending = [...states];
    while (pending.length) {
      const state = pending.pop();
      if (state !== undefined && (tokens[state]?.kind === 'star' || tokens[state]?.kind === 'doubleStar') && !result.has(state + 1)) {
        result.add(state + 1);
        pending.push(state + 1);
      }
    }
    return result;
  };
  let states = close(new Set([0]));
  for (const character of 'gotchu/') {
    const next = new Set<number>();
    for (const state of states) {
      const token = tokens[state];
      if (token?.kind === 'literal' && token.value === character) next.add(state + 1);
      else if (token?.kind === 'star' && character !== '/') next.add(state);
      else if (token?.kind === 'doubleStar') next.add(state);
    }
    states = close(next);
  }
  return [...states].some(state => state < tokens.length);
}

function hasForbiddenSecretReference(expression: string): boolean {
  const references = /\bsecrets\b/gi;
  for (const reference of expression.matchAll(references)) {
    const before = expression.slice(0, reference.index).trimEnd();
    if (before.endsWith('.')) continue;
    let index = (reference.index ?? 0) + reference[0].length;
    while (/\s/.test(expression[index] ?? '')) index++;
    let name: string | undefined;
    if (expression[index] === '.') {
      index++;
      while (/\s/.test(expression[index] ?? '')) index++;
      const property = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression.slice(index));
      if (!property) return true;
      name = property[0];
      index += name.length;
    } else if (expression[index] === '[') {
      const property = /^\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\]/.exec(expression.slice(index));
      if (!property) return true;
      if (!property[1]) return true;
      name = property[1];
      index += property[0].length;
    } else return true;
    if (name.toUpperCase() !== 'GITHUB_TOKEN') return true;
    while (/\s/.test(expression[index] ?? '')) index++;
    if (expression[index] === '.' || expression[index] === '[') return true;
  }
  return false;
}

function expressionEnd(value: string, start: number): number | undefined {
  // A terminator inside a single-quoted literal is data; doubled quotes escape a quote.
  let inSingleQuotedString = false;
  for (let index = start; index < value.length - 1; index++) {
    const character = value[index];
    if (inSingleQuotedString) {
      if (character === "'" && value[index + 1] === "'") {
        index++;
        continue;
      }
      if (character === "'") inSingleQuotedString = false;
      continue;
    }
    if (character === '"') return undefined;
    if (character === "'") {
      inSingleQuotedString = true;
      continue;
    }
    if (character === '}' && value[index + 1] === '}') return index;
  }
  return undefined;
}

function containsForbiddenSecret(value: unknown, active = new WeakSet<object>()): boolean {
  if (typeof value === 'string') {
    let cursor = 0;
    while (true) {
      const start = value.indexOf('${{',cursor);
      if (start === -1) return false;
      const end = expressionEnd(value,start + 3);
      if (end === undefined) return /\bsecrets\b/i.test(value.slice(start + 3));
      if (hasForbiddenSecretReference(value.slice(start + 3,end))) return true;
      cursor = end + 2;
    }
  }
  if (typeof value === 'object' && value !== null) {
    if (active.has(value)) return true;
    active.add(value);
    const contains = Array.isArray(value)
      ? value.some(item => containsForbiddenSecret(item,active))
      : Object.entries(value).some(([key,item]) => containsForbiddenSecret(key,active) || containsForbiddenSecret(item,active));
    active.delete(value);
    return contains;
  }
  return false;
}

async function git(cwd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn('git', [...args], { cwd, env: options.env, stdio: [options.stdin === undefined ? 'ignore' : 'pipe','pipe','pipe'], shell: false });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout?.on('data', chunk => out.push(Buffer.from(chunk)));
    child.stderr?.on('data', chunk => err.push(Buffer.from(chunk)));
    child.stdin?.on('error', reject);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolvePromise(Buffer.concat(out).toString('utf8').trim()) : reject(new Error(`git_failed:${Buffer.concat(err).toString('utf8').slice(0,300)}`)));
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

/** Portable bare-repository implementation. The PR record is a local equivalent for development. */
export async function createLocalGitAdapter(repositoryPath: string): Promise<PullRequestAdapter> {
  const root = resolve(repositoryPath); const bare = join(root,'repository.git'); const workRoot = join(root,'worktrees'); const records = join(root,'pull-requests.json');
  await mkdir(root,{recursive:true}); await mkdir(workRoot,{recursive:true});
  try { await git(root,['--git-dir',bare,'rev-parse','--is-bare-repository']); } catch { await git(root,['init','--bare',bare]); }
  const localPrSchema = z.object({ number:z.number().int().positive(),url:z.string().url(),state:z.enum(['open','closed']),headSha:sha,headBranch:z.string(),baseSha:sha,baseBranch:z.string() }).strict();
  const load = async () => { try { return z.array(localPrSchema).parse(JSON.parse(await readFile(records,'utf8'))); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } };
  const save = async (items: unknown[]) => writeFile(records,JSON.stringify(items),'utf8');
  return {
    async resolveTarget(repositoryKey) { const branch = await git(root,['--git-dir',bare,'symbolic-ref','HEAD']).catch(()=> 'refs/heads/main'); return { repositoryKey, baseBranch: branch.replace('refs/heads/','') }; },
    async readHead(branch) { return sha.parse(await git(root,['--git-dir',bare,'rev-parse',`refs/heads/${branch}`])); },
    async publishCommit(input) {
      assertWorkflowPatchSafe(input.files);
      const branch = deterministicBranch(input.actionHash); const base = sha.parse(await git(root,['--git-dir',bare,'rev-parse',`refs/heads/${input.baseBranch}`]));
      if (base !== input.baseSha) throw new GitAdapterError('conflict');
      const dir = await mkdtemp(join(workRoot,'gotchu-'));
      try {
        const indexEnv = { ...process.env, GIT_INDEX_FILE: join(dir,'index') };
        await git(root,['--git-dir',bare,'read-tree',base],{env:indexEnv});
        for (const file of input.files) {
          const path = pathSchema.parse(file.path);
          const blob = sha.parse(await git(root,['--git-dir',bare,'hash-object','-w','--stdin'],{stdin:file.content}));
          await git(root,['--git-dir',bare,'update-index','--add','--cacheinfo',file.mode ?? '100644',blob,path],{env:indexEnv});
        }
        const treeSha = sha.parse(await git(root,['--git-dir',bare,'write-tree'],{env:indexEnv}));
        const existing = await git(root,['--git-dir',bare,'rev-parse',`refs/heads/${branch}`]).catch(()=>null);
        if (existing) {
          const existingTree = await git(root,['--git-dir',bare,'rev-parse',`${existing}^{tree}`]);
          const existingParent = await git(root,['--git-dir',bare,'rev-parse',`${existing}^`]);
          if (existingTree !== treeSha || existingParent !== base) throw new GitAdapterError('conflict');
          return { branch,commitSha:sha.parse(existing) };
        }
        const commitSha = sha.parse(await git(root,['--git-dir',bare,'-c','user.name=Gotchu','-c','user.email=gotchu@localhost','commit-tree',treeSha,'-p',base,'-m',`Gotchu approved action ${input.actionHash}`]));
        try { await git(root,['--git-dir',bare,'update-ref',`refs/heads/${branch}`,commitSha,'']); }
        catch {
          const raced = await git(root,['--git-dir',bare,'rev-parse',`refs/heads/${branch}`]).catch(()=>undefined);
          if (!raced || await git(root,['--git-dir',bare,'rev-parse',`${raced}^{tree}`]) !== treeSha
            || await git(root,['--git-dir',bare,'rev-parse',`${raced}^`]) !== base) throw new GitAdapterError('conflict');
          return { branch,commitSha:sha.parse(raced) };
        }
        return { branch,commitSha };
      } catch (error) { if (error instanceof GitAdapterError) throw error; throw error; }
      finally { await rm(dir,{recursive:true,force:true}); }
    },
    async openOrFindPullRequest(input) {
      evidenceSummarySchema.parse(input.evidenceSummary);
      const rows = await load(); const branchHead = await git(root,['--git-dir',bare,'rev-parse',`refs/heads/${input.branch}`]);
      if (branchHead !== input.commitSha) throw new GitAdapterError('conflict');
      const old = rows.find(row => row.headBranch === input.branch);
      if (old) { if (old.headSha !== input.commitSha || old.baseBranch !== input.baseBranch || old.baseSha !== input.baseSha) throw new GitAdapterError('conflict'); return old; }
      const pr = { number: rows.length + 1, url:`https://local.invalid/${input.branch}`,state:'open' as const,headSha:branchHead,headBranch:input.branch,baseSha:input.baseSha,baseBranch:input.baseBranch };
      await save([...rows,pr]); return pr;
    },
    async getPullRequest(number) { const found=(await load()).find(row=>row.number===number); if(!found) throw new GitAdapterError('not_found'); return found; },
    async closePullRequest(number) { await save((await load()).map(row=>row.number===number?{...row,state:'closed'}:row)); },
    async deleteBranch(branch) { await git(root,['--git-dir',bare,'update-ref','-d',`refs/heads/${branch}`]).catch(error => { if(!String(error).includes('unknown revision')) throw error; }); },
    async listRequiredChecks() { return []; },
    async verifyAutomation() { return; },
  };
}

export interface GitHubAppOptions {
  readonly appId: string; readonly installationId: string; readonly privateKeyPem: string; readonly owner: string; readonly repository: string;
  readonly fetchImplementation?: typeof fetch; readonly requestTimeoutMs?: number; readonly now?: () => number; readonly policyAllowsUnsafeAutomation?: boolean;
}

const json = async (response: Response): Promise<unknown> => { let payload: unknown; try { payload = await response.json(); } catch { throw new GitAdapterError('malformed_response'); } return payload; };
export function createGitHubAppAdapter(options: GitHubAppOptions): PullRequestAdapter {
  const fetcher=options.fetchImplementation ?? fetch; const api=`https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repository)}`;
  let cached: { token:string; expires:number } | undefined;
  async function token() {
    if(cached && cached.expires>(options.now?.() ?? Date.now())+60_000) return cached.token;
    const normalizedKey=createPrivateKey(options.privateKeyPem).export({type:'pkcs8',format:'pem'}).toString();
    const key=await importPKCS8(normalizedKey,'RS256'); const now=Math.floor((options.now?.() ?? Date.now())/1000);
    const jwt=await new SignJWT({iat:now-30,exp:now+540,iss:options.appId}).setProtectedHeader({alg:'RS256'}).sign(key);
    const response=await request('POST',`https://api.github.com/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`,undefined,jwt);
    if([401,403,404].includes(response.status)) throw new GitAdapterError('provider_access_revoked');
    let payload: { token: string; expires_at: string };
    try { payload=z.object({token:z.string().min(1),expires_at:z.string().datetime()}).parse(await json(response)); }
    catch { throw new GitAdapterError('malformed_response'); }
    cached={token:payload.token,expires:Date.parse(payload.expires_at)}; return cached.token;
  }
  async function request(method:string,path:string,body?:unknown,bearer?:string,retryGet=true):Promise<Response> {
    const auth=bearer ?? await token(); let last:unknown;
    for(let attempt=0;attempt<(method==='GET'&&retryGet?2:1);attempt++) try {
      const response=await fetcher(path.startsWith('https://')?path:api+path,{method,headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','content-type':'application/json',authorization:`Bearer ${auth}`,'user-agent':'Gotchu-Git-Adapter/0.1.0'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(options.requestTimeoutMs??10_000)});
      if([401,403,404].includes(response.status) && path.includes('/access_tokens')) throw new GitAdapterError('provider_access_revoked');
      if(method==='GET'&&response.status>=500&&attempt===0) continue;
      return response;
    } catch(error) { last=error; if(method!=='GET'||attempt>0) throw error; }
    throw last ?? new GitAdapterError('unknown_outcome');
  }
  async function checked<T>(method:string,path:string,body:unknown,schema:z.ZodType<T>):Promise<T>{
    const response=await request(method,path,body); if(!response.ok) { if([401,403].includes(response.status)) throw new GitAdapterError('provider_access_revoked'); if(response.status===404) throw new GitAdapterError('not_found'); throw new GitAdapterError('unknown_outcome'); }
    try{return schema.parse(await json(response));}catch{throw new GitAdapterError('malformed_response');}
  }
  const toPr=(pr:z.infer<typeof prSchema>):PullRequest=>({number:pr.number,url:pr.html_url,state:pr.state,headSha:pr.head.sha,headBranch:pr.head.ref,baseSha:pr.base.sha,baseBranch:pr.base.ref});
  return {
    async resolveTarget(repositoryKey) { if(repositoryKey!==`${options.owner}/${options.repository}`) throw new GitAdapterError('not_found'); const repo=await checked('GET',`?`,undefined,z.object({default_branch:z.string().min(1)}).passthrough()); return {repositoryKey,baseBranch:repo.default_branch}; },
    async readHead(branch) { const ref=await checked('GET',`/git/ref/heads/${encodeURIComponent(branch)}`,undefined,z.object({object:z.object({sha}).passthrough()}).passthrough()); return ref.object.sha; },
    async verifyAutomation(baseSha,policyAllowsUnsafe=options.policyAllowsUnsafeAutomation??false,proposedBranch) {
      const tree=await checked('GET',`/git/trees/${baseSha}?recursive=1`,undefined,z.object({tree:z.array(z.object({path:z.string(),type:z.string(),sha}).passthrough()).max(100_000),truncated:z.boolean()}).passthrough());
      if(tree.truncated) throw new GitAdapterError('repository_automation_unsafe');
      const paths=tree.tree.filter(entry=>entry.type==='blob'&&entry.path.startsWith('.github/workflows/'));
      const files=await Promise.all(paths.map(async entry=>{const blob=await checked('GET',`/git/blobs/${entry.sha}`,undefined,z.object({content:z.string(),encoding:z.literal('base64')}).passthrough());return {path:entry.path,content:Buffer.from(blob.content,'base64').toString('utf8')};}));
      assertAutomationSafe(files,policyAllowsUnsafe,proposedBranch);
    },
    async publishCommit(input) {
      assertWorkflowPatchSafe(input.files);
      const branch=deterministicBranch(input.actionHash); const base=await this.readHead(input.baseBranch); if(base!==input.baseSha) throw new GitAdapterError('conflict');
      await this.verifyAutomation(input.baseSha,undefined,branch);
      const blobs = await Promise.all(input.files.map(async file => {
        const blob = await checked('POST', '/git/blobs', { content: file.content, encoding: 'utf-8' }, z.object({ sha }).passthrough());
        return { path: pathSchema.parse(file.path), mode: file.mode ?? '100644', type: 'blob', sha: blob.sha };
      }));
      const tree=await checked('POST','/git/trees',{base_tree:(await checked('GET',`/git/commits/${base}`,undefined,z.object({tree:z.object({sha}).passthrough()}).passthrough())).tree.sha,tree:blobs},z.object({sha}).passthrough());
      const expectedParent = base;
      const matchesCandidate = async (commitSha: string) => {
        const remote=await checked('GET',`/git/commits/${commitSha}`,undefined,z.object({tree:z.object({sha}).passthrough(),parents:z.array(z.object({sha}).passthrough())}).passthrough());
        return remote.tree.sha===tree.sha && remote.parents.length===1 && remote.parents[0]?.sha===expectedParent;
      };
      const refPath=`/git/ref/heads/${encodeURIComponent(branch)}`;
      const existing=await request('GET',api+refPath);
      if(existing.ok) {
        let existingSha: string;
        try { existingSha=z.object({object:z.object({sha}).passthrough()}).passthrough().parse(await json(existing)).object.sha; }
        catch { throw new GitAdapterError('malformed_response'); }
        if(!await matchesCandidate(existingSha)) throw new GitAdapterError('conflict');
        return {branch,commitSha:existingSha};
      }
      if(existing.status!==404) throw new GitAdapterError(existing.status===401||existing.status===403?'provider_access_revoked':'unknown_outcome');
      const commit=await checked('POST','/git/commits',{message:`Gotchu approved action ${input.actionHash}\n\nEvidence: ${input.actionHash}`,tree:tree.sha,parents:[base]},z.object({sha}).passthrough());
      let created: Response | undefined;
      try { created=await request('POST','/git/refs',{ref:`refs/heads/${branch}`,sha:commit.sha}); } catch { /* inspect remote state before reporting an unknown write */ }
      if(!created?.ok || created.status===422){
        const remoteHead=await this.readHead(branch).catch(()=>undefined);
        if(!remoteHead || !await matchesCandidate(remoteHead)) throw new GitAdapterError(created?.status===422?'conflict':'unknown_outcome');
        return {branch,commitSha:remoteHead};
      } else {
        try { z.object({ref:z.string(),object:z.object({sha}).passthrough()}).passthrough().parse(await json(created)); }
        catch { throw new GitAdapterError('malformed_response'); }
      }
      return {branch,commitSha:commit.sha};
    },
    async openOrFindPullRequest(input) {
      evidenceSummarySchema.parse(input.evidenceSummary);
      if(await this.readHead(input.branch)!==input.commitSha) throw new GitAdapterError('conflict');
      const find = async () => {
        const existing = await checked('GET',`/pulls?head=${encodeURIComponent(options.owner+':'+input.branch)}&state=all`,undefined,z.array(prSchema));
        return existing.find(pr=>pr.head.ref===input.branch);
      };
      const found = await find();
      if(found){if(found.head.sha!==input.commitSha||found.base.ref!==input.baseBranch||found.base.sha!==input.baseSha)throw new GitAdapterError('conflict');return toPr(found);}
      let created: z.infer<typeof prSchema>;
      try {
        created = await checked('POST','/pulls',{title:`Approved Gotchu action ${input.actionHash.slice(0,16)}`,head:input.branch,base:input.baseBranch,body:`Approved action: ${input.actionHash}\n\nEvidence summary: objective rescan passed; validation suite passed; regression checks passed; runner isolation verified.`},prSchema);
      } catch (error) {
        // A timeout may have happened after GitHub created the PR. Reconcile by head before returning.
        const reconciled = await find().catch(() => undefined);
        if (!reconciled) throw error;
        created = reconciled;
      }
      if(created.head.sha!==input.commitSha||created.base.ref!==input.baseBranch||created.base.sha!==input.baseSha)throw new GitAdapterError('conflict');
      return toPr(created);
    },
    async getPullRequest(number){return toPr(await checked('GET',`/pulls/${number}`,undefined,prSchema));},
    async closePullRequest(number){await checked('PATCH',`/pulls/${number}`,{state:'closed'},prSchema);},
    async deleteBranch(branch){const response=await request('DELETE',`/git/refs/heads/${encodeURIComponent(branch)}`);if(response.status!==204&&response.status!==404)throw new GitAdapterError('unknown_outcome');},
    async listRequiredChecks(commitSha){const data=await checked('GET',`/commits/${sha.parse(commitSha)}/check-runs`,undefined,z.object({check_runs:z.array(z.object({name:z.string(),status:z.string(),conclusion:z.string().nullable()}).passthrough()).max(1000)}).passthrough());return data.check_runs.map(item=>({name:item.name,state:item.status==='completed'?(item.conclusion??'unknown'):'pending'}));},
  };
}
