import type { EvidenceRecord, RunReadTool } from '@gotchu/agent';
import type { InvestigationSubject } from '@gotchu/contracts';
import type { buildInvestigationReadMenu } from './investigation-prompt.js';

const MAX_CONTEXT_CHARS = 12_000;

/** Bound the serialized envelope, including escaping and the remaining-read menu. */
export function boundedInvestigationContext(
  subject: InvestigationSubject,
  loaded: readonly { tool: RunReadTool; record: EvidenceRecord }[],
  menu: ReturnType<typeof buildInvestigationReadMenu>,
) {
  const evidence: Array<{ tool: RunReadTool; record: Pick<EvidenceRecord, 'evidenceId' | 'source' | 'collectedAt' | 'excerpt' | 'truncated'> }> = [];
  let omittedRecords = loaded.length;
  let shortenedExcerpts = 0;
  const serialize = () => JSON.stringify({ subject, evidence, ...menu,
    contextCoverage: { omittedRecords, shortenedExcerpts, complete: omittedRecords === 0 && shortenedExcerpts === 0 && loaded.every(item => !item.record.truncated) },
  });
  // Later reads contain the information requested to resolve the latest uncertainty.
  for (const item of loaded.toReversed()) {
    const { evidenceId, source, collectedAt, excerpt, truncated } = item.record;
    const next = { tool: item.tool, record: { evidenceId, source, collectedAt, excerpt, truncated } };
    evidence.push(next);
    omittedRecords--;
    if (serialize().length <= MAX_CONTEXT_CHARS) continue;
    shortenedExcerpts++;
    next.record.truncated = true;
    let low = 0;
    let high = excerpt.length;
    next.record.excerpt = '';
    if (serialize().length > MAX_CONTEXT_CHARS) {
      evidence.pop(); omittedRecords++; shortenedExcerpts--;
      continue;
    }
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      next.record.excerpt = excerpt.slice(0, middle);
      if (serialize().length <= MAX_CONTEXT_CHARS) low = middle;
      else high = middle - 1;
    }
    next.record.excerpt = excerpt.slice(0, low);
  }
  return serialize();
}
