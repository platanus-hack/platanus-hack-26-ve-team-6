import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import type { RequestListener } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCustomerAssessmentRunner } from '../src/index.js';
import { absentScanners, input } from './fixtures.js';

let directory: string;
let cert: string;
let key: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gotchu-response-findings-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=customer.org', '-addext', 'subjectAltName=DNS:customer.org'], { stdio: 'ignore' });
  cert = await readFile(join(directory, 'cert.pem'), 'utf8');
  key = await readFile(join(directory, 'key.pem'), 'utf8');
});

afterAll(async () => rm(directory, { recursive: true, force: true }));

async function fixture(handler: RequestListener) {
  const server = createServer({ cert, key }, handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_fixture_address');
  return {
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function externalInput(scanProfile: 'root' | 'public_surface' = 'public_surface') {
  const request = input();
  request.mode = 'external';
  request.source = null;
  request.target = {
    id: request.jobId,
    origin: 'https://customer.org',
    version: 1,
    authorizedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scanProfile,
  };
  return request;
}

function assessmentOptions(port: number) {
  return {
    scanners: absentScanners,
    https: {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      testFixture: { hostname: 'customer.org', port, ca: cert },
    },
  };
}

describe('external HTTP response findings', () => {
  it('reports path-bound header and banner observations without source access', async () => {
    const target = await fixture((request, response) => response.writeHead(200, {
      'content-type': request.url === '/' ? 'text/html' : 'text/plain',
      server: 'Fixture/9.8',
      'x-powered-by': 'Fixture framework',
      'set-cookie': 'session=secret-cookie-value',
    }).end('private response body marker'));
    try {
      const report = await createCustomerAssessmentRunner(assessmentOptions(target.port)).run(externalInput());
      const analysis = report.external;
      expect(report.mode).toBe('external');
      expect(report.internal).toBeNull();
      expect(analysis?.status).toBe('completed');
      expect(analysis?.coverage.find(item => item.capability === 'public_surface_response_headers')?.state).toBe('inspected');

      const paths = ['/', '/.well-known/security.txt', '/security.txt', '/robots.txt', '/sitemap.xml'];
      for (const path of paths) {
        const location = `https://customer.org${path}`;
        const findings = analysis?.findings.filter(item => item.location === location) ?? [];
        expect(findings.map(item => item.ruleId).sort()).toEqual([
          'https.missing-content-security-policy',
          'https.missing-strict-transport-security',
          'https.missing-x-content-type-options',
          'https.technology-banner',
        ]);
        const responseEvidence = analysis?.evidence.find(item => item.locator === location);
        expect(responseEvidence).toBeDefined();
        expect(responseEvidence?.excerpt).toContain(`"path":"${path}"`);
        expect(findings.every(item => item.evidenceIds.includes(responseEvidence?.id ?? ''))).toBe(true);
      }
      const bannerFinding = analysis?.findings.find(item => item.ruleId === 'https.technology-banner');
      expect(bannerFinding).toMatchObject({
        severity: 'informational', confidence: 'inferred', exploitability: 'unknown',
      });
      expect(bannerFinding?.description).toContain('unverified');
      expect(bannerFinding?.limitations).toContain('Do not treat a banner as inventory, a package advisory match, or proof of exploitation.');
      expect(JSON.stringify(report)).not.toContain('private response body marker');
      expect(JSON.stringify(report)).not.toContain('secret-cookie-value');
      expect(JSON.stringify(report)).not.toContain('application version');
    } finally {
      await target.close();
    }
  });

  it('does not report the target observations when all checked responses follow the corrected policy', async () => {
    const target = await fixture((_, response) => response.writeHead(200, {
      'content-security-policy': "default-src 'self'",
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-content-type-options': 'nosniff',
    }).end('ok'));
    try {
      const report = await createCustomerAssessmentRunner(assessmentOptions(target.port)).run(externalInput());
      expect(report.external?.findings).toEqual([]);
      expect(report.external?.coverage.find(item => item.capability === 'public_surface_response_headers')?.state).toBe('inspected');
    } finally {
      await target.close();
    }
  });

  it('keeps incomplete, redirected, and failed response header coverage unknown', async () => {
    const target = await fixture((request, response) => {
      if (request.url === '/') {
        response.writeHead(302, { location: '/elsewhere', server: 'Unverified/1.0' }).end('redirect body');
      } else if (request.url === '/.well-known/security.txt') {
        response.writeHead(200, { server: 'Unverified/1.0' }).end('x'.repeat(20_000));
      } else if (request.url === '/security.txt') {
        request.socket.destroy();
      } else {
        response.writeHead(200, { server: 'Unverified/1.0' }).end('ok');
      }
    });
    try {
      const report = await createCustomerAssessmentRunner(assessmentOptions(target.port)).run(externalInput());
      const analysis = report.external;
      expect(analysis?.status).toBe('partial');
      expect(analysis?.coverage.find(item => item.capability === 'public_surface_response_headers')).toMatchObject({ state: 'unavailable' });
      expect(analysis?.coverage.find(item => item.capability === 'public_surface_response_headers')?.detail).toContain('3 attempted or queued responses have unknown header coverage');
      expect(analysis?.findings.some(item => item.location === 'https://customer.org/')).toBe(false);
      expect(analysis?.findings.some(item => item.location === 'https://customer.org/.well-known/security.txt')).toBe(false);
      expect(analysis?.findings.some(item => item.location === 'https://customer.org/security.txt')).toBe(false);
      expect(analysis?.evidence.find(item => item.locator === 'https://customer.org/')?.excerpt).toContain('redirect_refused');
      expect(analysis?.evidence.find(item => item.locator === 'https://customer.org/.well-known/security.txt')?.excerpt).toContain('body_limit');
    } finally {
      await target.close();
    }
  });

  it('keeps root findings unknown when the root response is redirected', async () => {
    const target = await fixture((_, response) => response.writeHead(302, {
      location: '/elsewhere',
      server: 'Unverified/1.0',
    }).end('redirect body'));
    try {
      const report = await createCustomerAssessmentRunner(assessmentOptions(target.port)).run(externalInput('root'));
      expect(report.external?.status).toBe('partial');
      expect(report.external?.findings).toEqual([]);
      expect(report.external?.coverage.find(item => item.capability === 'root_headers')).toMatchObject({ state: 'unavailable' });
      expect(report.external?.evidence[0]?.excerpt).toContain('redirect_refused');
    } finally {
      await target.close();
    }
  });
});
