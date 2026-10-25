import {
  githubConnectResponseSchema,
  githubConnectionSchema,
  githubRepositorySchema,
  githubRepositoriesSchema,
  githubScopeSchema,
  idSchema,
  singleGitHubPublicAppSchema,
} from '@gotchu/contracts';
import type { Backend, Identity } from '@gotchu/backend';
import { z } from 'zod';
import type { CustomerServices } from './customer-api.js';
import { errorResponse, HttpError, json, readBoundedBody, requireSameOrigin } from './http.js';
import type { SingleAppGitHubBroker } from './github-broker-client.js';
import { githubConsentPage } from './github-authorization.js';

type GithubServices = {
  github: Pick<Backend['github'], 'createState' | 'consumeState' | 'workspaceName' | 'list' | 'revoke' | 'createRepositoryLink' | 'importCapturedSource'>;
} & Pick<NonNullable<CustomerServices>, 'uploadCapturedSource' | 'queue'>;
export type SingleGitHubPublicApp = z.infer<typeof singleGitHubPublicAppSchema>;

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'content_type', 'Utiliza application/json.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 16_384))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json', 'El cuerpo no contiene JSON válido.'); }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, 'invalid_input', 'La solicitud no coincide con el contrato permitido.');
  return result.data;
}

function authorizationUrl(origin: string, app: SingleGitHubPublicApp, handshake: { state: string; codeChallenge: string | null }) {
  if (!handshake.codeChallenge) throw new HttpError(503, 'github_pkce_unavailable', 'No se pudo iniciar una conexión segura con GitHub.');
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: new URL('/api/customer/github/callback', origin).href,
    state: handshake.state,
    code_challenge: handshake.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.href;
}

