import { createSign } from 'node:crypto';
import type { Database } from '@gotchu/database';
import { loadSingleAppInstallation, loadSingleAppRepository } from '@gotchu/backend';
import { createMonitoringRepositoryCatalog, createGitHubRepositoryReader } from '@gotchu/monitoring';
import { inspectWorkflowPolicy, type GitTree, type WorkflowPolicyViolation } from '@gotchu/git-adapters';
import { customerSourceSnapshotSchema, githubRepositorySchema } from '@gotchu/contracts';
import { z } from 'zod';
import type { GitHubSingleAppCredentials } from './github-credentials.js';

const apiBase = 'https://api.github.com';
const gitSha = /^[a-f0-9]{40}$/i;
const idSchema = z.number().int().positive().refine(Number.isSafeInteger);
const gitRefSchema = z.string().min(1).max(200).refine(value => {
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')
    || value.includes('..') || value.includes('@{') || /[~^:?*[\\\s\x00-\x1f\x7f]/.test(value)) return false;
  return value.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
});
const accountSchema = z.object({ id: idSchema, login: z.string().min(1).max(100), type: z.enum(['User', 'Organization']) });
const installationSchema = z.object({ id: idSchema, account: accountSchema }).passthrough();
const installationStatusSchema = z.object({ id: idSchema, suspended_at: z.iso.datetime().nullable() }).passthrough();
const installationListSchema = z.object({ installations: z.array(installationSchema).max(100) }).passthrough();
const userSchema = z.object({ id: idSchema }).passthrough();
const membershipSchema = z.object({
  state: z.enum(['active', 'pending']), role: z.enum(['admin', 'member']),
  organization: userSchema, user: userSchema,
}).passthrough();
const oauthTokenSchema = z.object({ access_token: z.string().min(1).max(4096), token_type: z.literal('bearer') }).passthrough();
const installationTokenSchema = z.object({
  token: z.string().min(1).max(4096), expires_at: z.iso.datetime(),
  permissions: z.record(z.string(), z.string()), repository_selection: z.enum(['all', 'selected']),
  repositories: z.array(z.object({ id: idSchema }).passthrough()).max(1000).optional(),
}).passthrough();
const repositoryApiSchema = z.object({
  id: idSchema, full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
  default_branch: z.string().min(1).max(200), private: z.boolean(), archived: z.boolean(),
}).passthrough();
const repositoryPageSchema = z.object({ repositories: z.array(repositoryApiSchema).max(100), total_count: z.number().int().nonnegative() }).passthrough();
const repositoryBindingSchema = z.object({
  repositoryLinkId: z.uuid(), repositoryId: idSchema, repositoryKey: z.string().regex(/^gh-[1-9][0-9]*$/),
  defaultBranch: z.string().min(1).max(200), installationId: z.string().regex(/^\d{1,20}$/), appId: z.string().regex(/^\d+$/),
}).strict();
const installationBindingSchema = z.object({ installationId: z.string().regex(/^\d{1,20}$/), appId: z.string().regex(/^\d+$/) }).strict();
const refSchema = z.object({ object: z.object({ sha: z.string().regex(gitSha) }).passthrough() }).passthrough();
const commitSchema = z.object({ sha: z.string().regex(gitSha), tree: z.object({ sha: z.string().regex(gitSha) }).passthrough() }).passthrough();
const treeSchema = z.object({
  sha: z.string().regex(gitSha),
  tree: z.array(z.object({
    path: z.string().min(1).max(4096), mode: z.enum(['100644', '100755', '120000', '160000', '040000']),
    type: z.enum(['blob', 'tree', 'commit']), sha: z.string().regex(gitSha),
  }).passthrough()).max(100_000),
  truncated: z.boolean(),
}).passthrough();
const blobSchema = z.object({
  encoding: z.literal('base64'),
  content: z.string().max(2_700_000).transform(value => value.replace(/[\r\n\t ]/g, ''))
    .pipe(z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)),
}).passthrough();
const MAX_GITHUB_JSON_BYTES = 8 * 1024 * 1024;
const MAX_WORKFLOW_FILES = 100;
const MAX_WORKFLOW_BYTES = 4 * 1024 * 1024;

export type SingleAppRepositoryBinding = {
  repositoryLinkId: string;
  repositoryId: number;
  repositoryKey: string;
  defaultBranch: string;
  installationId: string;
  appId: string;
};
type SingleAppReadScope = { organizationId: string; applicationId: string; repositoryLinkId?: string; repositoryKey?: string };

