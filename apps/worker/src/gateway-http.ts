import {
  CapabilityError,
  GatewayUnavailableError,
  type ModelCallRequest,
  type ModelGateway,
  type ReadToolGateway,
  type ReadToolRequest,
  type RunScopedPersistenceGateway,
  type RunScope,
  type SafeInvestigationCheckpoint,
} from '@gotchu/agent';
import { z } from 'zod';

const MAX_RESPONSE_BYTES = 40 * 1024;
const jsonContentType = 'application/json';

interface RequestOptions {
  readonly gateway: 'read' | 'model' | 'checkpoint';
  readonly capability: string;
  readonly path: string;
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly body?: unknown;
  readonly signal: AbortSignal;
  readonly idempotencyKey?: string;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error('response_not_successful');
  if (response.status === 204) return undefined;
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== jsonContentType) throw new Error('unexpected_response_content_type');
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
  if (!response.body) throw new Error('response_body_missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('response_too_large');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(combined);
  const payload: unknown = JSON.parse(decoded);
  return payload;
}

function urlFor(baseUrl: URL, path: string): URL {
  return new URL(path, baseUrl);
}

export function createGatewayHttpAdapters(baseUrl: URL, fetchImpl: typeof fetch = fetch) {
  const checkpointVersions = new Map<string, number>();

  async function requestJson(options: RequestOptions): Promise<unknown> {
    const headers = new Headers({
      authorization: `RunCapability ${options.capability}`,
      accept: jsonContentType,
    });
    if (options.body !== undefined) headers.set('content-type', jsonContentType);
    if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
    let response: Response;
    try {
      response = await fetchImpl(urlFor(baseUrl, options.path), {
        method: options.method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: options.signal,
        redirect: 'error',
      });
    } catch {
      throw new GatewayUnavailableError(options.gateway);
    }
    if (response.status === 401) throw new CapabilityError('invalid_capability');
    if (response.status === 403) throw new CapabilityError('capability_scope_mismatch');
    if (response.status === 404 && options.gateway === 'read') return {};
    if (!response.ok) throw new GatewayUnavailableError(options.gateway);
    try {
      return await readBoundedJson(response);
    } catch {
      throw new GatewayUnavailableError(options.gateway);
    }
  }

  const inputGateway = {
    async loadInput(scope: RunScope, capability: string) {
      const payload = await requestJson({
        gateway: 'read',
        capability,
        path: `/internal/v1/agent-runs/${scope.runId}/input`,
        method: 'POST',
        body: { organizationId: scope.organizationId, applicationId: scope.applicationId },
        signal: AbortSignal.timeout(10_000),
      });
      return payload;
    },
  };

  const readTools: ReadToolGateway = {
    read(request: ReadToolRequest): Promise<unknown> {
      return requestJson({
        gateway: 'read',
        capability: request.capability,
        path: `/internal/v1/agent-runs/${request.scope.runId}/reads`,
        method: 'POST',
        body: {
          organizationId: request.scope.organizationId,
          applicationId: request.scope.applicationId,
          callId: request.callId,
          callType: request.callType,
          name: request.name,
          evidenceId: request.evidenceId,
        },
        idempotencyKey: request.callId,
        signal: request.signal,
      });
    },
  };

  const model: ModelGateway = {
    invoke(request: ModelCallRequest): Promise<unknown> {
      return requestJson({
        gateway: 'model',
        capability: request.capability,
        path: `/internal/v1/agent-runs/${request.scope.runId}/model-calls`,
        method: 'POST',
        body: {
          organizationId: request.scope.organizationId,
          applicationId: request.scope.applicationId,
          reservationId: request.callId,
          systemInstruction: request.systemInstruction,
          userContext: request.userContext,
          maxOutputTokens: request.maxOutputTokens,
          remainingTokens: request.remainingTokens,
          remainingSpendMicroUsd: request.remainingSpendMicroUsd,
        },
        idempotencyKey: request.callId,
        signal: request.signal,
      });
    },
  };

  const persistence: RunScopedPersistenceGateway = {
    async loadCheckpoint(scope, capability, signal): Promise<unknown | undefined> {
      const payload = await requestJson({
        gateway: 'checkpoint',
        capability,
        path: `/internal/v1/agent-runs/${scope.runId}/checkpoint`,
        method: 'GET',
        signal,
      });
      const response = z.object({ version: z.number().int().nonnegative(), checkpoint: z.unknown().nullable() }).strict().parse(payload);
      checkpointVersions.set(scope.runId, response.version);
      return response.checkpoint ?? undefined;
    },
    async saveCheckpoint(scope, capability, checkpoint: SafeInvestigationCheckpoint, signal): Promise<void> {
      const expectedVersion = checkpointVersions.get(scope.runId) ?? 0;
      const payload = await requestJson({
        gateway: 'checkpoint',
        capability,
        path: `/internal/v1/agent-runs/${scope.runId}/checkpoint`,
        method: 'PUT',
        body: {
          organizationId: scope.organizationId,
          expectedVersion,
          checkpoint,
        },
        signal,
      });
      const response = z.object({ version: z.number().int().positive() }).strict().parse(payload);
      checkpointVersions.set(scope.runId, response.version);
    },
  };

  return { inputGateway, readTools, model, persistence };
}
