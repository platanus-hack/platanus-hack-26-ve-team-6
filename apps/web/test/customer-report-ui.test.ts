import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AssessmentAnalysis, AssessmentFinding, DependencyInventory, DependencyReachability } from '@gotchu/contracts';
import { ExternalHttpsEvidence } from '../src/components/customer-report-components.js';
import { DependencyInventoryPanel } from '../src/components/customer-supply-chain.js';

const timestamp = '2026-10-24T12:00:00.000Z';
const checksum = 'a'.repeat(64);
const internalFindingId = '10000000-0000-4000-8000-000000000001';
const externalFindingId = '20000000-0000-4000-8000-000000000002';

function analysis(origin: 'internal' | 'external', status: AssessmentAnalysis['status'] = 'completed'): AssessmentAnalysis {
  return { origin, status, startedAt: timestamp, finishedAt: timestamp, snapshotRef: `${origin}:snapshot`, tool: { name: 'fixture', version: '1' }, findings: [], evidence: [], coverage: [], limitations: [] };
}

describe('customer report presentation', () => {
  it('prioritizes advisory packages by reachability and leaves other dependencies unprioritized', () => {
    const states = ['reachable', 'imported', 'unknown', 'not_found_static'] as const;
    const reachabilityFor = (state: DependencyReachability['state']): DependencyReachability => ({
      state,
      symbolCoverage: state === 'reachable' ? 'available' : 'unknown',
      symbols: state === 'reachable' ? ['parse'] : [],
      importEvidence: state === 'reachable' || state === 'imported' ? [{ file: 'src/app.ts', line: 2, specifier: 'priority-package', kind: 'import' }] : [],
      symbolEvidence: state === 'reachable' ? [{ file: 'src/app.ts', line: 3, symbol: 'parse' }] : [],
      dependencyPath: ['pkg:npm/priority-package@1.0.0'],
      limitation: ['Test fixture.'],
    });
    const packageNames = ['priority-reachable', 'priority-imported', 'priority-unknown', 'priority-static-absence', 'not-prioritized'];
    const component = (name: string, reachability?: DependencyReachability): DependencyInventory['components'][number] => ({
      name,
      version: '1.0.0',
      purl: `pkg:npm/${name}@1.0.0`,
      sourceFile: 'package-lock.json',
      location: `package-lock.json:node_modules/${name}`,
      relationship: 'direct',
      dependencies: [],
      declaredLicense: null,
      licenseExpression: null,
      licenseSource: 'unknown',
      licenseConfidence: 'unknown',
      policyStatus: 'review',
      ...(reachability ? { reachability } : {}),
    });
    const components = packageNames.map((name, index) => component(name, index < states.length ? reachabilityFor(states[index] ?? 'unknown') : undefined));
    const findings: AssessmentFinding[] = states.map((state, index) => {
      const name = packageNames[index] ?? 'missing-package';
      const packageReachability = reachabilityFor(state);
      return {
        id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        ruleId: `osv.GHSA-000${index}`,
        correlationKey: `npm:${name}:GHSA-000${index}`,
        origin: 'internal',
        title: `Advisory match: ${name}`,
        location: `package-lock.json:node_modules/${name}`,
        description: 'Test advisory.',
        severity: 'unknown',
        confidence: 'observed',
        exploitability: 'unknown',
        impact: 'Test advisory.',
        recommendation: 'Review the package.',
        limitations: ['Test fixture.'],
        evidenceIds: ['40000000-0000-4000-8000-000000000001'],
        dependencyAssessment: { name, version: '1.0.0', purl: `pkg:npm/${name}@1.0.0`, reachability: packageReachability, artifactStatus: 'not_requested' },
      };
    });
    const inventory: DependencyInventory = {
      components,
      lockfiles: [{ sourceFile: 'package-lock.json', format: 'npm-v3', state: 'inspected', packageCount: components.length }],
      policy: { allow: [], deny: [], review: [] },
      complete: true,
      graphComplete: true,
      unknownCount: 0,
    };

    const markup = renderToStaticMarkup(createElement(DependencyInventoryPanel, {
      inventory, findings, busy: false, error: null, onDownload: () => undefined,
    }));

    expect(markup.indexOf('priority-reachable')).toBeLessThan(markup.indexOf('priority-imported'));
    expect(markup.indexOf('priority-imported')).toBeLessThan(markup.indexOf('priority-unknown'));
    expect(markup.indexOf('priority-unknown')).toBeLessThan(markup.indexOf('priority-static-absence'));
    expect(markup.indexOf('priority-static-absence')).toBeLessThan(markup.indexOf('not-prioritized'));
    expect(markup).toContain('Sin aviso relacionado');
    expect(markup).toContain('Sin importación estática');
    expect(markup).toContain('Alcance estático');
  });

  it('keeps malformed response excerpts in a safe state without rendering raw data', () => {
    const external = analysis('external');
    external.evidence.push({
      id: externalFindingId,
      origin: 'external',
      kind: 'http_response',
      locator: 'https://app.example.test/',
      collectedAt: timestamp,
      snapshotRef: 'target:authorized:root',
      tool: { name: 'node:https', version: '24' },
      checksum,
      excerpt: '<script>alert(1)</script>',
    });

    const markup = renderToStaticMarkup(createElement(ExternalHttpsEvidence, { analysis: external }));
    expect(markup).toContain('No fue posible interpretar el resumen');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('alert(1)');
  });
});