export class SingleAppGitHubError extends Error {
  constructor(readonly status: number, code: string) {
    super(code);
    this.name = 'SingleAppGitHubError';
  }
}

function assertResponseOrigin(response: Response, expectedOrigin: string): void {
  if (!response.url) return;
  let origin: string;
  try { origin = new URL(response.url).origin; } catch { throw new SingleAppGitHubError(502, 'github_response_invalid'); }
  if (origin !== expectedOrigin) throw new SingleAppGitHubError(502, 'github_response_origin_invalid');
}

function appJwt(app: GitHubSingleAppCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 30, exp: now + 8 * 60, iss: app.id })).toString('base64url');
  const content = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(content);
  return `${content}.${signer.sign(app.privateKeyPem).toString('base64url')}`;
}

async function parseJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const announcedLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(announcedLength) && announcedLength > maxBytes) throw new SingleAppGitHubError(413, 'github_response_too_large');
  if (!response.body) throw new SingleAppGitHubError(502, 'github_response_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new SingleAppGitHubError(413, 'github_response_too_large');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))) as unknown;
  } catch (error) {
    if (error instanceof SingleAppGitHubError) throw error;
    throw new SingleAppGitHubError(502, 'github_response_invalid');
  }
}

function parseApiResponse<T>(input: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new SingleAppGitHubError(502, 'github_response_invalid');
  return parsed.data;
}

