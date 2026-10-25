import {
  singleGitHubBrokerRequestSchema,
  singleGitHubBrokerResponseSchema,
} from '@gotchu/contracts';
import type { z } from 'zod';
import { HttpError, readBoundedBody } from './http.js';

type BrokerRequest = z.infer<typeof singleGitHubBrokerRequestSchema>;
type BrokerResponse = z.infer<typeof singleGitHubBrokerResponseSchema>;
type AuthorizeResponse = Extract<BrokerResponse, { operation: 'authorize' }>;
type InstallationStatusResponse = Extract<BrokerResponse, { operation: 'installationStatus' }>;
type ListRepositoriesResponse = Extract<BrokerResponse, { operation: 'listRepositories' }>;
type ReadRepositoryResponse = Extract<BrokerResponse, { operation: 'readRepository' }>;

const responseLimit = 4_194_304 + 128_000;
const responseTimeoutMs = 30_000;

function isLoopback(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function brokerEndpoint(value: string) {
  let base: URL;
  try { base = new URL(value); } catch { throw new Error('executor_internal_url_invalid'); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLoopback(base.hostname)))) {
    throw new Error('executor_internal_url_invalid');
  }
  return new URL('/internal/v1/github', base);
}

function brokerUnavailable() {
  return new HttpError(503, 'github_broker_unavailable', 'La conexión con GitHub no está disponible. Vuelve a intentarlo.');
}

export interface SingleAppGitHubBroker {
  authorize(input: { actorId: string; state: string; code: string }): Promise<AuthorizeResponse>;
  installationStatus(input: { organizationId: string; installationId: string }): Promise<InstallationStatusResponse>;
  listRepositories(input: { organizationId: string; applicationId: string; installationId: string }): Promise<ListRepositoriesResponse>;
  readRepository(input: {
    organizationId: string;
    applicationId: string;
    repositoryLinkId: string;
    read: 'snapshot' | 'head' | 'tree' | 'automation';
    commitSha?: string;
  }): Promise<ReadRepositoryResponse>;
}

export function createSingleAppGitHubBroker(options: {
  internalUrl: string;
  bearerToken: string;
  fetchImplementation?: typeof fetch;
}): SingleAppGitHubBroker {
  if (!/^[a-f0-9]{64}$/.test(options.bearerToken)) throw new Error('executor_internal_authentication_invalid');
  const endpoint = brokerEndpoint(options.internalUrl);
  const fetcher = options.fetchImplementation ?? fetch;

  async function send(input: BrokerRequest): Promise<BrokerResponse> {
    const request = singleGitHubBrokerRequestSchema.safeParse(input);
    if (!request.success) throw new HttpError(400, 'github_broker_request_invalid', 'No se pudo preparar la solicitud de GitHub.');

    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(responseTimeoutMs),
        headers: {
          authorization: `Bearer ${options.bearerToken}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request.data),
      });
    } catch {
      throw brokerUnavailable();
    }

    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403, 404].includes(response.status)) {
        throw new HttpError(503, 'github_connection_unavailable', 'La instalación de GitHub ya no está disponible. Conéctala de nuevo.');
      }
      throw brokerUnavailable();
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel();
      throw new HttpError(502, 'github_broker_response_invalid', 'El servicio de GitHub devolvió una respuesta inesperada.');
    }

    let raw: unknown;
    try {
      const body = await readBoundedBody(response, responseLimit, responseTimeoutMs);
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      throw new HttpError(502, 'github_broker_response_invalid', 'El servicio de GitHub devolvió una respuesta inesperada.');
    }
    const result = singleGitHubBrokerResponseSchema.safeParse(raw);
    if (!result.success || result.data.operation !== request.data.operation) {
      throw new HttpError(502, 'github_broker_response_invalid', 'El servicio de GitHub devolvió una respuesta inesperada.');
    }
    return result.data;
  }

  return {
    async authorize(input) {
      const result = await send({ operation: 'authorize', ...input });
      if (result.operation !== 'authorize') throw brokerUnavailable();
      return result;
    },
    async installationStatus(input) {
      const result = await send({ operation: 'installationStatus', ...input });
      if (result.operation !== 'installationStatus') throw brokerUnavailable();
      return result;
    },
    async listRepositories(input) {
      const result = await send({ operation: 'listRepositories', ...input });
      if (result.operation !== 'listRepositories') throw brokerUnavailable();
      return result;
    },
    async readRepository(input) {
      const result = await send({ operation: 'readRepository', ...input });
      if (result.operation !== 'readRepository') throw brokerUnavailable();
      return result;
    },
  };
}
