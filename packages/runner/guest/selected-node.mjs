export const SELECTED_NODE_PROFILE = 'node24-tsx-selected-v1';
export const SELECTED_NODE_REPORT_PATH = 'test-results/gotchu-node-selected-v1.json';
export const MAX_REPORT_BYTES = 4096;
const countKeys = ['passed', 'failed', 'skipped', 'cancelled', 'total'];
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;

export function emptySelectedReport() {
  return { schemaVersion: 1, profile: SELECTED_NODE_PROFILE, complete: false, success: false,
    counts: { passed: 0, failed: 0, skipped: 0, cancelled: 0, total: 0 } };
}

export function selectedNodeArgs(selection) {
  return ['/usr/local/bin/node', '--import', '/usr/local/lib/gotchu-node-selected/node_modules/tsx/dist/loader.mjs', '--test',
    ...(selection.namePattern === undefined ? [] : ['--test-name-pattern', selection.namePattern]),
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=/usr/local/lib/gotchu-node-selected-reporter.mjs', '--test-reporter-destination=stdout',
    ...selection.files.map((file) => `/scratch/work/${file}`)];
}

function summaryCounts(summary) {
  const c = summary?.counts;
  if (typeof summary?.success !== 'boolean' || !c
    || !['passed', 'failed', 'skipped', 'cancelled', 'tests', 'todo'].every((key) => count(c[key]))) return undefined;
  const counts = { passed: c.passed, failed: c.failed, skipped: c.skipped + c.todo, cancelled: c.cancelled, total: c.tests };
  if (!countKeys.every((key) => count(counts[key]))
    || counts.total !== counts.passed + counts.failed + counts.skipped + counts.cancelled) return undefined;
  return counts;
}

export async function summarizeNodeEvents(source, onIncomplete = () => {}) {
  let summary;
  let invalidReason;
  const files = new Set();
  const actual = emptySelectedReport().counts;
  for await (const event of source) {
    if (summary !== undefined) invalidReason ??= 'event_after_global_summary';
    if (event.type === 'test:interrupted') invalidReason ??= 'interrupted';
    if (event.type !== 'test:summary') continue;
    // Node's parent FileTest stamps entryFile on every forwarded child event.
    // A child's source location may be absent; that does not make it global.
    const file = event.data?.entryFile ?? event.data?.file;
    if (file === undefined) { summary = event.data; continue; }
    const counts = summaryCounts(event.data);
    if (!counts || typeof file !== 'string' || files.has(file) || files.size >= 20) {
      invalidReason ??= 'invalid_or_duplicate_file_summary';
      continue;
    }
    files.add(file);
    for (const key of countKeys) actual[key] += counts[key];
  }
  // File-only placeholder passes (including empty files) are not executed tests.
  // Reconcile completed child summaries with the one terminal global summary.
  const counts = summaryCounts(summary);
  const reason = invalidReason ?? (!counts ? 'missing_or_invalid_global_summary'
    : files.size === 0 ? 'missing_file_summary'
    : !countKeys.every((key) => actual[key] === counts[key]) ? 'count_mismatch' : undefined);
  if (reason !== undefined) {
    // Fixed metadata only: no test names, paths, stdout or customer error text.
    onIncomplete({ reason, fileSummaries: files.size, fileCounts: actual, globalCounts: counts ?? null });
    return emptySelectedReport();
  }
  // TODOs are unexecuted coverage; keep them in total but never accept them as success.
  return { schemaVersion: 1, profile: SELECTED_NODE_PROFILE, complete: true,
    success: summary.success && summary.counts.todo === 0 && counts.passed > 0 && counts.failed === 0 && counts.cancelled === 0, counts };
}

export function readSelectedReport(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_REPORT_BYTES) return emptySelectedReport();
  try {
    const report = JSON.parse(bytes.toString('utf8'));
    if (!report || Object.keys(report).sort().join(',') !== 'complete,counts,profile,schemaVersion,success'
      || report.schemaVersion !== 1 || report.profile !== SELECTED_NODE_PROFILE
      || typeof report.complete !== 'boolean' || typeof report.success !== 'boolean'
      || !report.counts || Object.keys(report.counts).sort().join(',') !== 'cancelled,failed,passed,skipped,total'
      || !countKeys.every((key) => count(report.counts[key]))) return emptySelectedReport();
    const c = report.counts;
    if (c.total !== c.passed + c.failed + c.skipped + c.cancelled) return emptySelectedReport();
    if (report.success && (!report.complete || c.passed === 0 || c.failed !== 0 || c.cancelled !== 0)) return emptySelectedReport();
    return report;
  } catch { return emptySelectedReport(); }
}
