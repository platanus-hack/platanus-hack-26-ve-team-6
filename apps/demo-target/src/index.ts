import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { z } from 'zod';
import vulnerableSettings from './fixtures/vulnerable/settings.json' with { type: 'json' };
import correctedSettings from './fixtures/corrected/settings.json' with { type: 'json' };
import { renderCatalog as vulnerableCatalog } from './fixtures/vulnerable/store.js';
import { renderCatalog as correctedCatalog } from './fixtures/corrected/store.js';

export const demoServerOptionsSchema = z.object({
  host: z.string().default('127.0.0.1').refine((host) => {
    if (isIP(host) !== 4) return false;
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b !== undefined && b >= 16 && b <= 31;
  }, 'Bind to a literal loopback or RFC1918 IPv4 address'),
  port: z.number().int().min(0).max(65_535).default(4100),
}).strict();

const settingsSchema = z.object({ responseHeaders: z.record(z.string(), z.string()) }).strict();
const routes = new Map([
  ['/vulnerable', { settings: settingsSchema.parse(vulnerableSettings), render: vulnerableCatalog }],
  ['/corrected', { settings: settingsSchema.parse(correctedSettings), render: correctedCatalog }],
]);

export async function startDemoTargetServer(options: z.input<typeof demoServerOptionsSchema> = {}) {
  const { host, port } = demoServerOptionsSchema.parse(options);
  const server = createServer({ requestTimeout: 2_000, headersTimeout: 2_000, maxHeaderSize: 8_192 }, (request, response) => {
    // Exact raw path matching intentionally rejects queries, source paths and encoded aliases.
    const route = request.url === undefined ? undefined : routes.get(request.url);
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', connection: 'close' }).end();
      return;
    }
    if (!route) {
      response.writeHead(404, { connection: 'close' }).end();
      return;
    }
    const body = route.render();
    response.writeHead(200, {
      ...route.settings.responseHeaders,
      // Operator/edge fixture only; this isn't an installed third-party product claim.
      'x-powered-by': 'PaperMoon-Edge/1.0 (fictional)',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      connection: 'close',
    }).end(body);
  });
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 1;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Demo target did not acquire a TCP listener');
  }
  return {
    origin: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

export { startTriageEvaluationTarget, type EvaluationFault, type EvaluationTargetOptions } from './triage-evaluation-target.js';
