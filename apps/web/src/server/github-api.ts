import { createSign, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createGitHubRepositoryReader, createMonitoringRepositoryCatalog } from '@gotchu/monitoring';
import type { Backend, Identity } from '@gotchu/backend';
import { githubConnectResponseSchema, githubConnectionSchema, githubRepositorySchema, githubRepositoriesSchema } from '@gotchu/contracts';
import type { CustomerServices } from './customer-api.js';
import { errorResponse, HttpError, json, readBoundedBody, requireSameOrigin } from './http.js';
import { githubConsentPage, githubUserInstallations, requireGitHubInstallationOwner } from './github-authorization.js';
import { createSingleAppGitHubApi, type SingleGitHubPublicApp } from './github-single-app.js';
import type { SingleAppGitHubBroker } from './github-broker-client.js';

const appFileSchema = z.object({ id: z.preprocess(value => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value, z.string().regex(/^\d+$/)), slug: z.string().regex(/^[a-z0-9-]+$/i).optional(), clientId: z.string().min(1), clientSecret: z.string().min(1), privateKeyPem: z.string().min(1), webhookSecret: z.string().min(1) }).passthrough();
const repositoryListSchema = z.object({ repositories: z.array(z.object({ id: z.number().int().positive(), full_name: z.string().min(3).max(200), default_branch: z.string().min(1).max(200), private: z.boolean(), archived: z.boolean() }).passthrough()).max(1000), total_count: z.number().int().nonnegative() }).passthrough();
const accessTokenSchema = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() }).passthrough();
const oauthTokenSchema = z.object({ access_token: z.string().min(1), token_type: z.literal('bearer'), scope: z.string().optional() }).passthrough();
type GithubServices = {
  github: Pick<Backend['github'], 'workspaceName' | 'createState' | 'consumeState' | 'bind' | 'list' | 'revoke' | 'createRepositoryLink' | 'importCapturedSource'>;
} & Pick<NonNullable<CustomerServices>, 'uploadSource' | 'uploadCapturedSource' | 'queue'>;
type AppCredentials = z.infer<typeof appFileSchema>;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'content_type', 'Utiliza application/json.');
  try { const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 16_384))); return value; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json', 'El cuerpo no contiene JSON válido.'); }
}

async function readApp(path: string): Promise<AppCredentials> {
  let input: unknown;
  try { input = JSON.parse(await readFile(path, 'utf8')); } catch { throw new HttpError(503, 'github_not_configured', 'La conexión con GitHub no está configurada correctamente.'); }
  const parsed = appFileSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(503, 'github_not_configured', 'La conexión con GitHub no está configurada correctamente.');
  return parsed.data;
}
async function githubJson<T>(path: string, token: string, schema: z.ZodType<T>, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await fetcher(new URL(path, 'https://api.github.com'), { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': 'Gotchu/0.1.0' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new HttpError(response.status, `github_http_${response.status}`, 'GitHub no pudo completar la solicitud. Comprueba la conexión y vuelve a intentarlo.');
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new HttpError(502, 'github_invalid_response', 'GitHub devolvió una respuesta que no se pudo leer.'); }
  const result = schema.safeParse(payload);
  if (!result.success) throw new HttpError(502, 'github_invalid_response', 'GitHub devolvió datos inesperados.');
  return result.data;
}
function appJwt(credentials: AppCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 30, exp: now + 8 * 60, iss: credentials.id })).toString('base64url');
  const body = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(body);
  return `${body}.${signer.sign(credentials.privateKeyPem).toString('base64url')}`;
}
async function installationToken(installationId: string, credentials: AppCredentials): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST', headers: { authorization: `Bearer ${appJwt(credentials)}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': 'Gotchu/0.1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new HttpError(response.status, `github_http_${response.status}`, 'GitHub no pudo emitir un token de lectura para esta instalación.');
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new HttpError(502, 'github_invalid_response', 'GitHub devolvió una respuesta que no se pudo leer.'); }
  const token = accessTokenSchema.safeParse(payload);
  if (!token.success) throw new HttpError(502, 'github_invalid_response', 'GitHub devolvió datos de instalación inesperados.');
  tokenCache.set(installationId, { token: token.data.token, expiresAt: Date.parse(token.data.expires_at) });
  return token.data.token;
}
export async function listGitHubInstallationRepositories(token: string, fetcher: typeof fetch = fetch) {
  const repositories: z.infer<typeof repositoryListSchema.shape.repositories>[number][] = [];
  let totalCount = 0;
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubJson(`/installation/repositories?per_page=100&page=${page}`, token, repositoryListSchema, fetcher);
    totalCount = result.total_count;
    repositories.push(...result.repositories);
    if (repositories.length >= totalCount || result.repositories.length < 100) break;
  }
  if (repositories.length < totalCount || totalCount > 1000) throw new HttpError(413, 'github_repository_limit', 'La instalación contiene más de 1000 repositorios; reduce su alcance antes de conectarla.');
  return repositories;
}