function createSingleAppResolver(options: {
  database: Database;
  app: GitHubSingleAppCredentials;
  fetchImplementation?: typeof fetch;
}) {
  const fetcher = options.fetchImplementation ?? fetch;
  const request = (url: URL, init: RequestInit) => fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });

  async function githubJson<T>(path: string, token: string, schema: z.ZodType<T>, maxBytes = MAX_GITHUB_JSON_BYTES): Promise<T> {
    const response = await request(new URL(path, apiBase), { headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10', 'user-agent': 'Gotchu/0.1.0',
    } });
    assertResponseOrigin(response, apiBase);
    if (!response.ok) throw new SingleAppGitHubError(response.status, `github_http_${response.status}`);
    return parseApiResponse(await parseJsonResponse(response, maxBytes), schema);
  }

  async function appJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return githubJson(path, appJwt(options.app), schema, 256 * 1024);
  }

  async function installationToken(installationId: string, repositoryId?: number): Promise<string> {
    const body = repositoryId === undefined
      ? { permissions: { metadata: 'read' } }
      : { repository_ids: [repositoryId], permissions: { contents: 'read', metadata: 'read' } };
    const response = await request(new URL(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, apiBase), {
      method: 'POST', headers: {
        authorization: `Bearer ${appJwt(options.app)}`, accept: 'application/vnd.github+json',
        'content-type': 'application/json', 'x-github-api-version': '2026-03-10', 'user-agent': 'Gotchu/0.1.0',
      }, body: JSON.stringify(body),
    });
    assertResponseOrigin(response, apiBase);
    if (!response.ok) throw new SingleAppGitHubError(response.status, `github_http_${response.status}`);
    const payload = parseApiResponse(await parseJsonResponse(response, 64 * 1024), installationTokenSchema);
    const expiresAt = Date.parse(payload.expires_at);
    if (expiresAt <= Date.now() || expiresAt > Date.now() + 2 * 60 * 60 * 1000) throw new SingleAppGitHubError(502, 'github_token_expiry_invalid');
    if (payload.permissions.metadata !== 'read' || repositoryId !== undefined && payload.permissions.contents !== 'read') {
      throw new SingleAppGitHubError(502, 'github_token_scope_invalid');
    }
    if (repositoryId !== undefined && (payload.repository_selection !== 'selected'
      || !payload.repositories?.some(repository => repository.id === repositoryId))) {
      throw new SingleAppGitHubError(502, 'github_token_repository_invalid');
    }
    return payload.token;
  }

  async function withInstallationToken<T>(installationId: string, repositoryId: number | undefined, work: (token: string) => Promise<T>): Promise<T> {
    const token = await installationToken(installationId, repositoryId);
    try {
      return await work(token);
    } finally {
      await request(new URL('/installation/token', apiBase), { method: 'DELETE', headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2026-03-10', 'user-agent': 'Gotchu/0.1.0',
      } }).then(response => assertResponseOrigin(response, apiBase)).catch(() => undefined);
    }
  }

  async function requireInstallation(organizationId: string, installationId: string, applicationId?: string) {
    const binding = await options.database.tenant(organizationId, tx => loadSingleAppInstallation(tx, {
      organizationId, ...(applicationId ? { applicationId } : {}), installationId,
    }, options.app.id));
    const parsed = installationBindingSchema.safeParse(binding);
    if (!parsed.success || parsed.data.installationId !== installationId || parsed.data.appId !== options.app.id) {
      throw new SingleAppGitHubError(409, 'github_installation_binding_invalid');
    }
    return parsed.data;
  }

  async function requireRepository(scope: { organizationId: string; applicationId: string; repositoryLinkId: string }): Promise<SingleAppRepositoryBinding> {
    const rawBinding = await options.database.tenant(scope.organizationId, tx => loadSingleAppRepository(tx, {
      organizationId: scope.organizationId, applicationId: scope.applicationId, repositoryLinkId: scope.repositoryLinkId,
    }, options.app.id));
    const binding = repositoryBindingSchema.parse(rawBinding);
    const repositoryKeyId = /^gh-([1-9][0-9]*)$/.exec(binding.repositoryKey)?.[1];
    if (!repositoryKeyId || Number(repositoryKeyId) !== binding.repositoryId || binding.appId !== options.app.id
      || binding.repositoryLinkId !== scope.repositoryLinkId) {
      throw new SingleAppGitHubError(409, 'github_repository_binding_invalid');
    }
    return binding;
  }

  async function resolveReadScope(scope: SingleAppReadScope) {
    if (scope.repositoryLinkId) return { ...scope, repositoryLinkId: scope.repositoryLinkId };
    if (!scope.repositoryKey) throw new SingleAppGitHubError(409, 'github_repository_binding_invalid');
    const result = await options.database.tenant(scope.organizationId, tx => tx.query<{ id: string }>(
      `SELECT id FROM gotchu.application_repository_links
        WHERE organization_id=$1 AND application_id=$2 AND repository_key=$3`,
      [scope.organizationId, scope.applicationId, scope.repositoryKey],
    ));
    const repositoryLinkId = result.rows[0]?.id;
    if (!repositoryLinkId) throw new SingleAppGitHubError(404, 'github_repository_binding_missing');
    return { ...scope, repositoryLinkId };
  }

  async function repositoryMetadata(binding: SingleAppRepositoryBinding, token: string) {
    const result = await githubJson(`/repositories/${binding.repositoryId}`, token, repositoryApiSchema, 256 * 1024);
    if (result.id !== binding.repositoryId) throw new SingleAppGitHubError(409, 'github_repository_identity_changed');
    return githubRepositorySchema.parse({
      id: result.id, fullName: result.full_name, defaultBranch: result.default_branch,
      private: result.private, archived: result.archived,
    });
  }

  async function readHead(owner: string, repository: string, branch: string, token: string): Promise<string> {
    const safeBranch = gitRefSchema.parse(branch);
    const ref = await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/heads/${safeBranch.split('/').map(encodeURIComponent).join('/')}`, token, refSchema, 256 * 1024);
    return ref.object.sha.toLowerCase();
  }

  async function readTree(owner: string, repository: string, commitSha: string, token: string): Promise<GitTree> {
    const commit = await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/commits/${encodeURIComponent(commitSha)}`, token, commitSchema, 256 * 1024);
    const tree = await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`, token, treeSchema);
    if (tree.sha.toLowerCase() !== commit.tree.sha.toLowerCase()) throw new SingleAppGitHubError(502, 'github_tree_mismatch');
    const entries: GitTree['entries'][number][] = [];
    for (const entry of tree.tree) {
      if (entry.type === 'tree') continue;
      entries.push({ path: entry.path, mode: entry.mode === '040000' ? '100644' : entry.mode,
        type: entry.type, sha: entry.sha.toLowerCase() });
    }
    return { treeSha: tree.sha.toLowerCase(), entries, truncated: tree.truncated };
  }

  async function automationViolations(owner: string, repository: string, commitSha: string, token: string) {
    const tree = await readTree(owner, repository, commitSha, token);
    if (tree.truncated) throw new SingleAppGitHubError(413, 'github_tree_truncated');
    const workflows = tree.entries.filter(entry => entry.type === 'blob' && entry.path.startsWith('.github/workflows/'));
    if (workflows.length > MAX_WORKFLOW_FILES) throw new SingleAppGitHubError(413, 'github_workflow_limit');
    let byteCount = 0;
    const files: Array<{ path: string; content: string }> = [];
    for (const entry of workflows) {
      const blob = await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/blobs/${encodeURIComponent(entry.sha)}`, token, blobSchema, 3 * 1024 * 1024);
      const bytes = Buffer.from(blob.content, 'base64');
      byteCount += bytes.byteLength;
      if (byteCount > MAX_WORKFLOW_BYTES) throw new SingleAppGitHubError(413, 'github_workflow_bytes_limit');
      files.push({ path: entry.path, content: bytes.toString('utf8') });
    }
    const reasons = {
      invalid_yaml: 'Workflow YAML is invalid.',
      invalid_document: 'Workflow document does not have a supported shape.',
      pull_request_target: 'The workflow uses a privileged pull_request_target trigger.',
      push_without_branch_filter: 'The workflow runs on push without a branch filter.',
      push_to_gotchu_branch: 'The workflow targets a Gotchu-managed branch.',
      forbidden_pull_request_secret: 'The workflow exposes a secret to pull request code.',
    } as const;
    return inspectWorkflowPolicy(files).map(violation => ({ ...violation, reason: reasons[violation.rule] }));
  }

  async function withRepositoryRead<T>(
    scope: SingleAppReadScope,
    work: (binding: SingleAppRepositoryBinding, repository: z.infer<typeof githubRepositorySchema>, owner: string, name: string, token: string) => Promise<T>,
  ): Promise<T> {
    const checkedScope = await resolveReadScope(scope);
    const binding = await requireRepository(checkedScope);
    if (scope.repositoryKey && binding.repositoryKey !== scope.repositoryKey) throw new SingleAppGitHubError(409, 'github_repository_binding_invalid');
    return withInstallationToken(binding.installationId, binding.repositoryId, async token => {
      const repository = await repositoryMetadata(binding, token);
      const [owner, name] = repository.fullName.split('/');
      if (!owner || !name) throw new SingleAppGitHubError(502, 'github_repository_metadata_invalid');
      return work(binding, repository, owner, name, token);
    });
  }

  return {
    get appId() { return options.app.id; },
    async installationStatus(organizationId: string, installationId: string) {
      await requireInstallation(organizationId, installationId);
      try {
        const result = await appJson(`/app/installations/${encodeURIComponent(installationId)}`, installationStatusSchema);
        return { active: String(result.id) === installationId && result.suspended_at === null };
      } catch (error) {
        if (error instanceof SingleAppGitHubError && error.status === 404) return { active: false };
        throw error;
      }
    },
    async listRepositories(organizationId: string, applicationId: string, installationId: string) {
      await requireInstallation(organizationId, installationId, applicationId);
      return withInstallationToken(installationId, undefined, async token => {
        const repositories: z.infer<typeof repositoryApiSchema>[] = [];
        let totalCount = 0;
        for (let page = 1; page <= 10; page += 1) {
          const result = await githubJson(`/installation/repositories?per_page=100&page=${page}`, token, repositoryPageSchema);
          totalCount = result.total_count;
          repositories.push(...result.repositories);
          if (repositories.length >= totalCount || result.repositories.length < 100) break;
        }
        if (repositories.length < totalCount || totalCount > 1000) throw new SingleAppGitHubError(413, 'github_repository_limit');
        return { repositories: repositories.map(repository => githubRepositorySchema.parse({
          id: repository.id, fullName: repository.full_name, defaultBranch: repository.default_branch,
          private: repository.private, archived: repository.archived,
        })) };
      });
    },
    async readRepository(input: { organizationId: string; applicationId: string; repositoryLinkId: string; read: 'snapshot' | 'head' | 'tree' | 'automation'; commitSha?: string | undefined }) {
      const binding = await requireRepository(input);
      return withInstallationToken(binding.installationId, binding.repositoryId, async token => {
        const repository = await repositoryMetadata(binding, token);
        const [owner, name] = repository.fullName.split('/');
        if (!owner || !name) throw new SingleAppGitHubError(502, 'github_repository_metadata_invalid');
        if (input.read === 'snapshot') {
          const catalog = createMonitoringRepositoryCatalog({
            repositoryRoot: '/tmp', repositories: [{ organizationId: input.organizationId, applicationId: input.applicationId,
              repositoryKey: binding.repositoryKey, displayName: repository.fullName, provider: 'github', owner, repository: name,
              ref: binding.defaultBranch }],
          });
          const observation = await createGitHubRepositoryReader(catalog, {
            ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
            installationTokenProvider: async () => token,
          }).read({ organizationId: input.organizationId, applicationId: input.applicationId, repositoryKey: binding.repositoryKey });
          if (!observation.commit.treeSha) throw new SingleAppGitHubError(502, 'github_tree_missing');
          return { result: {
            kind: 'snapshot' as const, snapshot: customerSourceSnapshotSchema.parse(observation.snapshot), digest: observation.digest,
            repository, installationId: binding.installationId, appId: binding.appId, treeSha: observation.commit.treeSha,
          } };
        }
        if (input.read === 'head') {
          const sha = await readHead(owner, name, binding.defaultBranch, token);
          return { result: { kind: 'head' as const, sha } };
        }
        const headSha = input.commitSha ?? await readHead(owner, name, binding.defaultBranch, token);
        if (input.read === 'tree') {
          const tree = await readTree(owner, name, headSha, token);
          return { result: { kind: 'tree' as const, tree: {
            treeSha: tree.treeSha, entries: tree.entries, truncated: tree.truncated,
          } } };
        }
        const violations = await automationViolations(owner, name, headSha, token);
        return { result: { kind: 'automation' as const, violations } };
      });
    },
    async resolveRepository(scope: { organizationId: string; applicationId: string; repositoryLinkId: string }) {
      return requireRepository(scope);
    },
    async readHead(scope: SingleAppReadScope, branch: string): Promise<string> {
      return withRepositoryRead(scope, (binding, _repository, owner, name, token) => readHead(owner, name, branch || binding.defaultBranch, token));
    },
    async readTree(scope: SingleAppReadScope, commitSha: string): Promise<GitTree> {
      return withRepositoryRead(scope, (_binding, _repository, owner, name, token) => readTree(owner, name, commitSha, token));
    },
    async inspectAutomation(scope: SingleAppReadScope, baseCommit: string): Promise<WorkflowPolicyViolation[]> {
      return withRepositoryRead(scope, (_binding, _repository, owner, name, token) => automationViolations(owner, name, baseCommit, token));
    },
    async withRepositoryMetadata<T>(binding: SingleAppRepositoryBinding, work: (repository: z.infer<typeof githubRepositorySchema>) => T | Promise<T>): Promise<T> {
      return withInstallationToken(binding.installationId, binding.repositoryId, async token => work(await repositoryMetadata(binding, token)));
    },
    async isActiveInstallation(organizationId: string, applicationId: string, installationId: string) {
      await requireInstallation(organizationId, installationId, applicationId);
      try {
        const result = await appJson(`/app/installations/${encodeURIComponent(installationId)}`, installationStatusSchema);
        return String(result.id) === installationId && result.suspended_at === null;
      } catch (error) {
        if (error instanceof SingleAppGitHubError && error.status === 404) return false;
        throw error;
      }
    },
  };
}

