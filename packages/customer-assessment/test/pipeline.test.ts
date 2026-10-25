import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createCustomerAssessmentRunner } from '../src/index.js';
import { analysis, compare, finding, sha256 } from '../src/common.js';
import { runCustomerAssessmentPipeline, settleAnalyses } from '../src/pipeline.js';
import { absentScanners, input } from './fixtures.js';

function request(mode: 'internal' | 'external' | 'both', content = 'source snapshot', origin = 'https://customer.org') {
  const value = input([{ path: 'app.ts', content }]);
  value.mode = mode;
  if (mode === 'external') value.source = null;
  if (mode === 'internal') value.target = null;
  if (mode !== 'internal') {
    value.target = {
      id: randomUUID(), origin, version: 3,
      authorizedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
  return value;
}

const offlineHttps = { lookup: async () => { throw new Error('fixture_offline'); } };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['internal', 'external', 'both'] as const)('traverses each real StateGraph stage for %s assessments', async mode => {
  const result = await runCustomerAssessmentPipeline(request(mode), {
    scanners: absentScanners,
    https: offlineHttps,
    deadlineMs: 1_000,
  });
  expect(result.stages).toEqual({ validated: 1, analyzed: 1, compared: 1, finalized: 1 });
  expect(result.report.version).toBe(2);
  expect(result.report.internal === null).toBe(mode === 'external');
  expect(result.report.external === null).toBe(mode === 'internal');
  const limitations = result.report.limitations.join(' ');
  expect(limitations.includes('HTTPS observations')).toBe(mode !== 'internal');
  expect(limitations.includes('static source')).toBe(mode !== 'external');
});

it.each([
  ['internal', ['internal_finished']],
  ['external', ['external_finished']],
  ['both', ['internal_finished', 'external_finished', 'correlating']],
] as const)('reports each finished branch of a %s assessment before the report exists', async (mode, expected) => {
  const phases: string[] = [];
  const result = await runCustomerAssessmentPipeline(request(mode), {
    scanners: absentScanners, https: offlineHttps, deadlineMs: 1_000,
    onProgress: phase => phases.push(phase),
  });
  // Branches run in parallel, so only membership is fixed; correlation always comes last.
  expect([...phases].sort()).toEqual([...expected].sort());
  if (mode === 'both') expect(phases.at(-1)).toBe('correlating');
  expect(result.report.mode).toBe(mode);
});

it('keeps concurrent assessment inputs and results in their own invocation closures', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seenSources: string[] = [];
  const scanners = {
    async run(_name: string, source: NonNullable<ReturnType<typeof request>['source']>) {
      seenSources.push(source.files[0]?.content ?? '');
      await gate;
      throw new Error('fixture_scanner_unavailable');
    },
    async readiness() { return { ready: false, tools: [] }; },
  };
  const runner = createCustomerAssessmentRunner({ scanners, https: {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  } });
  const first = request('both', 'PRIVATE_SOURCE_ALPHA', 'https://alpha.customer.org');
  const second = request('both', 'PRIVATE_SOURCE_BETA', 'https://beta.customer.org');
  const firstRun = runner.run(first);
  const secondRun = runner.run(second);
  await vi.waitFor(() => expect(seenSources).toHaveLength(6));
  release();
  const [firstReport, secondReport] = await Promise.all([firstRun, secondRun]);

  expect(new Set(seenSources)).toEqual(new Set(['PRIVATE_SOURCE_ALPHA', 'PRIVATE_SOURCE_BETA']));
  expect(firstReport.subject).toMatchObject({ sourceSnapshotId: first.source?.id, sourceDigest: first.source?.digest, origin: first.target?.origin });
  expect(secondReport.subject).toMatchObject({ sourceSnapshotId: second.source?.id, sourceDigest: second.source?.digest, origin: second.target?.origin });
  expect(firstReport.internal?.snapshotRef).toBe(`source:${first.source?.id}:sha256:${first.source?.digest}`);
  expect(secondReport.internal?.snapshotRef).toBe(`source:${second.source?.id}:sha256:${second.source?.digest}`);
  expect(firstReport.external?.snapshotRef).toBe(`target:${first.target?.id}:3:${sha256(first.target?.origin ?? '')}`);
  expect(secondReport.external?.snapshotRef).toBe(`target:${second.target?.id}:3:${sha256(second.target?.origin ?? '')}`);
});

