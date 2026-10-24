import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AssessmentAnalysis, AssessmentComparison, AssessmentFinding, DependencyInventory, DependencyReachability } from '@gotchu/contracts';
import { ComparisonPresence, ComparisonSummary, ComparisonVerification, ExternalHttpsEvidence } from '../src/components/customer-report-components.js';
import { DependencyInventoryPanel } from '../src/components/customer-supply-chain.js';
import { comparisonCounts, comparisonPresence, comparisonVerification, coverageCapabilityLabel, exploitabilityLabel, perspectiveStatus, reportInputLabel } from '../src/components/customer-report-model.js';

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

  it('shows HTTPS evidence from a clean report with no findings', () => {
    const external = analysis('external');
    external.evidence.push({
      id: externalFindingId,
      origin: 'external',
      kind: 'http_response',
      locator: 'https://app.example.test/',
      collectedAt: timestamp,
      snapshotRef: 'target:verified:root',
      tool: { name: 'node:https', version: '24' },
      checksum,
      excerpt: JSON.stringify({ status: 200, tlsVerified: true, headers: { 'content-type': 'text/html', 'strict-transport-security': 'max-age=31536000' }, incomplete: null, targetId: 'hidden-report-field' }),
    });

    const markup = renderToStaticMarkup(createElement(ExternalHttpsEvidence, { analysis: external }));
    expect(external.findings).toHaveLength(0);
    expect(markup).toContain('https://app.example.test/');
    expect(markup).toContain('HTTP 200');
    expect(markup).toContain('TLS verificado');
    expect(markup).toContain('Respuesta completa');
    expect(markup).toContain('strict-transport-security');
    expect(markup).toContain(checksum);
    expect(markup).toContain('node:https');
    expect(markup).toContain('24 oct 2026');
    expect(markup).not.toContain('hidden-report-field');
  });

  it('keeps malformed response excerpts in a safe state without rendering raw data', () => {
    const external = analysis('external');
    external.evidence.push({
      id: externalFindingId,
      origin: 'external',
      kind: 'http_response',
      locator: 'https://app.example.test/',
      collectedAt: timestamp,
      snapshotRef: 'target:verified:root',
      tool: { name: 'node:https', version: '24' },
      checksum,
      excerpt: '<script>alert(1)</script>',
    });

    const markup = renderToStaticMarkup(createElement(ExternalHttpsEvidence, { analysis: external }));
    expect(markup).toContain('No fue posible interpretar el resumen');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('alert(1)');
  });

  it('separates comparison presence from verification and reports perspective availability', () => {
    const comparison: AssessmentComparison = {
      key: 'same-rule',
      classification: 'both',
      internalFindingIds: [internalFindingId],
      externalFindingIds: [externalFindingId],
      explanation: 'Agrupación por regla; el despliegue equivalente no está verificado.',
    };
    expect(comparisonCounts([comparison])).toEqual({ internal: 1, external: 1, matched: 1 });
    expect(comparisonPresence(comparison)).toBe('Código + HTTPS');
    expect(comparisonVerification(comparison.classification)).toBe('Agrupadas por regla');

    const matchingMarkup = renderToStaticMarkup(createElement('div', null,
      createElement(ComparisonPresence, { item: comparison }),
      createElement(ComparisonVerification, { item: comparison }),
    ));
    expect(matchingMarkup).toContain('Código + HTTPS');
    expect(matchingMarkup).toContain('Agrupadas por regla');

    const unverified = { ...comparison, classification: 'unverified' as const, externalFindingIds: [] };
    expect(comparisonPresence(unverified)).toBe('Código');
    expect(comparisonVerification(unverified.classification)).toBe('Sin contraste verificado');
    const unavailable = analysis('external', 'unavailable');
    const summaryMarkup = renderToStaticMarkup(createElement(ComparisonSummary, {
      comparisons: [unverified],
      internal: analysis('internal'),
      external: unavailable,
    }));
    expect(summaryMarkup).toContain('Código <strong>1</strong>');
    expect(summaryMarkup).toContain('HTTPS <strong>0</strong>');
    expect(summaryMarkup).toContain('Código Evaluada · HTTPS No disponible');
    expect(perspectiveStatus(null)).toBe('No solicitada');
    expect(perspectiveStatus(analysis('external', 'partial'))).toBe('Parcial');
    const notRequestedMarkup = renderToStaticMarkup(createElement(ComparisonSummary, {
      comparisons: [unverified],
      internal: analysis('internal'),
      external: null,
    }));
    expect(notRequestedMarkup).toContain('Código Evaluada · HTTPS No solicitada');
  });

  it('labels unknown, not demonstrated, and fixture exploitability distinctly', () => {
    expect(exploitabilityLabel('unknown')).toBe('Desconocida');
    expect(exploitabilityLabel('not_demonstrated')).toBe('No demostrada');
    expect(exploitabilityLabel('demonstrated_in_fixture')).toContain('fixture');
  });
  it('labels image reports and shows the profile coverage without turning unknown into clean', () => {
    expect(reportInputLabel({ mode: 'internal', subject: { sourceSnapshotId: null, sourceDigest: null, targetId: null, targetVersion: null, origin: null, containerImageId: null, containerImageDigest: 'a'.repeat(64), containerImageReference: null } })).toBe('Imagen de contenedor');
    expect(coverageCapabilityLabel('container_image_os_cves')).toContain('CVE de paquetes del sistema operativo');
    expect(coverageCapabilityLabel('container_image_language_cves')).toContain('CVE de paquetes de lenguaje');
    expect(coverageCapabilityLabel('container_image_java_cves')).toContain('cobertura desconocida');
    expect(coverageCapabilityLabel('capability_without_label')).toBe('capability_without_label');
  });
});