export async function writerInstallationIdFor(database: Database, appId: string, scope: {
  organizationId: string; applicationId: string; repositoryKey: string; repositoryLinkId?: string;
}): Promise<string | null> {
  const result = await database.tenant(scope.organizationId, tx => tx.query<{ writer_installation_id: string | null }>(
    `SELECT l.writer_installation_id
      FROM gotchu.application_repository_links l
      JOIN gotchu.github_installations g
        ON g.organization_id=l.organization_id AND g.installation_id=l.writer_installation_id
      WHERE l.organization_id=$1 AND l.application_id=$2 AND ($3::uuid IS NULL OR l.id=$3) AND l.repository_key=$4
        AND l.state='verified' AND NOT l.revoked AND l.write_access='granted'
        AND g.state='active' AND g.connection_mode='single_app' AND g.app_id=$5`,
    [scope.organizationId, scope.applicationId, scope.repositoryLinkId ?? null, scope.repositoryKey, appId],
  ));
  const installationId = result.rows[0]?.writer_installation_id;
  if (installationId !== null && installationId !== undefined && !/^\d{1,20}$/.test(installationId)) {
    throw new SingleAppGitHubError(409, 'github_writer_binding_invalid');
  }
  return installationId ?? null;
}

export function createSingleAppGitHubResolver(options: {
  database: Database;
  app: GitHubSingleAppCredentials;
  fetchImplementation?: typeof fetch;
}) {
  return createSingleAppResolver(options);
}

