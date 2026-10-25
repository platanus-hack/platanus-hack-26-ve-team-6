import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiCheckEvidenceSchema } from '@gotchu/contracts';
import { assertReportBinding, createCustomerAssessmentRunner } from '../src/index.js';
import { inspectApiSchema } from '../src/api-schema.js';
import { API_PROBE_ORIGIN } from '../src/https.js';
import { input, absentScanners } from './fixtures.js';

let directory: string; let cert: string; let key: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gotchu-api-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=customer.org', '-addext', 'subjectAltName=DNS:customer.org'], { stdio: 'ignore' });
  cert = await readFile(join(directory, 'cert.pem'), 'utf8'); key = await readFile(join(directory, 'key.pem'), 'utf8');
});
afterAll(async () => rm(directory, { recursive: true, force: true }));

describe('inert OpenAPI inventory', () => {
  const document = { openapi: '3.1.0', security: [{ bearer: [] }], paths: { '/api/account': { get: {} } } };
  it('handles operation security overrides without reading descriptions, refs or examples', () => {
    const result = inspectApiSchema(JSON.stringify({ ...document, paths: {
      ...document.paths, '/api/public': { get: { security: [] } }, '/api/optional': { get: { security: [{}] } },
      '/api/{id}': { get: {} }, '/api/ref': { $ref: 'https://169.254.169.254/private' },
      '/api/foreign': { get: { servers: [{ url: 'https://other.org' }] } },
    } }), 'https://customer.org');
    expect(result?.operations).toEqual([
      { path: '/api/account', method: 'GET', authentication: 'declared', probeEligible: true },
      { path: '/api/public', method: 'GET', authentication: 'not_declared', probeEligible: true },
      { path: '/api/optional', method: 'GET', authentication: 'not_declared', probeEligible: true },
      { path: '/api/foreign', method: 'GET', authentication: 'declared', probeEligible: false },
    ]);
    expect(result?.truncated).toBe(true);
  });
  it('does not guess alternate base paths, parameter values, or treat HTML as an API', () => {
    expect(inspectApiSchema('<html>SPA fallback</html>', 'https://customer.org')).toBeNull();
    expect(inspectApiSchema(JSON.stringify({ paths: {} }), 'https://customer.org')).toBeNull();
    for (const change of [{ servers: [{ url: '/api/v1' }] }, { servers: [{ url: 'https://other.org' }] }]) {
      expect(inspectApiSchema(JSON.stringify({ ...document, ...change }), 'https://customer.org')?.operations[0]?.probeEligible).toBe(false);
    }
    expect(inspectApiSchema(JSON.stringify({ ...document, paths: { '/api/account': { get: { parameters: [] } } } }), 'https://customer.org')?.operations[0]?.probeEligible).toBe(false);
  });
  it('bounds operation metadata and never retains arbitrary descriptions', () => {
    const result = inspectApiSchema(JSON.stringify({ ...document, paths: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`/route${i}`, { get: { description: 'PRIVATE_DESCRIPTION' } }])) }), 'https://customer.org');
    expect(result?.operations).toHaveLength(8); expect(result?.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_DESCRIPTION');
  });
});

