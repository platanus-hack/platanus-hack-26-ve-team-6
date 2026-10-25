// Unit sources only: synthetic events are not evidence of a live Node/VM run.
import { describe, expect, it } from 'vitest';
import { MAX_REPORT_BYTES, emptySelectedReport, readSelectedReport, selectedNodeArgs, summarizeNodeEvents } from '../guest/selected-node.mjs';

const counts = { passed: 2, failed: 0, skipped: 0, cancelled: 0, tests: 2, todo: 0 };
const summary = (c = counts, file, success = true, entryFile) => ({ type: 'test:summary', data: { counts: c, file, success, entryFile } });
async function* events(values) { yield* values; }
const completed = () => [summary(counts, '/scratch/work/tests/creator.test.ts'), summary()];

describe('fixed selected Node reporter completion', () => {
  it('retains all 14 failed tests from forwarded summaries without source locations', async () => {
    const failed = { passed: 0, failed: 7, skipped: 0, cancelled: 0, tests: 7, todo: 0 };
    const report = await summarizeNodeEvents(events([
      summary(failed, undefined, false, '/scratch/work/tests/creator.test.ts'),
      summary(failed, undefined, false, '/scratch/work/tests/accounts.test.ts'),
      { type: 'test:diagnostic', data: { message: 'tests 14' } },
      summary({ ...failed, failed: 14, tests: 14 }, undefined, false),
    ]));
    expect(report).toEqual({ ...emptySelectedReport(), complete: true,
      counts: { passed: 0, failed: 14, skipped: 0, cancelled: 0, total: 14 } });
  });
  it('identifies duplicate child completions by entry file rather than source location', async () => {
    const diagnostics = [];
    const report = await summarizeNodeEvents(events([
      { type: 'test:summary', data: { counts, success: true, entryFile: 'tests/creator.test.ts', file: 'support/a.ts' } },
      { type: 'test:summary', data: { counts, success: true, entryFile: 'tests/creator.test.ts', file: 'support/b.ts' } },
      summary({ ...counts, passed: 4, tests: 4 }),
    ]), (diagnostic) => diagnostics.push(diagnostic));
    expect(report).toEqual(emptySelectedReport());
    expect(diagnostics).toEqual([{ reason: 'invalid_or_duplicate_file_summary', fileSummaries: 1,
      fileCounts: { passed: 2, failed: 0, skipped: 0, cancelled: 0, total: 2 },
      globalCounts: { passed: 4, failed: 0, skipped: 0, cancelled: 0, total: 4 } }]);
  });
  it('reports count disagreement without trusting numeric-looking stdout', async () => {
    const diagnostics = [];
    expect(await summarizeNodeEvents(events([
      summary(counts, 'tests/creator.test.ts'),
      { type: 'test:stdout', data: { message: 'tests 99 pass 99' } },
      summary({ ...counts, passed: 3, tests: 3 }),
    ]), (diagnostic) => diagnostics.push(diagnostic))).toEqual(emptySelectedReport());
    expect(diagnostics[0]?.reason).toBe('count_mismatch');
  });
  it('reconciles multiple file summaries with the global completion, excluding suites', async () => {
    const report = await summarizeNodeEvents(events([
      summary({ ...counts, suites: 1 }, '/scratch/work/tests/creator.test.ts'),
      summary({ ...counts, passed: 1, tests: 1 }, '/scratch/work/tests/accounts.test.js'),
      summary({ ...counts, passed: 3, tests: 3, suites: 1 }),
    ]));
    expect(report).toMatchObject({ complete: true, success: true, counts: { passed: 3, total: 3 } });
  });
  it('requires stream end rather than accepting a summary before a stream failure', async () => {
    async function* broken() { yield* completed(); throw new Error('stream failed'); }
    await expect(summarizeNodeEvents(broken())).rejects.toThrow('stream failed');
  });
  it('rejects missing global completion, duplicate summaries, late events and implicit empty-file passes', async () => {
    for (const values of [completed().slice(0, 1), [...completed(), summary()], [...completed(), { type: 'test:stdout', data: { message: 'late' } }],
      [summary({ ...counts, passed: 0, tests: 0 }, '/scratch/work/tests/empty.test.ts'), summary({ ...counts, passed: 1, tests: 1 })]]) {
      expect(await summarizeNodeEvents(events(values))).toEqual(emptySelectedReport());
    }
  });
  it('fails closed on zero matches, skipped-only suites, TODOs, failures, cancellation and unsuccessful summaries', async () => {
    for (const c of [
      { ...counts, passed: 0, tests: 0 }, { ...counts, passed: 0, skipped: 2 },
      { ...counts, passed: 1, todo: 1 }, { ...counts, passed: 1, failed: 1 }, { ...counts, passed: 1, cancelled: 1 },
    ]) {
      const report = await summarizeNodeEvents(events([summary(c, 'tests/creator.test.ts'), summary(c)]));
      expect(report.success).toBe(false);
    }
    expect((await summarizeNodeEvents(events([summary(counts, 'tests/creator.test.ts'), summary(counts, undefined, false)]))).success).toBe(false);
  });
  it('does not interpret stdout as completion evidence', async () => {
    expect(await summarizeNodeEvents(events([{ type: 'test:stdout', data: { message: JSON.stringify({ complete: true, success: true, counts }) } }]))).toEqual(emptySelectedReport());
  });
});

describe('selected report channel and argv', () => {
  it('rejects malformed, truncated, oversized, duplicate and contradictory channel data', () => {
    const report = { ...emptySelectedReport(), complete: true, success: true,
      counts: { passed: 1, failed: 0, skipped: 0, cancelled: 0, total: 1 } };
    expect(readSelectedReport(Buffer.from(JSON.stringify(report)))).toEqual(report);
    for (const text of ['', '{', JSON.stringify(report).slice(0, -1), JSON.stringify(report).repeat(2), ' '.repeat(MAX_REPORT_BYTES + 1),
      JSON.stringify({ ...report, complete: false }), JSON.stringify({ ...report, counts: { ...report.counts, total: 2 } })]) {
      expect(readSelectedReport(Buffer.from(text))).toEqual(emptySelectedReport());
    }
  });
  it('passes a literal name filter as one argument and uses pinned tools and explicit files', () => {
    const pattern = 'selected.*$(touch /scratch/should-not-exist)';
    const args = selectedNodeArgs({ files: ['tests/creator.test.ts', 'tests/accounts.test.js'], namePattern: pattern });
    expect(args).toContain(pattern);
    expect(args).toContain('/usr/local/lib/gotchu-node-selected/node_modules/tsx/dist/loader.mjs');
    expect(args.slice(-2)).toEqual(['/scratch/work/tests/creator.test.ts', '/scratch/work/tests/accounts.test.js']);
    expect(args).not.toContain('npm');
    expect(args).not.toContain('-c');
  });
});
