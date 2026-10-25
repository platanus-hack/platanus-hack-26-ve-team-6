import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parseJsonBody, requestJson } from './http.js';

const apiBase = 'https://api.github.com';
const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': 'Gotchu-Monitoring/0.1.0' };
const appFileSchema = z.object({
  id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String),
  privateKeyPem: z.string().min(1),
}).passthrough();
const accessTokenSchema = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() }).passthrough();
const repositoryListSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(z.object({
    id: z.number().int().positive(),
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
    default_branch: z.string().min(1).max(200),
    archived: z.boolean(),
  }).passthrough()).max(100),
}).passthrough();
const MAX_INSTALLATION_REPOSITORY_PAGES = 10;

export interface GitHubAppInstallationClientOptions {
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Reads a GitHub App credential file and mints short-lived installation tokens.
 * Callers decide which installation a tenant may use; this client only talks to GitHub.
 */
export function createGitHubAppInstallationClient(appFile: string, options: GitHubAppInstallationClientOptions = {}) {
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const request = { timeoutMs: options.timeoutMs ?? 15_000, retries: 1, ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}) };

  async function installationToken(installationId: string, signal?: AbortSignal): Promise<string> {
    if (!/^\d{1,20}$/.test(installationId)) throw new Error('github_installation_invalid');
    const cached = cache.get(installationId);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const credentials = appFileSchema.parse(JSON.parse(await readFile(appFile, 'utf8')));
    const response = await requestJson(new URL(`/app/installations/${installationId}/access_tokens`, apiBase), {
      ...request, method: 'POST', headers: { ...headers, authorization: `Bearer ${appJwt(credentials.id, credentials.privateKeyPem)}` }, ...(signal ? { signal } : {}),
    });
    const token = accessTokenSchema.parse(parseJsonBody(response.body));
    cache.set(installationId, { token: token.token, expiresAt: Date.parse(token.expires_at) });
    return token.token;
  }

  return {
    installationToken,
    /**
     * Finds a repository among those the installation can currently access, with its current name and
     * default branch. `/repositories/:id` is not enough: it also serves public repositories outside the installation.
     */
    async repository(installationId: string, repositoryId: number, signal?: AbortSignal) {
      const token = await installationToken(installationId, signal);
      for (let page = 1; page <= MAX_INSTALLATION_REPOSITORY_PAGES; page += 1) {
        const response = await requestJson(new URL(`/installation/repositories?per_page=100&page=${page}`, apiBase), {
          ...request, maxBytes: 4 * 1024 * 1024, headers: { ...headers, authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}),
        });
        const list = repositoryListSchema.parse(parseJsonBody(response.body));
        const repository = list.repositories.find(item => item.id === repositoryId);
        if (repository) {
          const [owner = '', name = ''] = repository.full_name.split('/');
          return { owner, repository: name, fullName: repository.full_name, defaultBranch: repository.default_branch, archived: repository.archived };
        }
        if (page * 100 >= list.total_count) throw new Error('github_repository_not_in_installation');
      }
      throw new Error('github_installation_repository_limit');
    },
  };
}

function appJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 30, exp: now + 8 * 60, iss: appId })).toString('base64url');
  const body = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(body);
  return `${body}.${signer.sign(privateKeyPem).toString('base64url')}`;
}
