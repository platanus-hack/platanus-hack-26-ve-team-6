import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDemoTargetServer } from '@gotchu/demo-target';
import { assessmentReportSchema, type AssessmentRunInput, type DemoRevision } from '@gotchu/contracts';
import { createControlledAssessmentRunner, controlledTargetKey, controlledTransportOptionsSchema, type ControlledRepositoryPort, type ControlledSourceFile } from '../src/index.js';
import { createBundledRepository, readBoundedFile } from '../src/repository.js';
import { matchesCapturedLodashRange } from '../src/advisory.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });

function input(mode: AssessmentRunInput['mode'] = 'both', revision: DemoRevision = 'vulnerable'): AssessmentRunInput {
  return { organizationId: 'd3e00000-0000-4000-8000-000000000001', applicationId: 'd3e00000-0000-4000-8000-000000000002', jobId: randomUUID(), targetKey: controlledTargetKey, mode, revision };
}

async function demo() {
  const target = await startDemoTargetServer({ port: 0 });
  cleanups.push(target.close);
  return target;
}

async function httpFixture(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  return { origin: `http://127.0.0.1:${address.port}` };
}

function fixture(revision: DemoRevision, path: ControlledSourceFile) {
  return readFile(new URL(`../../../apps/demo-target/src/fixtures/${revision}/${path}`, import.meta.url));
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

describe('independent real source and HTTP assessment', () => {
  it('preserves durable scope, produces real evidence and correlates every finding exactly once', async () => {
    const target = await demo();
    const run = input();
    const report = await createControlledAssessmentRunner({ origin: target.origin }).run(run);
    expect(assessmentReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({ organizationId: run.organizationId, applicationId: run.applicationId, jobId: run.jobId, responseMode: 'observation', actionsPerformed: [] });
    expect(report.internal?.status).toBe('completed');
    expect(report.external?.status).toBe('completed');
    expect(report.internal?.findings).toHaveLength(3);
    expect(report.external?.findings).toHaveLength(2);
    expect(report.comparison.map((row) => [row.key, row.classification])).toEqual([
      ['source:audit-email', 'internal_only'], ['http:content-security-policy', 'both'],
      ['dependency:lodash:GHSA-35jh-r3h4-6jhm', 'internal_only'], ['http:technology-banner', 'external_only'],
    ]);
    const allFindings = [...report.internal?.findings ?? [], ...report.external?.findings ?? []];
    expect(report.comparison.flatMap((row) => [...row.internalFindingIds, ...row.externalFindingIds]).sort()).toEqual(allFindings.map((finding) => finding.id).sort());
    expect(allFindings.every((finding) => finding.exploitability === 'not_demonstrated')).toBe(true);
    for (const analysis of [report.internal, report.external]) {
      for (const evidence of analysis?.evidence ?? []) {
        let bytes: Uint8Array | string = evidence.excerpt;
        if (evidence.locator.endsWith('GHSA-35jh-r3h4-6jhm.json')) bytes = await readFile(new URL('../advisories/GHSA-35jh-r3h4-6jhm.json', import.meta.url));
        expect(evidence.checksum).toBe(sha256(bytes));
        expect(evidence.snapshotRef).toBe(`sha256:${evidence.checksum}`);
        expect(evidence.locator).not.toContain('undefined');
      }
    }
    const capture = report.external?.evidence[0]?.excerpt;
    expect(capture).toBeDefined();
    expect(capture).toContain('bodyComplete":true');
    expect(report.internal?.findings.find((finding) => finding.ruleId.includes('GHSA'))?.description).toContain('2026-10-24T06:09:02Z');
  });

  it('actually rescans the corrected revision and reports improvement within the same narrow coverage', async () => {
    const target = await demo();
    const runner = createControlledAssessmentRunner({ origin: target.origin });
    const [vulnerable, corrected] = await Promise.all([runner.run(input()), runner.run(input('both', 'corrected'))]);
    expect(corrected.internal?.status).toBe('completed');
    expect(corrected.external?.status).toBe('completed');
    expect(corrected.internal?.findings).toHaveLength(0);
    expect(corrected.external?.findings.map((finding) => finding.ruleId)).toEqual(['controlled.technology-banner']);
    expect(corrected.internal?.snapshotRef).not.toBe(vulnerable.internal?.snapshotRef);
    expect(corrected.external?.evidence[0]?.checksum).not.toBe(vulnerable.external?.evidence[0]?.checksum);
    expect(corrected.limitations.join(' ')).toContain('not a comprehensive audit');
    expect(corrected.internal?.coverage.some((item) => item.state === 'unsupported')).toBe(true);
  });

  it('external mode succeeds with a repository port that fails on every access', async () => {
    const target = await demo();
    const read = vi.fn(() => Promise.reject(new Error('Repository must not be touched')));
    const report = await createControlledAssessmentRunner({ origin: target.origin, repository: { readFile: read } }).run(input('external'));
    expect(read).not.toHaveBeenCalled();
    expect(report.internal).toBeNull();
    expect(report.external?.status).toBe('completed');
    expect(report.external?.evidence.every((item) => item.kind === 'http_response')).toBe(true);
    expect(report.comparison.every((row) => row.classification === 'unverified')).toBe(true);
  });

  it('internal mode never makes an HTTP request', async () => {
    const handler = vi.fn<RequestListener>((_, response) => { response.end(); });
    const target = await httpFixture(handler);
    const report = await createControlledAssessmentRunner({ origin: target.origin }).run(input('internal'));
    expect(handler).not.toHaveBeenCalled();
    expect(report.external).toBeNull();
    expect(report.internal?.status).toBe('completed');
    expect(report.comparison.every((row) => row.classification === 'unverified')).toBe(true);
  });

  it('bases findings on actual bytes, without letting internal results dictate HTTP findings', async () => {
    const target = await demo();
    const repository: ControlledRepositoryPort = { readFile: (_revision, path) => fixture('corrected', path) };
    const report = await createControlledAssessmentRunner({ origin: target.origin, repository }).run(input());
    expect(report.internal?.findings).toHaveLength(0);
    expect(report.external?.findings.some((finding) => finding.correlationKey === 'http:content-security-policy')).toBe(true);
    expect(report.comparison.every((row) => row.classification === 'external_only')).toBe(true);
  });

  it('does not execute source or dependency scripts while checking the AST and manifest', async () => {
    const repository: ControlledRepositoryPort = { async readFile(_revision, path) {
      if (path === 'store.ts') return Buffer.from('throw new Error("MUST NOT EXECUTE"); export const includeCustomerEmailInAudit = true;');
      if (path === 'package.json') return Buffer.from(JSON.stringify({ dependencies: {}, scripts: { postinstall: 'exit 88', test: 'exit 89' } }));
      return fixture('corrected', path);
    } };
    const report = await createControlledAssessmentRunner({ repository }).run(input('internal'));
    expect(report.internal?.status).toBe('completed');
    expect(report.internal?.findings.map((finding) => finding.ruleId)).toEqual(['controlled.audit-email-literal']);
  });

  it('makes unsupported source shapes, dependency ranges and malformed JSON visible as partial coverage', async () => {
    const repository: ControlledRepositoryPort = { async readFile(_revision, path) {
      if (path === 'store.ts') return Buffer.from('// export const includeCustomerEmailInAudit = true;\nexport const example = "includeCustomerEmailInAudit = true";');
      if (path === 'package.json') return Buffer.from('{"dependencies":{"lodash":"^4.17.20"}}');
      return Buffer.from('{invalid');
    } };
    const report = await createControlledAssessmentRunner({ repository }).run(input('internal'));
    expect(report.internal?.status).toBe('partial');
    expect(report.internal?.findings).toHaveLength(0);
    expect(report.internal?.coverage.filter((item) => item.state === 'unavailable')).toHaveLength(3);
  });

  it('reports unavailable repository coverage without inventing a clean scan or claiming external-only absence', async () => {
    const target = await demo();
    const repository: ControlledRepositoryPort = { readFile: () => Promise.reject(new Error('Fixture missing')) };
    const report = await createControlledAssessmentRunner({ origin: target.origin, repository }).run(input());
    expect(report.internal?.status).toBe('unavailable');
    expect(report.internal?.evidence).toHaveLength(0);
    expect(report.comparison.every((row) => row.classification === 'unverified')).toBe(true);
  });

  it('bounds a hanging repository port cumulatively below the coordinator lease', async () => {
    const repository: ControlledRepositoryPort = { readFile: () => new Promise<Uint8Array>(() => {}) };
    const started = performance.now();
    const report = await createControlledAssessmentRunner({ repository }).run(input('internal'));
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(report.internal?.status).toBe('unavailable');
  }, 12_000);
});

describe('scope and transport limits over live HTTP', () => {
  it.each([
    'http://example.com:4100', 'http://8.8.8.8', 'http://169.254.169.254', 'http://0.0.0.0',
    'http://127.1:4100', 'http://2130706433', 'http://0x7f000001', 'http://127.0.0.1:4100/path',
    'http://127.0.0.1:4100/', 'http://user:pass@127.0.0.1:4100', 'http://127.0.0.1?path=/secret',
    'http://127.0.0.1#fragment', 'http://[::1]:4100', 'https://127.0.0.1:4100', 'http://127.0.0.1:0',
  ])('rejects non-registry origin shapes before making a request: %s', (origin) => {
    expect(() => createControlledAssessmentRunner({ origin })).toThrow();
  });

  it('accepts operator private origins and refuses raised limits', () => {
    for (const origin of ['http://10.1.2.3:4100', 'http://172.16.0.2:4100', 'http://192.168.1.2:4100']) {
      expect(controlledTransportOptionsSchema.parse({ origin }).origin).toBe(origin);
    }
    expect(() => createControlledAssessmentRunner({ timeoutMs: 2_001 })).toThrow();
    expect(() => createControlledAssessmentRunner({ maxBodyBytes: 2_049 })).toThrow();
  });

  it('rejects unknown targets, caller URLs, paths and invalid scope before repository or HTTP work', async () => {
    const target = await demo();
    const read = vi.fn(() => Promise.reject(new Error('No source access authorized')));
    const runner = createControlledAssessmentRunner({ origin: target.origin, repository: { readFile: read } });
    await expect(runner.run({ ...input(), targetKey: 'http://169.254.169.254' })).rejects.toThrow('registry');
    // @ts-expect-error Deliberately invalid runtime data must still fail the public schema.
    await expect(runner.run({ ...input(), revision: '../corrected' })).rejects.toThrow();
    const withUrl = { ...input(), url: 'http://169.254.169.254' };
    await expect(runner.run(withUrl)).rejects.toThrow();
    await expect(runner.run({ ...input(), organizationId: 'wrong' })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it('only requests the fixed GET and never follows a redirect', async () => {
    const requests: Array<{ method: string | undefined; path: string | undefined }> = [];
    let destinationRequests = 0;
    const destination = await httpFixture((_, response) => { destinationRequests += 1; response.end('must not fetch'); });
    const target = await httpFixture((request, response) => {
      requests.push({ method: request.method, path: request.url });
      response.writeHead(302, { location: `${destination.origin}/private` });
      response.write('An unfinished redirect body must also be cancelled safely.');
    });
    const report = await createControlledAssessmentRunner({ origin: target.origin }).run(input());
    expect(requests).toEqual([{ method: 'GET', path: '/vulnerable' }]);
    expect(destinationRequests).toBe(0);
    expect(report.external?.status).toBe('partial');
    expect(report.external?.findings).toHaveLength(0);
    expect(report.external?.evidence[0]?.excerpt).toContain('redirect_refused');
    expect(report.comparison.every((row) => row.classification === 'unverified')).toBe(true);
  });

  it('times out before response headers and reports unavailable', async () => {
    const target = await httpFixture(() => {});
    const started = performance.now();
    const report = await createControlledAssessmentRunner({ origin: target.origin, timeoutMs: 60 }).run(input('external'));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(report.external?.status).toBe('unavailable');
    expect(report.external?.evidence).toHaveLength(0);
    expect(report.external?.findings).toHaveLength(0);
  });

  it('bounds the whole streaming body, not just time to first byte', async () => {
    const target = await httpFixture((_, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.write('prefix'); });
    const report = await createControlledAssessmentRunner({ origin: target.origin, timeoutMs: 60 }).run(input('external'));
    expect(report.external?.status).toBe('partial');
    expect(report.external?.evidence[0]?.excerpt).toContain('deadline_exceeded');
    expect(report.external?.findings).toHaveLength(0);
  });

  it('caps response bytes and preserves only the captured prefix without inventing findings', async () => {
    const target = await httpFixture((_, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('x'.repeat(100_000)); });
    const report = await createControlledAssessmentRunner({ origin: target.origin, maxBodyBytes: 32 }).run(input('external'));
    expect(report.external?.status).toBe('partial');
    expect(report.external?.evidence[0]?.excerpt).toContain(Buffer.from('x'.repeat(32)).toString('base64'));
    expect(report.external?.evidence[0]?.excerpt).toContain('body_limit');
    expect(report.external?.findings).toHaveLength(0);
  });

  it('retains the entire checksummed HTTP capture even at the supported body and header limits', async () => {
    const target = await httpFixture((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': 'x'.repeat(200), 'x-powered-by': 'y'.repeat(200) }).end('z'.repeat(2_048));
    });
    const report = await createControlledAssessmentRunner({ origin: target.origin }).run(input('external'));
    expect(report.external?.status).toBe('completed');
    const evidence = report.external?.evidence[0];
    if (!evidence) throw new Error('Expected complete HTTP evidence');
    expect(evidence.excerpt.length).toBeLessThan(4_096);
    expect(sha256(evidence.excerpt)).toBe(evidence.checksum);
    expect(evidence.excerpt).toContain(Buffer.from('z'.repeat(2_048)).toString('base64'));
  });

  it('bounds raw response headers before parsing and records no invented evidence', async () => {
    const target = await httpFixture((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'x-oversized': 'x'.repeat(9_000) }).end('body');
    });
    const report = await createControlledAssessmentRunner({ origin: target.origin }).run(input('external'));
    expect(report.external?.status).toBe('unavailable');
    expect(report.external?.evidence).toHaveLength(0);
  });

  it.each([404, 500])('does not treat HTTP %s error pages as the catalog', async (status) => {
    const target = await httpFixture((_, response) => { response.writeHead(status, { 'content-type': 'text/html' }).end('error'); });
    const report = await createControlledAssessmentRunner({ origin: target.origin }).run(input('external'));
    expect(report.external?.status).toBe('partial');
    expect(report.external?.findings).toHaveLength(0);
  });

  it('refuses large selected headers and compressed bodies with explicit partial coverage', async () => {
    for (const headers of [{ 'x-powered-by': 'x'.repeat(600) }, { 'content-encoding': 'gzip' }]) {
      const target = await httpFixture((_, response) => { response.writeHead(200, { 'content-type': 'text/html', ...headers }).end('body'); });
      const report = await createControlledAssessmentRunner({ origin: target.origin }).run(input('external'));
      expect(report.external?.status).toBe('partial');
      expect(report.external?.findings).toHaveLength(0);
    }
  });

  it('detects tampered correlations at the public report boundary', async () => {
    const target = await demo();
    const report = await createControlledAssessmentRunner({ origin: target.origin }).run(input());
    const first = report.comparison[0];
    if (!first) throw new Error('Expected correlation');
    first.key = 'unrelated';
    expect(assessmentReportSchema.safeParse(report).success).toBe(false);
  });
});

describe('repository and advisory boundaries', () => {
  it('treats invalid UTF-8 and oversized repository-port output as unknown coverage', async () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.alloc(17_000)]) {
      const repository: ControlledRepositoryPort = { readFile: () => Promise.resolve(bytes) };
      const report = await createControlledAssessmentRunner({ repository }).run(input('internal'));
      expect(report.internal?.status).toBe('unavailable');
      expect(report.internal?.findings).toHaveLength(0);
      expect(report.internal?.coverage.filter((item) => item.state === 'unavailable')).toHaveLength(3);
    }
  });

  it('rejects oversize files, symlinks and non-file inputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gotchu-fixture-test-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'large.txt');
    await writeFile(file, 'x'.repeat(17_000));
    await expect(readBoundedFile(file, 16_384)).rejects.toThrow();
    const link = join(directory, 'link.txt');
    await symlink(file, link);
    await expect(readBoundedFile(link, 20_000)).rejects.toThrow();
    await expect(readBoundedFile(directory, 20_000)).rejects.toThrow();
  });

  it('validates runtime revision and fixed filenames at the bundled adapter', async () => {
    const repository = createBundledRepository();
    expect(Buffer.from(await repository.readFile('vulnerable', 'store.ts')).toString()).toContain('includeCustomerEmailInAudit = true');
    // @ts-expect-error Reject untrusted revision data even from JavaScript callers.
    expect(() => repository.readFile('../corrected', 'store.ts')).toThrow();
    // @ts-expect-error Reject untrusted filenames even from JavaScript callers.
    expect(() => repository.readFile('vulnerable', '../package.json')).toThrow();
  });

  it('only matches exact stable versions inside the independently attributed range', () => {
    expect(matchesCapturedLodashRange('4.17.20')).toBe(true);
    expect(matchesCapturedLodashRange('4.17.21')).toBe(false);
    expect(matchesCapturedLodashRange('3.10.1')).toBe(true);
    expect(matchesCapturedLodashRange('5.0.0')).toBe(false);
    for (const version of ['^4.17.20', 'latest', '4.17.21-beta', 'npm:lodash@4.17.20', '04.17.20']) expect(matchesCapturedLodashRange(version)).toBeUndefined();
  });
});
