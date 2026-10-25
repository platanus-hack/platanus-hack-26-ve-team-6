import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { investigationRunSchema } from '@gotchu/contracts';
import { describe, expect, it } from 'vitest';
import { InvestigationsTimeline } from '../src/components/investigations-panel.js';

function render(legacy = false) {
  const organizationId = randomUUID(); const applicationId = randomUUID(); const reportId = randomUUID(); const evidenceId = randomUUID();
  const run = investigationRunSchema.parse({ organizationId, applicationId, jobId: randomUUID(), subject: { kind: 'finding', subjectId: randomUUID(), reportId }, state: 'succeeded', status: 'investigated',
    summary: 'Synthetic model explanation', assessment: 'candidate_issue', citedEvidenceIds: [evidenceId], hypotheses: [],
    candidateSuggestion: { kind: 'source_change', summary: 'Validate a TLS certificate', path: 'src/client.ts', evidenceIds: [evidenceId], validationRequired: 'D05',
      ...(legacy ? {} : { implications: ['Reject connections with an untrusted certificate.'], risks: ['An internal certificate may need a configured trust root.'], validationPlan: ['Verify trusted and untrusted certificate cases independently.'] }) },
    tokensSpent: 10, costMicroUsd: 0, reservedCostMicroUsd: 0, reservedTokens: 0, createdAt: new Date().toISOString(), cancelRequested: false });
  const client = new QueryClient();
  client.setQueryData(['customer-data', organizationId, applicationId, 'investigations'], [run,
    { ...run, jobId: randomUUID(), subject: { kind: 'incident', subjectId: randomUUID() }, summary: 'Unrelated runtime incident', candidateSuggestion: null }]);
  const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(InvestigationsTimeline, { organizationId, applicationId, reportId, canManage: true })));
  client.clear(); return { markup, organizationId, applicationId, reportId };
}
describe('investigation suggestions for human review (synthetic model output)', () => {
  it('shows behavior changes, risks and checks with a link to the exact report', () => {
    const { markup, organizationId, applicationId, reportId } = render();
    expect(markup).toContain('Reject connections with an untrusted certificate.');
    expect(markup).toContain('An internal certificate may need a configured trust root.');
    expect(markup).toContain('Verify trusted and untrusted certificate cases independently.');
    expect(markup).toContain(`/w/${organizationId}/p/${applicationId}/informes/${reportId}`);
    expect(markup).toContain('requiere validación y aprobación'); expect(markup).toContain('no verificada');
    expect(markup).not.toContain('Unrelated runtime incident');
  });
  it('keeps missing implications and risks explicitly unknown for older saved investigations', () => {
    const { markup } = render(true);
    expect(markup).toContain('no detalló las implicaciones'); expect(markup).toContain('siguen sin evaluarse');
    expect(markup).toContain('Hace falta definir la validación independiente.');
  });
});