export async function exchangeGitHubOAuthCode(input: {
  app: GitHubSingleAppCredentials;
  publicAppUrl: string;
  code: string;
  verifier: string;
  fetchImplementation?: typeof fetch;
}): Promise<string> {
  const fetcher = input.fetchImplementation ?? fetch;
  const response = await fetcher('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: input.app.clientId, client_secret: input.app.clientSecret, code: input.code,
      code_verifier: input.verifier, redirect_uri: new URL('/api/customer/github/callback', input.publicAppUrl).href }),
    signal: AbortSignal.timeout(15_000),
  });
  assertResponseOrigin(response, 'https://github.com');
  if (!response.ok) throw new SingleAppGitHubError(502, 'github_oauth_failed');
  return parseApiResponse(await parseJsonResponse(response, 64 * 1024), oauthTokenSchema).access_token;
}

export async function revokeGitHubOAuthToken(input: {
  app: GitHubSingleAppCredentials;
  token: string;
  fetchImplementation?: typeof fetch;
}): Promise<void> {
  const fetcher = input.fetchImplementation ?? fetch;
  const response = await fetcher(new URL(`/applications/${encodeURIComponent(input.app.clientId)}/grant`, apiBase), {
    method: 'DELETE', headers: {
      accept: 'application/vnd.github+json', 'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${input.app.clientId}:${input.app.clientSecret}`).toString('base64')}`,
      'x-github-api-version': '2026-03-10', 'user-agent': 'Gotchu/0.1.0',
    }, body: JSON.stringify({ access_token: input.token }), signal: AbortSignal.timeout(15_000),
  });
  assertResponseOrigin(response, apiBase);
  if (!response.ok && response.status !== 404) throw new SingleAppGitHubError(502, 'github_oauth_revoke_failed');
}

