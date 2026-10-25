// Unit sources only: synthetic events are not evidence of a live Node/VM run.
import { describe, expect, it } from 'vitest';
import { MAX_REPORT_BYTES, emptySelectedReport, readSelectedReport, selectedNodeArgs, summarizeNodeEvents } from '../guest/selected-node.mjs';

const counts = { passed: 2, failed: 0, skipped: 0, cancelled: 0, tests: 2, todo: 0 };
const summary = (c = counts, file, success = true) => ({ type: 'test:summary', data: { counts: c, file, success } });
async function* events(values) { yield* values; }
const completed = () => [summary(counts, '/scratch/work/tests/creator.test.ts'), summary()];

describe('fixed selected Node reporter completion', () => {
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
