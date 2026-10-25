import { z } from 'zod';
import { selectedNodeTestReportSchema, type RunnerProfile, type RunnerResult } from '@gotchu/runner';

const legacyResultSchema = z.object({
  passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  regression: z.enum(['failed_for_target', 'passed']).optional(),
}).strict();

/** Selected profiles accept only the fixed guest reporter's reserved artifact. */
export function suiteCounts(result: RunnerResult, profile: RunnerProfile) {
  if (result.status !== 'completed' || result.isolation.profile !== profile) return null;
  if (profile === 'node24-tsx-selected-v1' && (result.stdout.truncated || result.stderr.truncated || !result.isolation.cleanupVerified)) return null;
  for (const artifact of result.artifacts) {
    if (profile === 'node24-tsx-selected-v1'
      ? artifact.path !== 'test-results/gotchu-node-selected-v1.json'
      : !artifact.path.startsWith('test-results/')) continue;
    try {
      const raw: unknown = JSON.parse(Buffer.from(artifact.contentBase64, 'base64').toString('utf8'));
      if (profile === 'node24-tsx-selected-v1') {
        const parsed = selectedNodeTestReportSchema.safeParse(raw);
        if (!parsed.success || !parsed.data.complete || parsed.data.counts.total === 0) return null;
        const { passed, failed, skipped, cancelled } = parsed.data.counts;
        return { counts: { passed, failed: failed + cancelled, skipped }, regression: null,
          success: parsed.data.success && passed > 0 && failed === 0 && cancelled === 0 };
      }
      const parsed = legacyResultSchema.safeParse(raw);
      if (parsed.success) return { counts: { passed: parsed.data.passed, failed: parsed.data.failed, skipped: parsed.data.skipped },
        regression: parsed.data.regression ?? null, success: parsed.data.failed === 0 && parsed.data.passed > 0 };
    } catch { /* Missing or malformed structured results remain unknown. */ }
  }
  return null;
}