it.each([false, true])('executes real bounded API scenarios through LangGraph (corrected=%s)', async corrected => {
  const seen: Array<{ method: string | undefined; path: string | undefined }> = [];
  const server = createServer({ cert, key }, (req, res) => {
    seen.push({ method: req.method, path: req.url });
    expect(req.headers.cookie).toBeUndefined(); expect(req.headers.authorization).toBeUndefined();
    expect(['GET', 'HEAD', 'OPTIONS']).toContain(req.method);
    const cors = corrected ? { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' }
      : { 'access-control-allow-origin': API_PROBE_ORIGIN, 'access-control-allow-credentials': 'true' };
    if (req.method === 'OPTIONS') return res.writeHead(204, { ...cors, allow: 'GET, HEAD, OPTIONS', 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'authorization', 'set-cookie': 'PRIVATE_COOKIE' }).end();
    if (req.method === 'HEAD') return res.writeHead(req.url === '/api/account' ? 401 : 200, cors).end();
    if (req.url === '/openapi.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      openapi: '3.0.3', security: [{ bearer: [] }], paths: { '/api/account': { get: { description: 'PRIVATE_SCHEMA_TEXT' } } },
    }));
    res.writeHead(404, { 'content-type': 'text/plain', server: 'PRIVATE_BANNER' }).end(corrected ? 'not found' : 'Error: PRIVATE_ERROR_TEXT\n    at handler (/private/server.ts:10:22)');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_address');
    const lookup = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const request = input(); request.mode = 'external'; request.source = null;
    request.target = { id: request.jobId, origin: 'https://customer.org', version: 1, authorizedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(), scanProfile: 'api_checks' };
    const report = await createCustomerAssessmentRunner({ scanners: absentScanners, https: { lookup, testFixture: { hostname: 'customer.org', port: address.port, ca: cert } } }).run(request);
    expect(seen).toHaveLength(8); expect(lookup).toHaveBeenCalledTimes(8);
    expect(seen).toContainEqual({ method: 'OPTIONS', path: '/api/account' });
    expect(seen).toContainEqual({ method: 'HEAD', path: '/api/account' });
    expect(seen).not.toContainEqual({ method: 'GET', path: '/api/account' });
    const observations = report.external?.evidence.map(item => {
      expect(item.checksum).toBe(createHash('sha256').update(item.excerpt).digest('hex'));
      return apiCheckEvidenceSchema.parse(JSON.parse(item.excerpt));
    });
    expect(observations?.find(item => item.path === '/openapi.json')?.signals.operations?.[0]?.authentication).toBe('declared');
    expect(report.external?.findings.map(item => item.ruleId).sort()).toEqual(corrected ? [] : ['api.credentialed-probe-origin', 'api.error-detail']);
    expect(report.external?.findings.every(item => item.exploitability === 'unknown')).toBe(true);
    expect(report.external?.coverage.find(item => item.capability === 'api_auth_boundary')?.state).toBe('inspected');
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_(?:COOKIE|SCHEMA_TEXT|ERROR_TEXT|BANNER)/);
    expect(report.external?.snapshotRef.endsWith(':api_checks')).toBe(true);
    assertReportBinding(request, report);
    const target = request.target;
    expect(() => assertReportBinding({ ...request, target: { ...target, scanProfile: 'root' } }, report)).toThrow('report_subject_mismatch');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 15_000);

it('expires before any socket/DNS work and records checks as unavailable', async () => {
  const lookup = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
  const request = input(); request.mode = 'external'; request.source = null;
  request.target = { id: request.jobId, origin: 'https://customer.org', version: 1, authorizedAt: new Date(Date.now() - 3000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(), scanProfile: 'api_checks' };
  const report = await createCustomerAssessmentRunner({ scanners: absentScanners, https: { lookup } }).run(request);
  expect(lookup).not.toHaveBeenCalled();
  expect(report.external?.status).toBe('partial');
  expect(report.external?.coverage.some(item => item.state === 'inspected')).toBe(false);
  expect(report.external?.findings).toEqual([]);
});

it('reserves protocol attempts, bounds hostile responses and refuses incomplete CORS/schema conclusions', async () => {
  let requests = 0;
  const server = createServer({ cert, key }, (_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': API_PROBE_ORIGIN,
      'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'authorization' }).end('PRIVATE_RESPONSE_BODY'.repeat(2000));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_address');
    const request = input(); request.mode = 'external'; request.source = null;
    request.target = { id: request.jobId, origin: 'https://customer.org', version: 1, authorizedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(), scanProfile: 'api_checks' };
    const report = await createCustomerAssessmentRunner({ scanners: absentScanners, https: {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }], testFixture: { hostname: 'customer.org', port: address.port, ca: cert },
    } }).run(request);
    const observations = report.external?.evidence.map(item => apiCheckEvidenceSchema.parse(JSON.parse(item.excerpt))) ?? [];
    expect(requests).toBe(8);
    expect(observations.reduce((total, item) => total + item.bodyBytes, 0)).toBe(98_304);
    expect(observations.slice(0, 4).map(item => item.scenarioId)).toEqual(['cors_preflight', 'cors_preflight', 'method_policy', 'error_handling']);
    expect(observations.some(item => item.incomplete === 'response_byte_cap')).toBe(true);
    expect(report.external?.coverage.find(item => item.capability === 'api_schema_discovery')?.state).toBe('unavailable');
    expect(report.external?.findings).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_RESPONSE_BODY');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 15_000);
