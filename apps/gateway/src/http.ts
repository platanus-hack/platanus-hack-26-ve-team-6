import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { CapabilityError } from '@gotchu/agent';
import { BackendError } from '@gotchu/backend';
import { ZodError } from 'zod';
import { assertTransport, type GatewayTransport } from './config.js';
import type { GatewayOperation } from './contracts.js';
import { GatewayError } from './errors.js';
import type { GatewayService } from './service.js';

export const MAX_GATEWAY_BODY_BYTES = 32_768;
const REQUEST_TIMEOUT_MS = 250_000;

function respond(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

function uniqueHeader(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct[name];
  if (!values) return undefined;
  if (values.length !== 1) throw new GatewayError('invalid_headers', 400);
  return values[0];
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (uniqueHeader(request, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new GatewayError('json_required', 415);
  }
  if (uniqueHeader(request, 'content-encoding')) throw new GatewayError('encoding_not_supported', 415);
  const length = uniqueHeader(request, 'content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_GATEWAY_BODY_BYTES)) throw new GatewayError('body_too_large', 413);
  const chunks: Buffer[] = [];
  let bytes = 0;
  // destroyOnReturn:false lets the caller return a bounded JSON error before closing.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_GATEWAY_BODY_BYTES) throw new GatewayError('body_too_large', 413);
    chunks.push(buffer);
  }
  try {
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    return raw;
  } catch { throw new GatewayError('invalid_json', 400); }
}

function operationFor(method: string | undefined, endpoint: string): GatewayOperation {
  if (method === 'POST' && endpoint === 'input') return 'input';
  if (method === 'POST' && endpoint === 'reads') return 'read';
  if (method === 'GET' && endpoint === 'checkpoint') return 'checkpoint.load';
  if (method === 'PUT' && endpoint === 'checkpoint') return 'checkpoint.save';
  if (method === 'POST' && endpoint === 'model-calls') return 'model';
  throw new GatewayError('route_not_found', 404);
}

export function createGatewayHttpHandler(service: GatewayService, onUnexpectedError: () => void = () => {
  process.stderr.write('Gateway request failed unexpectedly.\n');
}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const timeout = setTimeout(() => {
      respond(response, 408, { error: { code: 'request_timeout' } });
      request.destroy();
    }, REQUEST_TIMEOUT_MS);
    timeout.unref();
    try {
      const authorization = uniqueHeader(request, 'authorization');
      if (request.url === '/internal/v1/model-probes') {
        if (request.method !== 'POST') throw new GatewayError('method_not_allowed', 405);
        if (uniqueHeader(request, 'origin')) throw new GatewayError('origin_not_allowed', 403);
        const probeToken = authorization?.match(/^GatewayProbe ([A-Za-z0-9_.-]+)$/)?.[1];
        if (!probeToken) throw new GatewayError('invalid_probe_capability', 401);
        const output = await service.probe(probeToken, await readBody(request));
        respond(response, 200, output);
        return;
      }
      const token = authorization?.match(/^RunCapability ([A-Za-z0-9_.-]+)$/)?.[1];
      if (!token) throw new GatewayError('invalid_capability', 401);
      await service.authenticate(token);
      // This is a machine-only bearer-capability surface, never a cookie/CORS endpoint.
      if (uniqueHeader(request, 'origin')) throw new GatewayError('origin_not_allowed', 403);
      const match = request.url?.match(/^\/internal\/v1\/agent-runs\/([0-9a-fA-F-]{36})\/(input|reads|checkpoint|model-calls)$/);
      const runId = match?.[1];
      const endpoint = match?.[2];
      if (!runId || !endpoint) throw new GatewayError('route_not_found', 404);
      const operation = operationFor(request.method, endpoint);
      if (operation === 'checkpoint.load' && (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? '0') !== 0)) {
        throw new GatewayError('body_not_allowed', 400);
      }
      const body = operation === 'checkpoint.load' ? undefined : await readBody(request);
      const idempotencyKey = uniqueHeader(request, 'idempotency-key');
      const output = await service.request({ token, runId, operation, body, ...(idempotencyKey ? { idempotencyKey } : {}) });
      respond(response, 200, output);
    } catch (error) {
      let status: number;
      let code: string;
      if (error instanceof GatewayError || error instanceof BackendError) { status = error.status; code = error.code; }
      else if (error instanceof CapabilityError) { status = error.code === 'invalid_capability' ? 401 : 403; code = error.code; }
      else if (error instanceof ZodError) { status = 400; code = 'invalid_input'; }
      else { status = 500; code = 'internal_error'; onUnexpectedError(); }
      // Do not continue buffering rejected bodies, or reuse a partially consumed stream.
      response.setHeader('connection', 'close');
      respond(response, status, { error: { code } });
      response.once('finish', () => { if (!request.complete) request.destroy(); });
    } finally { clearTimeout(timeout); }
  };
}

export async function startGatewayServer(options: {
  service: GatewayService; host: string; port: number; transport: GatewayTransport;
}) {
  assertTransport(options.host, options.transport);
  const handler = createGatewayHttpHandler(options.service);
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    handler(request, response).catch(() => { response.destroy(); });
  };
  const server = options.transport.mode === 'https'
    ? createHttpsServer({ cert: options.transport.certificate, key: options.transport.privateKey, minVersion: 'TLSv1.2', maxHeaderSize: 20_000 }, listener)
    : createHttpServer({ maxHeaderSize: 20_000 }, listener);
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 2_000;
  server.maxRequestsPerSocket = 100;
  server.maxHeadersCount = 30;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Gateway TCP address unavailable');
  }
  let closing: Promise<void> | undefined;
  return {
    server, port: address.port,
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