export async function githubUserInstallations(token: string, fetchImplementation?: typeof fetch) {
  const fetcher = fetchImplementation ?? fetch;
  const installations: z.infer<typeof installationSchema>[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetcher(new URL(`/user/installations?per_page=100&page=${page}`, apiBase), {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': 'Gotchu/0.1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    assertResponseOrigin(response, apiBase);
    if (!response.ok) throw new SingleAppGitHubError(response.status, `github_http_${response.status}`);
    const result = parseApiResponse(await parseJsonResponse(response, 2 * 1024 * 1024), installationListSchema);
    installations.push(...result.installations);
    if (result.installations.length < 100) return installations;
  }
  throw new SingleAppGitHubError(413, 'github_user_installation_limit');
}

export async function requireGitHubInstallationOwner(token: string, installationId: string, fetchImplementation?: typeof fetch) {
  const fetcher = fetchImplementation ?? fetch;
  async function data<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await fetcher(new URL(path, apiBase), {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': 'Gotchu/0.1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    assertResponseOrigin(response, apiBase);
    if (!response.ok) throw new SingleAppGitHubError(response.status, `github_http_${response.status}`);
    return parseApiResponse(await parseJsonResponse(response, 256 * 1024), schema);
  }
  const [user, installations] = await Promise.all([data('/user', userSchema), githubUserInstallations(token, fetcher)]);
  const installation = installations.find(item => String(item.id) === installationId);
  if (!installation) throw new SingleAppGitHubError(403, 'github_installation_not_accessible');
  let owner = installation.account.type === 'User' && installation.account.id === user.id;
  if (installation.account.type === 'Organization') {
    try {
      const membership = await data(`/user/memberships/orgs/${encodeURIComponent(installation.account.login)}`, membershipSchema);
      owner = membership.state === 'active' && membership.role === 'admin'
        && membership.user.id === user.id && membership.organization.id === installation.account.id;
    } catch (error) {
      if (!(error instanceof SingleAppGitHubError) || ![403, 404].includes(error.status)) throw error;
    }
  }
  if (!owner) throw new SingleAppGitHubError(403, 'github_owner_required');
  return { installation, githubUserId: String(user.id) };
}

