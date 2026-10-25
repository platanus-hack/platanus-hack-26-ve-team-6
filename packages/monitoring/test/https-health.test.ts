import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import type { RequestListener } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthorizedHttpsHealthAdapter } from '../src/https-health.js';

let directory: string;
let cert: string;
let key: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gotchu-monitor-tls-fixture-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(directory, 'key.pem'),
    '-out', join(directory, 'cert.pem'),
    '-days', '1',
    '-subj', '/CN=customer.org',
    '-addext', 'subjectAltName=DNS:customer.org',
  ], { stdio: 'ignore', timeout: 10_000 });
  cert = await readFile(join(directory, 'cert.pem'), 'utf8');
  key = await readFile(join(directory, 'key.pem'), 'utf8');
});
afterAll(async () => rm(directory, { recursive: true, force: true }));

async function tlsFixture(handler: RequestListener) {
  const server = createServer({ cert, key }, handler);
  let connections = 0;
  server.on('connection', () => { connections += 1; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture_address_unavailable');
  return {
    port: address.port,
    connections: () => connections,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

describe('authorized HTTPS health read', () => {
  it('reuses the public target HTTPS engine and retains only bounded response metadata', async () => {
    const seen: Array<{ method: string; url: string; authorization: string | undefined; cookie: string | undefined }> = [];
    const fixture = await tlsFixture((request, response) => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      });
      response.writeHead(503, { server: 'fixture-status' }).end('private response body');
    });
    try {
      const adapter = createAuthorizedHttpsHealthAdapter({
        now: () => new Date(),
        https: {
          lookup: async () => [{ address: '127.0.0.1', family: 4 }],
          testFixture: { hostname: 'customer.org', port: fixture.port, ca: cert },
        },
      });
      const observation = await adapter.read({
        id: randomUUID(),
        origin: 'https://customer.org',
        version: 3,
        authorizedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, AbortSignal.timeout(2000));
      expect(seen).toEqual([{ method: 'GET', url: '/', authorization: undefined, cookie: undefined }]);
      expect(observation.tlsVerified).toBe(true);
      expect(observation.status).toBe(503);
      expect(observation.candidate?.kind).toBe('public_surface');
      expect(observation.candidate?.severity).toBe('high');
      expect(observation.evidence.source).toBe('assessment');
      expect(JSON.stringify(observation)).not.toContain('private response body');
    } finally {
      await fixture.close();
    }
  });

  it('rejects expired target authority before opening a socket', async () => {
    const fixture = await tlsFixture((_, response) => response.end('unexpected request'));
    try {
      const adapter = createAuthorizedHttpsHealthAdapter({
        https: {
          lookup: async () => [{ address: '127.0.0.1', family: 4 }],
          testFixture: { hostname: 'customer.org', port: fixture.port, ca: cert },
        },
      });
      await expect(adapter.read({
        id: randomUUID(),
        origin: 'https://customer.org',
        version: 1,
        authorizedAt: new Date(Date.now() - 10_000).toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }, AbortSignal.timeout(1000))).rejects.toThrow('authorized_target_expired');
      expect(fixture.connections()).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('records a current successful public response as a coverage check', async () => {
    const fixture = await tlsFixture((_, response) => response.writeHead(204).end());
    const now = new Date();
    try {
      const adapter = createAuthorizedHttpsHealthAdapter({
        now: () => now,
        https: {
          lookup: async () => [{ address: '127.0.0.1', family: 4 }],
          testFixture: { hostname: 'customer.org', port: fixture.port, ca: cert },
        },
      });
      const observation = await adapter.read({
        id: randomUUID(),
        origin: 'https://customer.org',
        version: 3,
        authorizedAt: new Date(now.getTime() - 1000).toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }, AbortSignal.timeout(2000));
      expect(observation.status).toBe(204);
      expect(observation.candidate?.kind).toBe('coverage_check');
      expect(observation.candidate?.summary).toContain('not overall application health');
    } finally {
      await fixture.close();
    }
  });

  it('probes only the fixed public-surface paths when that consent profile is active',async()=>{
    const seen:string[]=[];const fixture=await tlsFixture((request,response)=>{seen.push(request.url??'');response.writeHead(204).end();});
    const target={id:randomUUID(),origin:'https://customer.org',version:1,authorizedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),scanProfile:'public_surface' as const};
    try {
      const adapter=createAuthorizedHttpsHealthAdapter({https:{lookup:async()=>[{address:'127.0.0.1',family:4}],testFixture:{hostname:'customer.org',port:fixture.port,ca:cert}}});
      const result=await adapter.read(target,AbortSignal.timeout(2000),'/robots.txt');
      expect(result.route).toBe('/robots.txt');expect(result.evidence.reference).toBe('https://customer.org/robots.txt');expect(seen).toEqual(['/robots.txt']);
      await expect(adapter.read({...target,scanProfile:'root'},AbortSignal.timeout(1000),'/robots.txt')).rejects.toThrow('health_route_not_consented');
      expect(seen).toEqual(['/robots.txt']);
    } finally { await fixture.close(); }
  });
});
