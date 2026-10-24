import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AssessmentAnalysis, AssessmentComparison } from '@gotchu/contracts';
import { ComparisonPresence, ComparisonSummary, ComparisonVerification, ExternalHttpsEvidence } from '../src/components/customer-report-components.js';
import { comparisonCounts, comparisonPresence, comparisonVerification, coverageCapabilityLabel, exploitabilityLabel, perspectiveStatus, reportInputLabel } from '../src/components/customer-report-model.js';

const timestamp = '2026-10-24T12:00:00.000Z';
const checksum = 'a'.repeat(64);
const internalFindingId = '10000000-0000-4000-8000-000000000001';
const externalFindingId = '20000000-0000-4000-8000-000000000002';

function analysis(origin: 'internal' | 'external', status: AssessmentAnalysis['status'] = 'completed'): AssessmentAnalysis {
  return { origin, status, startedAt: timestamp, finishedAt: timestamp, snapshotRef: `${origin}:snapshot`, tool: { name: 'fixture', version: '1' }, findings: [], evidence: [], coverage: [], limitations: [] };
}

describe('customer report presentation', () => {
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
