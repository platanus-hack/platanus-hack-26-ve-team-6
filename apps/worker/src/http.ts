import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WorkerConfigError, type WorkerConfig } from './config.js';
import { WorkerServiceError, type InvestigationWorkerService } from './worker.js';

interface WorkerHttpOptions {
  readonly config: WorkerConfig;
  readonly service: InvestigationWorkerService;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function capabilityFromRequest(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^RunCapability ([A-Za-z0-9._-]{1,8192})$/.exec(header);
  return match?.[1];
}

function requestHasNoBody(request: IncomingMessage): boolean {
  const length = request.headers['content-length'];
  const transferEncoding = request.headers['transfer-encoding'];
  request.resume();
  return (length === undefined || length === '0') && transferEncoding === undefined;
}

function handleError(response: ServerResponse, error: unknown): void {
  if (error instanceof WorkerServiceError) {
    sendJson(response, error.status, { error: { code: error.code } });
    return;
  }
  if (error instanceof WorkerConfigError) {
    sendJson(response, 503, { error: { code: 'worker_not_ready' } });
    return;
  }
  sendJson(response, 503, { error: { code: 'investigation_unavailable' } });
}

export function createWorkerHttpServer({ config, service }: WorkerHttpOptions): Server {
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health/live') {
      sendJson(response, 200, { status: 'alive' });
      return;
    }
    if (request.method === 'GET' && request.url === '/health/ready') {
      if (!config.gatewayBaseUrl || !service.ready) {
        sendJson(response, 503, { status: 'not_ready', reason: 'gateway_unconfigured' });
        return;
      }
      sendJson(response, 200, { status: 'ready' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/investigations') {
      sendJson(response, 404, { error: { code: 'not_found' } });
      return;
    }
    if (!requestHasNoBody(request)) {
      sendJson(response, 400, { error: { code: 'request_body_not_allowed' } });
      return;
    }
    const capability = capabilityFromRequest(request);
    if (!capability) {
      sendJson(response, 401, { error: { code: 'invalid_capability' } });
      return;
    }
    void service.investigate(capability).then(
      (result) => sendJson(response, 200, { result }),
      (error: unknown) => handleError(response, error),
    );
  });
}

export async function listenWorkerServer(server: Server, config: WorkerConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(config.port, config.host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}
