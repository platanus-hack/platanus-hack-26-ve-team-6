import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importSPKI, SignJWT } from 'jose';
import { verifyRunCapability } from '@gotchu/agent';
import { describe, expect, it } from 'vitest';
import { MAX_GATEWAY_BODY_BYTES, startGatewayServer } from '../src/http.js';
import type { GatewayService } from '../src/service.js';

const pair = generateKeyPairSync('ed25519');
const publicKey = await importSPKI(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'EdDSA');
const runId = randomUUID();
const token = await new SignJWT({
  sub: runId, runId, organizationId: randomUUID(), applicationId: randomUUID(), jti: randomUUID(),
  iss: 'gotchu-run-capability-issuer', aud: 'gotchu-investigation-worker',
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
  allowedReadTools: ['evidence.read'], evidenceIds: [],
}).setProtectedHeader({ alg: 'EdDSA' }).sign(pair.privateKey);

// Transport-only fixture. Durable authorization is exercised separately against Postgres.
const service: GatewayService = { authenticate: value => verifyRunCapability(value, publicKey), request: async () => ({ ok: true }),
  probe: async () => ({ status: 'succeeded', reason: null, inputTokens: 2, outputTokens: 1 }) };

describe('real Node HTTP/TLS transport boundary (fixture service)', () => {
  it('accepts only the signed-probe route shape and rejects browser origins', async () => {
    const gateway = await startGatewayServer({ service, host: '127.0.0.1', port: 0, transport: { mode: 'loopback-http', nodeEnv: 'test' } });
    try {
      const send = (headers: Record<string, string>) => new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port: gateway.port, path: '/internal/v1/model-probes', method: 'POST', headers: {
          'content-type': 'application/json', ...headers,
        } }, response => {
          let body = '';
          response.setEncoding('utf8'); response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body })); response.on('error', reject);
        });
        request.on('error', reject); request.setTimeout(5_000, () => request.destroy(new Error('probe transport timeout')));
        request.end(JSON.stringify({ organizationId: randomUUID(), requestId: randomUUID() }));
      });
      expect((await send({ authorization: 'GatewayProbe fixture.token' })).status).toBe(200);
      expect((await send({ authorization: 'GatewayProbe fixture.token', origin: 'https://attacker.example' })).status).toBe(403);
      expect((await send({ authorization: 'RunCapability fixture.token' })).status).toBe(401);
    } finally { await gateway.close(); }
  });

  it('bounds streaming chunked bodies without relying on Content-Length', async () => {
    const gateway = await startGatewayServer({ service, host: '127.0.0.1', port: 0, transport: { mode: 'loopback-http', nodeEnv: 'test' } });
    try {
      const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port: gateway.port, path: `/internal/v1/agent-runs/${runId}/input`, method: 'POST', headers: {
          authorization: `RunCapability ${token}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked',
        } }, response => {
          let body = '';
          response.setEncoding('utf8'); response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
          response.on('error', reject);
        });
        request.on('error', reject);
        request.setTimeout(5_000, () => request.destroy(new Error('test request timeout')));
        request.write('x'.repeat(MAX_GATEWAY_BODY_BYTES)); request.end('x');
      });
      expect(result.status).toBe(413);
      expect(result.body).toContain('body_too_large');
    } finally { await gateway.close(); }
  });

  it('serves authenticated HTTPS with certificate validation enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gotchu-gateway-tls-'));
    let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    try {
      const keyPath = join(directory, 'key.pem'); const certificatePath = join(directory, 'cert.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certificatePath], { stdio: 'ignore', timeout: 10_000 });
      const [privateKey, certificate] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certificatePath, 'utf8')]);
      gateway = await startGatewayServer({ service, host: '127.0.0.1', port: 0, transport: { mode: 'https', certificate, privateKey } });
      const port = gateway.port;
      const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = httpsRequest({ hostname: '127.0.0.1', port, ca: certificate, rejectUnauthorized: true,
          path: `/internal/v1/agent-runs/${runId}/checkpoint`, method: 'GET', headers: { authorization: `RunCapability ${token}` },
        }, response => {
          let body = '';
          response.setEncoding('utf8'); response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body })); response.on('error', reject);
        });
        request.on('error', reject); request.setTimeout(5_000, () => request.destroy(new Error('test TLS timeout'))); request.end();
      });
      expect(result.status).toBe(200);
      expect(result.body).toBe('{"ok":true}');
    } finally { await gateway?.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