function authorizationUrl(origin: string, credentials: AppCredentials, handshake: { state: string; codeChallenge: string | null }) {
  if (!handshake.codeChallenge) throw new Error('github_pkce_required');
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: new URL('/api/customer/github/callback', origin).href,
    state: handshake.state, code_challenge: handshake.codeChallenge, code_challenge_method: 'S256' }).toString();
  return url.href;
}

export async function mintGitHubInstallationToken(installationId: string, appFile: string): Promise<string> {
  return installationToken(installationId, await readApp(appFile));
}

export function createGitHubApi(options: { origin: string; appFile?: string; appSlug?: string; services: GithubServices | null; fetchImplementation?: typeof fetch; singleApp?: { publicApp: SingleGitHubPublicApp; broker: SingleAppGitHubBroker } }) {
  const fetcher = options.fetchImplementation ?? fetch;
  const singleAppHandler = options.singleApp ? createSingleAppGitHubApi({
    origin: options.origin,
    publicApp: options.singleApp.publicApp,
    broker: options.singleApp.broker,
    services: options.services,
  }) : null;
  return async (request: Request, identity: Identity | null, cookies: readonly string[] = []): Promise<Response | null> => {
    if (singleAppHandler) return singleAppHandler(request, identity, cookies);
    const url = new URL(request.url);
    const path = url.pathname.split('/').filter(Boolean);
    const isConnect = url.pathname === '/api/customer/github/connect';
    const isCallback = url.pathname === '/api/customer/github/callback';
    const isChoose = url.pathname === '/api/customer/github/choose';
    const isGithubWorkspace = path[0] === 'api' && path[1] === 'customer' && path[2] === 'workspaces' && (path[4] === 'github' || (path[4] === 'applications' && path[6] === 'github'));
    if (!isConnect && !isCallback && !isChoose && !isGithubWorkspace) return null;
    const headers = new Headers({ 'Cache-Control': 'private, no-store' });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') requireSameOrigin(request, options.origin);
      if (!identity) throw new HttpError(401, 'unauthenticated', 'Inicia sesión para conectar GitHub.');
      const services = options.services;
      if (!services) throw new HttpError(503, 'database_not_configured', 'La base de datos no está configurada.');
      const send = (data: unknown, status = 200) => json(data, status, headers);
      const redirect = (location: string) => { headers.set('location', location); headers.set('Referrer-Policy', 'no-referrer'); return new Response(null, { status: 303, headers }); };
      if (isConnect && request.method === 'POST') {
        if (!options.appFile) throw new HttpError(503, 'github_not_configured', 'La conexión con GitHub no está configurada.');
        const credentials = await readApp(options.appFile);
        const slug = options.appSlug ?? credentials.slug;
        if (!slug) throw new HttpError(503, 'github_not_configured', 'Configura el URL slug de la GitHub App.');
        const body = await readJson(request);
        const scope = z.object({ organizationId: z.uuid() }).strict().parse(body);
        const handshake = await services.github.createState(identity, scope);
        return send(githubConnectResponseSchema.parse({ installUrl: authorizationUrl(options.origin, credentials, handshake) }));
      }
      if (isChoose && request.method === 'POST') {
        if (!options.appFile) throw new HttpError(503, 'github_not_configured', 'La conexión con GitHub no está configurada.');
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'content_type', 'Utiliza el formulario de conexión de GitHub.');
        const form = new URLSearchParams(new TextDecoder().decode(await readBoundedBody(request, 16_384)));
        const state = form.get('state') ?? '';
        const installationId = form.get('installationId') ?? '';
        if (state.length < 32 || state.length > 128 || installationId !== 'new' && !/^\d{1,20}$/.test(installationId)) throw new HttpError(400, 'github_selection_invalid', 'Selecciona una instalación válida.');
        const context = await services.github.consumeState(identity, state);
        if (context.purpose !== 'choose') throw new HttpError(400, 'github_selection_invalid', 'Inicia la conexión de GitHub de nuevo.');
        await services.github.workspaceName(identity, context.organizationId);
        const credentials = await readApp(options.appFile);
        const handshake = await services.github.createState(identity, { organizationId: context.organizationId, installationId: installationId === 'new' ? null : installationId, purpose: installationId === 'new' ? 'install' : 'authorize' });
        if (installationId !== 'new') return redirect(authorizationUrl(options.origin, credentials, handshake));
        const slug = options.appSlug ?? credentials.slug;
        if (!slug) throw new HttpError(503, 'github_not_configured', 'Configura el URL slug de la GitHub App.');
        return redirect(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(handshake.state)}`);
      }
      if (isCallback && request.method === 'GET') {
        const state = url.searchParams.get('state') ?? '';
        const code = url.searchParams.get('code') ?? '';
        if (!options.appFile || state.length < 32 || state.length > 128) throw new HttpError(400, 'github_callback_invalid', 'GitHub no devolvió una autorización válida.');
        const context = await services.github.consumeState(identity, state);
        const { organizationId } = context;
        const workspaceName = await services.github.workspaceName(identity, organizationId);
        const credentials = await readApp(options.appFile);
        if (context.purpose === 'install') {
          const installationId = url.searchParams.get('installation_id') ?? '';
          if (!/^\d{1,20}$/.test(installationId) || !['install', 'update'].includes(url.searchParams.get('setup_action') ?? '')) throw new HttpError(400, 'github_callback_invalid', 'GitHub no devolvió una instalación válida.');
          // Installation callbacks are hints, never proof of delegation. Start our own PKCE flow.
          return redirect(authorizationUrl(options.origin, credentials, await services.github.createState(identity, { organizationId, installationId })));
        }
        if (context.purpose !== 'authorize' || !context.verifier || !code || code.length > 512) throw new HttpError(400, 'github_callback_invalid', 'GitHub no devolvió una autorización válida.');
        const exchangeResponse = await fetcher('https://github.com/login/oauth/access_token', {
          method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code, code_verifier: context.verifier, redirect_uri: new URL('/api/customer/github/callback', options.origin).href }), signal: AbortSignal.timeout(15_000),
        });
        if (!exchangeResponse.ok) throw new HttpError(502, 'github_oauth_failed', 'No se pudo completar la autorización con GitHub.');
        let exchangePayload: unknown;
        try { exchangePayload = await exchangeResponse.json(); } catch { throw new HttpError(502, 'github_oauth_failed', 'GitHub devolvió una respuesta de autorización inválida.'); }
        const exchange = oauthTokenSchema.safeParse(exchangePayload);
        if (!exchange.success) throw new HttpError(400, 'github_oauth_failed', 'GitHub no autorizó la conexión. Vuelve a intentarlo.');
        if (!context.installationId) {
          const installations = await githubUserInstallations(exchange.data.access_token, fetcher);
          const selection = await services.github.createState(identity, { organizationId, purpose: 'choose' });
          return githubConsentPage(workspaceName, selection.state, installations, headers);
        }
        const { installation, githubUserId } = await requireGitHubInstallationOwner(exchange.data.access_token, context.installationId, fetcher);
        await services.github.bind(identity, { organizationId, userId: identity.userId, state, installationId: context.installationId, accountLogin: installation.account.login, githubUserId, githubAccountId: String(installation.account.id) });
        return redirect('/dashboard?github=connected');
      }
      const organizationId = z.uuid().parse(path[3]);
      if (path.length === 6 && path[5] === 'connections' && request.method === 'GET') {
        const current = await services.github.list(identity, { organizationId });
        if (options.appFile) {
          const credentials = await readApp(options.appFile);
          for (let offset = 0; offset < current.length; offset += 4) {
            await Promise.all(current.slice(offset, offset + 4).filter(connection => connection.state === 'active').map(async connection => {
              try { await installationToken(connection.installationId, credentials); }
              catch (error) { if (error instanceof HttpError && [401, 403, 404].includes(error.status)) await services.github.revoke(identity, organizationId, connection.installationId); else throw error; }
            }));
          }
        }
        return send(await services.github.list(identity, { organizationId }));
      }
      if (path.length === 7 && path[5] === 'connections' && path[6] && request.method === 'DELETE') {
        await services.github.revoke(identity, organizationId, path[6]);
        return new Response(null, { status: 204, headers });
      }
      if (path.length === 10 && path[6] === 'github' && path[7] === 'installations' && path[9] === 'repositories' && request.method === 'GET') {
        const installationId = z.string().regex(/^\d{1,20}$/).parse(path[8]);
        const connection = (await services.github.list(identity, { organizationId })).find(item => item.installationId === installationId && item.state === 'active');
        if (!connection) throw new HttpError(404, 'github_connection_missing', 'Conecta una instalación activa para listar sus repositorios.');
        const credentials = await readApp(options.appFile ?? '');
        try {
          const token = await installationToken(installationId, credentials);
          const response = await listGitHubInstallationRepositories(token, fetcher);
          return send(githubRepositoriesSchema.parse(response.map(repo => ({ id: repo.id, fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private, archived: repo.archived }))));
        } catch (error) {
          if (error instanceof HttpError && [401, 403, 404].includes(error.status)) await services.github.revoke(identity, organizationId, installationId);
          throw error;
        }
      }
      if (path.length === 12 && path[6] === 'github' && path[7] === 'installations' && path[9] === 'repositories' && path[11] === 'select' && request.method === 'POST') {
        const installationId = z.string().regex(/^\d{1,20}$/).parse(path[8]);
        const applicationId = z.uuid().parse(path[5]);
        const repositoryId = z.coerce.number().int().positive().parse(path[10]);
        const requested = z.object({ fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200), defaultBranch: z.string().min(1).max(200) }).strict().parse(await readJson(request));
        const connection = (await services.github.list(identity, { organizationId })).find(item => item.installationId === installationId && item.state === 'active');
        if (!connection) throw new HttpError(404, 'github_connection_missing', 'La instalación de GitHub ya no está conectada.');
        const credentials = await readApp(options.appFile ?? '');
        try {
          const token = await installationToken(installationId, credentials);
          const repos = await listGitHubInstallationRepositories(token, fetcher);
          const repository = repos.find(item => item.id === repositoryId && item.full_name === requested.fullName && item.default_branch === requested.defaultBranch);
          if (!repository) throw new HttpError(404, 'github_repository_not_accessible', 'El repositorio ya no está disponible en esta instalación.');
          const key = `gh-${repository.id}`;
          const catalog = createMonitoringRepositoryCatalog({ repositoryRoot: '/tmp', repositories: [{ organizationId, applicationId, repositoryKey: key, displayName: repository.full_name, provider: 'github', owner: repository.full_name.split('/')[0], repository: repository.full_name.split('/')[1] }] });
          const reader = createGitHubRepositoryReader(catalog, { installationTokenProvider: async () => token });
          const observation = await reader.read({ organizationId, applicationId, repositoryKey: key }).catch(error => {
            if (error instanceof Error && error.message === 'repository_no_supported_files') throw new HttpError(422, 'github_no_supported_files', 'La rama predeterminada no contiene archivos JS/TS, JSON, YAML o TOML compatibles para una evaluación interna. El repositorio sigue conectado; elige otra fuente o sube una carpeta compatible.');
            throw error;
          });
          const source = await services.uploadSource(identity, { organizationId, applicationId, authorized: true, snapshot: observation.snapshot });
          const link = await services.github.createRepositoryLink(identity, { organizationId, applicationId, installationId, repositoryId, fullName: repository.full_name, defaultBranch: repository.default_branch });
          const queued = await services.queue(identity, { organizationId, applicationId, mode: 'internal', sourceSnapshotId: source.id, targetId: null, idempotencyKey: `github-first-scan:${installationId}:${repository.id}:${observation.commit.sha}` });
          return send({ repository: githubRepositorySchema.parse({ id: repository.id, fullName: repository.full_name, defaultBranch: repository.default_branch, private: repository.private, archived: repository.archived }), link, source, jobId: queued.jobId }, 201);
        } catch (error) {
          if (error instanceof HttpError && [401, 403, 404].includes(error.status)) await services.github.revoke(identity, organizationId, installationId);
          throw error;
        }
      }
      throw new HttpError(404, 'not_found', 'Ruta de GitHub no encontrada.');
    } catch (error) { return errorResponse(error); }
  };
}