export function createSingleAppGitHubApi(options: {
  origin: string;
  publicApp: SingleGitHubPublicApp;
  broker: SingleAppGitHubBroker;
  services: GithubServices | null;
}) {
  return async (request: Request, identity: Identity | null, cookies: readonly string[] = []): Promise<Response | null> => {
    const url = new URL(request.url);
    const path = url.pathname.split('/').filter(Boolean);
    const isConnect = url.pathname === '/api/customer/github/connect';
    const isCallback = url.pathname === '/api/customer/github/callback';
    const isChoose = url.pathname === '/api/customer/github/choose';
    const isGithubWorkspace = path[0] === 'api' && path[1] === 'customer' && path[2] === 'workspaces'
      && (path[4] === 'github' || (path[4] === 'applications' && path[6] === 'github'));
    if (!isConnect && !isCallback && !isChoose && !isGithubWorkspace) return null;

    const headers = new Headers({ 'Cache-Control': 'private, no-store' });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') requireSameOrigin(request, options.origin);
      if (!identity) throw new HttpError(401, 'unauthenticated', 'Inicia sesión para conectar GitHub.');
      const services = options.services;
      if (!services) throw new HttpError(503, 'database_not_configured', 'La base de datos no está configurada.');
      const send = (data: unknown, status = 200) => json(data, status, headers);
      const redirect = (location: string) => {
        headers.set('location', location);
        headers.set('Referrer-Policy', 'no-referrer');
        return new Response(null, { status: 303, headers });
      };
      const createState = (input: { organizationId: string; installationId: string | null; purpose: 'authorize' | 'install' | 'choose' }) =>
        services.github.createState(identity, { ...input, appId: options.publicApp.id });

      if (isConnect && request.method === 'POST') {
        const scope = parse(githubScopeSchema, await readJson(request));
        const handshake = await createState({ ...scope, installationId: null, purpose: 'authorize' });
        return send(githubConnectResponseSchema.parse({ installUrl: authorizationUrl(options.origin, options.publicApp, handshake) }));
      }

      if (isChoose && request.method === 'POST') {
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'content_type', 'Utiliza el formulario de conexión de GitHub.');
        const form = new URLSearchParams(new TextDecoder().decode(await readBoundedBody(request, 16_384)));
        const state = form.get('state') ?? '';
        const installationId = form.get('installationId') ?? '';
        if (state.length < 32 || state.length > 128 || installationId !== 'new' && !/^\d{1,20}$/.test(installationId)) {
          throw new HttpError(400, 'github_selection_invalid', 'Selecciona una instalación válida.');
        }
        const context = await services.github.consumeState(identity, state, options.publicApp.id);
        if (context.purpose !== 'choose') throw new HttpError(400, 'github_selection_invalid', 'Inicia la conexión de GitHub de nuevo.');
        await services.github.workspaceName(identity, context.organizationId);
        const handshake = installationId === 'new'
          ? await createState({ organizationId: context.organizationId, installationId: null, purpose: 'install' })
          : await createState({ organizationId: context.organizationId, installationId, purpose: 'authorize' });
        if (installationId !== 'new') return redirect(authorizationUrl(options.origin, options.publicApp, handshake));
        return redirect(`https://github.com/apps/${encodeURIComponent(options.publicApp.slug)}/installations/new?state=${encodeURIComponent(handshake.state)}`);
      }

      if (isCallback && request.method === 'GET') {
        const state = url.searchParams.get('state') ?? '';
        if (state.length < 32 || state.length > 128) throw new HttpError(400, 'github_callback_invalid', 'GitHub no devolvió una autorización válida.');
        const setupAction = url.searchParams.get('setup_action');
        if (setupAction !== null) {
          const context = await services.github.consumeState(identity, state, options.publicApp.id);
          const installationId = url.searchParams.get('installation_id') ?? '';
          if (context.purpose !== 'install' || !/^\d{1,20}$/.test(installationId) || !['install', 'update'].includes(setupAction)) {
            throw new HttpError(400, 'github_callback_invalid', 'GitHub no devolvió una instalación válida.');
          }
          // GitHub's installation callback only supplies a hint. Start a fresh OAuth flow to verify it.
          const handshake = await createState({ organizationId: context.organizationId, installationId, purpose: 'authorize' });
          return redirect(authorizationUrl(options.origin, options.publicApp, handshake));
        }

        const code = url.searchParams.get('code') ?? '';
        if (!code || code.length > 512) throw new HttpError(400, 'github_callback_invalid', 'GitHub no devolvió una autorización válida.');
        const authorized = await options.broker.authorize({ actorId: identity.userId, state, code });
        if (authorized.result.kind === 'connected') return redirect('/dashboard?github=connected');
        const workspaceName = await services.github.workspaceName(identity, authorized.result.organizationId);
        const selection = await createState({ organizationId: authorized.result.organizationId, installationId: null, purpose: 'choose' });
        return githubConsentPage(workspaceName, selection.state, authorized.result.installations, headers, 'single-app');
      }

      const organizationId = parse(idSchema, path[3]);
      if (path.length === 6 && path[5] === 'connections' && request.method === 'GET') {
        const current = await services.github.list(identity, { organizationId });
        for (let offset = 0; offset < current.length; offset += 4) {
          await Promise.all(current.slice(offset, offset + 4).filter(connection => connection.state === 'active').map(async connection => {
            const status = await options.broker.installationStatus({ organizationId, installationId: connection.installationId });
            if (!status.active) await services.github.revoke(identity, organizationId, connection.installationId);
          }));
        }
        return send(z.array(githubConnectionSchema).max(20).parse(await services.github.list(identity, { organizationId })));
      }
      if (path.length === 7 && path[5] === 'connections' && path[6] && request.method === 'DELETE') {
        await services.github.revoke(identity, organizationId, path[6]);
        return new Response(null, { status: 204, headers });
      }
      if (path.length === 10 && path[6] === 'github' && path[7] === 'installations' && path[9] === 'repositories' && request.method === 'GET') {
        const installationId = parse(z.string().regex(/^\d{1,20}$/), path[8]);
        await requireActiveInstallation(services, options.broker, identity, organizationId, installationId);
        const repositories = await options.broker.listRepositories({ organizationId, applicationId: parse(z.uuid(), path[5]), installationId });
        return send(githubRepositoriesSchema.parse(repositories.repositories));
      }
      if (path.length === 12 && path[6] === 'github' && path[7] === 'installations' && path[9] === 'repositories' && path[11] === 'select' && request.method === 'POST') {
        const installationId = parse(z.string().regex(/^\d{1,20}$/), path[8]);
        const applicationId = parse(z.uuid(), path[5]);
        const repositoryId = parse(z.coerce.number().int().positive(), path[10]);
        const requested = parse(z.object({ fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200), defaultBranch: z.string().min(1).max(200) }).strict(), await readJson(request));
        await requireActiveInstallation(services, options.broker, identity, organizationId, installationId);
        const repositories = await options.broker.listRepositories({ organizationId, applicationId, installationId });
        const repository = repositories.repositories.find(item => item.id === repositoryId && item.fullName === requested.fullName && item.defaultBranch === requested.defaultBranch);
        if (!repository || repository.archived) throw new HttpError(404, 'github_repository_not_accessible', 'El repositorio ya no está disponible en esta instalación.');

        const link = await services.github.createRepositoryLink(identity, {
          organizationId, applicationId, installationId, repositoryId,
          fullName: repository.fullName, defaultBranch: repository.defaultBranch,
        });
        const captured = await options.broker.readRepository({ organizationId, applicationId, repositoryLinkId: link.id, read: 'snapshot' });
        if (captured.result.kind !== 'snapshot' || captured.result.appId !== options.publicApp.id || captured.result.installationId !== installationId
          || captured.result.repository.id !== repository.id || captured.result.repository.fullName !== repository.fullName
          || captured.result.repository.defaultBranch !== repository.defaultBranch
          || !/^[a-f0-9]{40}$/.test(captured.result.snapshot.revision) || !/^[a-f0-9]{40}$/.test(captured.result.treeSha)
          || !/^[a-f0-9]{64}$/.test(captured.result.digest)) {
          throw new HttpError(502, 'github_snapshot_invalid', 'GitHub devolvió una instantánea que no coincide con el repositorio seleccionado.');
        }

        if (!services.uploadCapturedSource) throw new HttpError(503, 'github_capture_unavailable', 'No se pudo guardar la captura de GitHub.');
        const capture = {
          organizationId,
          applicationId,
          repositoryLinkId: link.id,
          appId: captured.result.appId,
          installationId: captured.result.installationId,
          repositoryId,
          commitSha: captured.result.snapshot.revision,
          treeSha: captured.result.treeSha,
          digest: captured.result.digest,
        };
        const source = await services.uploadCapturedSource(identity, { organizationId, applicationId, authorized: true, snapshot: captured.result.snapshot }, capture);
        if (source.digest !== captured.result.digest) throw new HttpError(502, 'github_snapshot_digest_mismatch', 'No se pudo verificar la instantánea del repositorio.');
        await services.github.importCapturedSource(identity, { ...capture, sourceSnapshotId: source.id });
        const queued = await services.queue(identity, {
          organizationId, applicationId, mode: 'internal', sourceSnapshotId: source.id, targetId: null,
          idempotencyKey: `github-first-scan:${source.id}`,
        });
        return send({ repository: githubRepositorySchema.parse(repository), link, source, jobId: queued.jobId }, 201);
      }
      throw new HttpError(404, 'not_found', 'Ruta de GitHub no encontrada.');
    } catch (error) { return errorResponse(error); }
  };
}

async function requireActiveInstallation(
  services: GithubServices,
  broker: SingleAppGitHubBroker,
  identity: Identity,
  organizationId: string,
  installationId: string,
) {
  const connection = (await services.github.list(identity, { organizationId })).find(item => item.installationId === installationId && item.state === 'active');
  if (!connection) throw new HttpError(404, 'github_connection_missing', 'Conecta una instalación activa para listar sus repositorios.');
  const status = await broker.installationStatus({ organizationId, installationId });
  if (!status.active) {
    await services.github.revoke(identity, organizationId, installationId);
    throw new HttpError(404, 'github_connection_missing', 'La instalación de GitHub ya no está conectada.');
  }
}
