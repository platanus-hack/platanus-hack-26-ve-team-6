import { runReadToolSchema } from '@gotchu/agent';
import { investigationDataScopeSchema } from '@gotchu/contracts';
import { describe, expect, it } from 'vitest';
import { buildInvestigationReadMenu, investigationReadDataScope } from '../src/investigation-prompt.js';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const third = '00000000-0000-4000-8000-000000000003';
type MenuInput = Parameters<typeof buildInvestigationReadMenu>[0];
const base = {
  subjectKind: 'finding',
  evidenceIds: [first, second, third],
  allowedReadTools: runReadToolSchema.options,
  dataScopes: investigationDataScopeSchema.options,
  reads: [],
} satisfies MenuInput;

describe('investigation read menu', () => {
  it('offers only consented tools within the capability', () => {
    expect(buildInvestigationReadMenu({
      ...base,
      allowedReadTools: ['evidence.read', 'finding.details.read', 'source.excerpt.read'],
      dataScopes: ['finding_details', 'application_context'],
    })).toEqual({
      remainingAdditionalReads: 8,
      availableReads: [
        { name: 'evidence.read', evidenceIds: [first, second, third], remainingCalls: 3 },
        { name: 'finding.details.read', evidenceIds: [first, second, third], remainingCalls: 2 },
      ],
    });
  });

  it.each([
    { subjectKind: 'finding', expected: ['evidence.read', 'application.context.read', 'finding.details.read', 'source.excerpt.read', 'assessment.diff.read', 'validation.results.read'] },
    { subjectKind: 'incident', expected: ['evidence.read', 'auth.events.read', 'application.context.read', 'triage.results.read'] },
    { subjectKind: 'alert', expected: ['evidence.read', 'application.context.read', 'triage.results.read'] },
  ] satisfies Array<{ subjectKind: MenuInput['subjectKind']; expected: string[] }>)('filters subject-inapplicable tools for $subjectKind', ({ subjectKind, expected }) => {
    expect(buildInvestigationReadMenu({ ...base, subjectKind }).availableReads.map(read => read.name)).toEqual(expected);
  });

  it('uses subject-specific consent for evidence.read', () => {
    for (const subjectKind of ['finding', 'incident', 'alert'] as const) {
      const scope = subjectKind === 'finding' ? 'finding_details' : 'runtime_summaries';
      const otherScope = subjectKind === 'finding' ? 'runtime_summaries' : 'finding_details';
      expect(investigationReadDataScope(subjectKind, 'evidence.read')).toBe(scope);
      expect(buildInvestigationReadMenu({ ...base, subjectKind, allowedReadTools: ['evidence.read'], dataScopes: [scope] }).availableReads).toHaveLength(1);
      expect(buildInvestigationReadMenu({ ...base, subjectKind, allowedReadTools: ['evidence.read'], dataScopes: [otherScope] }).availableReads).toEqual([]);
    }
  });

  it.each([
    ['auth.events.read', 'runtime_summaries'],
    ['application.context.read', 'application_context'],
    ['finding.details.read', 'finding_details'],
    ['source.excerpt.read', 'source_excerpts'],
    ['assessment.diff.read', 'assessment_diffs'],
    ['validation.results.read', 'validation_results'],
    ['triage.results.read', 'triage_summaries'],
  ] satisfies Array<[MenuInput['allowedReadTools'][number], MenuInput['dataScopes'][number]]>)('requires the specific processing scope for %s', (tool, dataScope) => {
    const subjectKind = tool === 'auth.events.read' || tool === 'triage.results.read' ? 'incident' : 'finding';
    expect(investigationReadDataScope(subjectKind, tool)).toBe(dataScope);
    const input = { ...base, subjectKind, allowedReadTools: [tool] } satisfies MenuInput;
    expect(buildInvestigationReadMenu({ ...input, dataScopes: [dataScope] }).availableReads).toHaveLength(1);
    expect(buildInvestigationReadMenu({ ...input, dataScopes: base.dataScopes.filter(scope => scope !== dataScope) }).availableReads).toEqual([]);
  });

  it('excludes loaded tool/id pairs while retaining other tools for the same evidence', () => {
    const menu = buildInvestigationReadMenu({
      ...base,
      allowedReadTools: ['evidence.read', 'source.excerpt.read'],
      reads: [
        { tool: 'evidence.read', evidenceId: first, callType: 'required_evidence' },
        { tool: 'source.excerpt.read', evidenceId: second, callType: 'additional' },
      ],
    });
    expect(menu).toEqual({
      remainingAdditionalReads: 7,
      availableReads: [
        { name: 'evidence.read', evidenceIds: [second, third], remainingCalls: 2 },
        { name: 'source.excerpt.read', evidenceIds: [first, third], remainingCalls: 1 },
      ],
    });
  });

  it('does not charge required evidence loads against additional read budgets', () => {
    const evidenceIds = Array.from({ length: 20 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    const menu = buildInvestigationReadMenu({
      ...base, evidenceIds, allowedReadTools: ['evidence.read'],
      reads: evidenceIds.slice(0, 12).map(evidenceId => ({ tool: 'evidence.read', evidenceId, callType: 'required_evidence' })),
    });
    expect(menu).toEqual({ remainingAdditionalReads: 8, availableReads: [
      { name: 'evidence.read', evidenceIds: evidenceIds.slice(12), remainingCalls: 8 },
    ] });
  });

  it('exhausts a tool after two additional calls even if unread IDs remain', () => {
    const menu = buildInvestigationReadMenu({
      ...base,
      allowedReadTools: ['source.excerpt.read', 'finding.details.read'],
      reads: [first, second].map(evidenceId => ({ tool: 'source.excerpt.read', evidenceId, callType: 'additional' })),
    });
    expect(menu).toEqual({ remainingAdditionalReads: 6, availableReads: [
      { name: 'finding.details.read', evidenceIds: [first, second, third], remainingCalls: 2 },
    ] });
  });

  it('counts past reads even after their scope or tool is removed from the menu', () => {
    const reads: MenuInput['reads'] = Array.from({ length: 7 }, () => ({
      tool: 'evidence.read', evidenceId: first, callType: 'additional',
    }));
    // Distinct persisted calls consume quota even when an older prompt repeated a pair.
    expect(buildInvestigationReadMenu({ ...base, allowedReadTools: ['source.excerpt.read'], dataScopes: ['source_excerpts'], reads })).toEqual({
      remainingAdditionalReads: 1,
      availableReads: [{ name: 'source.excerpt.read', evidenceIds: [first, second, third], remainingCalls: 1 }],
    });
  });

  it.each([8, 9])('advertises no reads after %i additional calls', count => {
    expect(buildInvestigationReadMenu({ ...base, reads: Array.from({ length: count }, () => ({
      tool: 'evidence.read', evidenceId: first, callType: 'additional',
    })) })).toEqual({ remainingAdditionalReads: 0, availableReads: [] });
  });

  it('never advertises a tool without an unread authorized evidence ID', () => {
    expect(buildInvestigationReadMenu({ ...base, evidenceIds: [] }).availableReads).toEqual([]);
    expect(buildInvestigationReadMenu({ ...base, dataScopes: [] }).availableReads).toEqual([]);
    expect(buildInvestigationReadMenu({ ...base, allowedReadTools: [] }).availableReads).toEqual([]);
    expect(buildInvestigationReadMenu({
      ...base, evidenceIds: [first], allowedReadTools: ['evidence.read'],
      reads: [{ tool: 'evidence.read', evidenceId: first, callType: 'required_evidence' }],
    }).availableReads).toEqual([]);
  });

  it('deduplicates menu entries without modifying inputs', () => {
    const input = {
      ...base, evidenceIds: [first, first], allowedReadTools: ['source.excerpt.read', 'source.excerpt.read'],
    } satisfies MenuInput;
    expect(buildInvestigationReadMenu(input).availableReads).toEqual([
      { name: 'source.excerpt.read', evidenceIds: [first], remainingCalls: 1 },
    ]);
    expect(input.evidenceIds).toEqual([first, first]);
    expect(input.allowedReadTools).toEqual(['source.excerpt.read', 'source.excerpt.read']);
  });
});
