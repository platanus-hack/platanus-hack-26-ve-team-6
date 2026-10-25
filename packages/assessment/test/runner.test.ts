import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDemoTargetServer } from '@gotchu/demo-target';
import { assessmentReportSchema, type AssessmentRunInput, type DemoRevision } from '@gotchu/contracts';
import { createControlledAssessmentRunner, controlledTargetKey, type ControlledRepositoryPort, type ControlledSourceFile } from '../src/index.js';

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
});

describe('scope and transport limits over live HTTP', () => {
  it.each([
    'http://8.8.8.8', 'http://169.254.169.254', 'http://2130706433', 'http://127.0.0.1:4100/path', 'http://user:pass@127.0.0.1:4100',
  ])('rejects non-registry origin shapes before making a request: %s', (origin) => {
    expect(() => createControlledAssessmentRunner({ origin })).toThrow();
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
});