it('waits for a sibling when a branch startup throws synchronously', async () => {
  const startupError = new Error('fixture_startup_failure');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let siblingStarted = false;
  let settled = false;
  const work = settleAnalyses('both', () => { throw startupError; }, async () => {
    siblingStarted = true;
    await gate;
    return analysis('external', 'target:fixture');
  });
  work.then(() => { settled = true; }, () => { settled = true; });
  await vi.waitFor(() => expect(siblingStarted).toBe(true));
  expect(settled).toBe(false);
  release();
  await expect(work).rejects.toBe(startupError);
});

it('refuses tracing and verbose environments before readiness, input processing, adapters, or logging', async () => {
  vi.stubEnv('LANGSMITH_TRACING', 'true');
  vi.stubEnv('LANGSMITH_TRACING_V2', 'true');
  vi.stubEnv('LANGCHAIN_TRACING_V2', 'true');
  vi.stubEnv('LANGCHAIN_TRACING', 'true');
  vi.stubEnv('LANGCHAIN_VERBOSE', 'true');
  vi.stubEnv('LANGSMITH_ENDPOINT', 'http://127.0.0.1:4319');
  vi.stubEnv('LANGSMITH_API_KEY', 'fixture_private_sink_key');
  const fetchSink = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchSink);
  const scannerRun = vi.fn(async () => { throw new Error('unexpected_scanner_io'); });
  const scannerReadiness = vi.fn(async () => ({ ready: true, tools: [] }));
  const lookup = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
  const runner = createCustomerAssessmentRunner({ scanners: { run: scannerRun, readiness: scannerReadiness }, https: { lookup } });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const secret = 'PRIVATE_SOURCE_MUST_NEVER_BE_LOGGED_OR_SENT';

  await expect(runner.readiness()).rejects.toThrow('customer_assessment_langchain_telemetry_enabled');
  await expect(runner.run(request('both', secret))).rejects.toThrow('customer_assessment_langchain_telemetry_enabled');
  expect(scannerReadiness).not.toHaveBeenCalled();
  expect(scannerRun).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(fetchSink).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(process.env.LANGSMITH_TRACING).toBe('true');
  expect(process.env.LANGCHAIN_VERBOSE).toBe('true');
  expect(JSON.stringify([fetchSink.mock.calls, log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(secret);
});

function withFinding(origin: 'internal' | 'external', status: 'completed' | 'partial' | 'unavailable' = 'completed') {
  const result = analysis(origin, `${origin}:fixture`);
  result.status = status;
  finding(result, {
    ruleId: 'fixture.rule', correlationKey: 'fixture:rule', title: 'Fixture indication', location: 'app.ts:1',
    description: 'Fixture only.', severity: 'unknown', confidence: 'uncertain', impact: 'Unknown.',
    recommendation: 'Review.', limitations: [], evidenceIds: [randomUUID()],
  });
  return result;
}

it('explains comparison uncertainty without claiming opposite-side absence', () => {
  const cases = [
    [null, 'not requested'],
    [analysis('external', 'external:fixture'), 'unavailable'],
    [analysis('external', 'external:fixture'), 'partial'],
    [analysis('external', 'external:fixture'), 'completed without a matching finding'],
  ] as const;
  cases[1][0]!.status = 'unavailable';
  cases[2][0]!.status = 'partial';
  cases[3][0]!.status = 'completed';
  for (const [other, phrase] of cases) {
    const comparison = compare(withFinding('internal'), other)[0];
    expect(comparison?.classification).toBe('unverified');
    expect(comparison?.key).toBe('fixture:rule');
    expect(comparison?.explanation).toContain(phrase);
    expect(comparison?.explanation).toContain('does not establish absence');
  }
  const both = compare(withFinding('internal'), withFinding('external'))[0];
  expect(both?.classification).toBe('both');
  expect(both?.key).toBe('fixture:rule');
  expect(both?.explanation).toContain('does not establish deployment equivalence');

  const sourceFinding = withFinding('internal');
  const httpsFinding = withFinding('external');
  sourceFinding.findings[0]!.correlationKey = 'http:content-security-policy';
  httpsFinding.findings[0]!.correlationKey = 'http:content-security-policy';
  expect(compare(sourceFinding, httpsFinding)[0]).toEqual(expect.objectContaining({
    key: 'http:content-security-policy',
    classification: 'both',
    explanation: 'Source contains a Helmet CSP-disabling configuration indication; independent HTTPS responses omit CSP. These observations concern the same control. Shared deployment, route association, causal relationship, issue identity and exploitability are unverified.',
  }));
  expect(compare(sourceFinding, null)[0]?.classification).toBe('unverified');
});
