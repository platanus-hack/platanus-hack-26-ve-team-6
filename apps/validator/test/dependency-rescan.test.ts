import { describe, expect, it } from 'vitest';
import type { CustomerAssessmentReport, DependencyRescanArtifactResult } from '@gotchu/contracts';
import { buildDependencyRescanScope, type BuildDependencyRescanScopeInput } from '../src/dependency-rescan.js';

const sourceId = '33333333-3333-4333-8333-333333333333';
function report(version: string, digest: string): CustomerAssessmentReport {
  const time = '2026-10-25T00:00:00.000Z';
  return {
    version: 2, id: sourceId, jobId: sourceId, organizationId: '11111111-1111-4111-8111-111111111111', applicationId: '22222222-2222-4222-8222-222222222222', applicationName: 'Controlled fixture', mode: 'internal',
    startedAt: time, finishedAt: time, subject: { sourceSnapshotId: sourceId, sourceDigest: digest, targetId: null, targetVersion: null, origin: null },
    external: null, comparison: [], limitations: ['Fixture only; not evidence of a scan.'], responseMode: 'observation', actionsPerformed: [],
    internal: {
      origin: 'internal', status: 'partial', startedAt: time, finishedAt: time, snapshotRef: `source:${sourceId}:sha256:${digest}`, tool: { name: 'fixture', version: '1' }, findings: [], evidence: [], limitations: [],
      dependencyInventory: {
        complete: true, graphComplete: false, unknownCount: 0, policy: { allow: [], deny: [], review: [] },
        lockfiles: [{ sourceFile: 'package-lock.json', format: 'npm-v3', state: 'inspected', packageCount: 1 }],
        components: [{ name: 'example', version, purl: `pkg:npm/example@${version}`, sourceFile: 'package-lock.json', location: 'node_modules/example', relationship: 'direct', dependencies: [], declaredLicense: 'MIT', licenseExpression: 'MIT', licenseSource: 'lockfile', licenseConfidence: 'declared', policyStatus: 'allowed' }],
      },
      coverage: [
        ...['semgrep', 'gitleaks', 'dependency_inventory', 'dependency_advisories', 'license_metadata', 'dependency_artifact_analysis'].map(capability => ({ capability, state: 'inspected' as const, detail: 'Controlled fixture only.' })),
        ...['trivy_kubernetes', 'trivy_terraform', 'trivy_dockerfile'].map(capability => ({ capability, state: 'unsupported' as const, detail: 'No se encontraron candidatos para este perfil.' })),
        { capability: 'trivy', state: 'unsupported', detail: 'No se encontraron candidatos Kubernetes, Terraform ni Dockerfile.' },
        { capability: 'dependency_reachability', state: 'unavailable', detail: 'A TypeScript compiler AST inspected supported JavaScript/TypeScript import, require, literal dynamic import and re-export syntax. Static non-matches are not proof of unreachability.' },
      ],
    },
  };
}
function artifact(version: string): DependencyRescanArtifactResult {
  return { name: 'example', version, analysis: {
    status: 'verified', integrity: 'verified', artifactSha256: 'c'.repeat(64), extractedFileCount: 10, scannedFileCount: 5,
    tools: (['semgrep', 'gitleaks'] as const).map(name => ({ name, version: '1', image: 'fixture-only', profileChecksum: 'd'.repeat(64) })),
    findings: [], limitation: ['Fixture only; not evidence of an artifact download.'],
  } };
}
function fixture() {
  return {
    beforeReport: report('1.0.0', 'a'.repeat(64)), afterReport: report('1.0.1', 'b'.repeat(64)),
    baseSnapshotDigest: 'a'.repeat(64), candidateSnapshotDigest: 'b'.repeat(64),
    artifactScope: { before: [{ name: 'example', version: '1.0.0' }], after: [{ name: 'example', version: '1.0.1' }] },
    artifactResults: { before: [artifact('1.0.0')], after: [artifact('1.0.1')] },
  } satisfies BuildDependencyRescanScopeInput;
}

describe('independent dependency scope projection', () => {
  it('preserves partial reports and original capability evidence without mutating inputs', () => {
    const input = fixture(); const original = structuredClone(input);
    const result = buildDependencyRescanScope(input);
    expect(result.result).toBe('passed');
    expect(result.scope?.beforeAnalysis.status).toBe('partial');
    expect(result.scope?.beforeCapabilities).toEqual(input.beforeReport.internal?.coverage);
    expect(result.scope?.afterCapabilities).toEqual(input.afterReport.internal?.coverage);
    expect(input).toEqual(original);
  });

  it('rejects report subject, analysis snapshot, tenant, and application substitutions', () => {
    const input = fixture();
    expect(buildDependencyRescanScope({ ...input, candidateSnapshotDigest: 'e'.repeat(64) }).reason).toBe('dependency_rescan_snapshot_mismatch');
    for (const key of ['organizationId', 'applicationId'] as const) {
      const swapped = fixture(); swapped.afterReport[key] = sourceId;
      expect(buildDependencyRescanScope(swapped).reason).toBe('dependency_rescan_report_invalid');
    }
    const swapped = fixture();
    if (!swapped.afterReport.internal) throw new Error('fixture analysis missing');
    swapped.afterReport.internal.snapshotRef = `source:${sourceId}:sha256:${input.baseSnapshotDigest}`;
    expect(buildDependencyRescanScope(swapped).reason).toBe('dependency_rescan_snapshot_mismatch');
    expect(buildDependencyRescanScope({ ...input, beforeReport: {} }).reason).toBe('dependency_rescan_report_invalid');
  });

  it('does not fabricate a missing capability or a missing replacement result', () => {
    const input = fixture();
    if (!input.afterReport.internal) throw new Error('fixture analysis missing');
    input.afterReport.internal.coverage = input.afterReport.internal.coverage.filter(entry => entry.capability !== 'trivy_terraform');
    expect(buildDependencyRescanScope(input).result).toBe('inconclusive');
    const missing = fixture(); missing.artifactResults.after = [];
    expect(buildDependencyRescanScope(missing).reason).toBe('dependency_rescan_artifacts_unknown');
  });

  it('rejects artifacts outside the snapshot inventory and artifact outcomes for the wrong version', () => {
    const input = fixture(); input.artifactScope.after = [{ name: 'example', version: '9.0.0' }];
    expect(buildDependencyRescanScope(input).reason).toBe('dependency_rescan_package_missing');
    const wrong = fixture(); wrong.artifactResults.after = [artifact('1.0.0')];
    expect(buildDependencyRescanScope(wrong).reason).toBe('dependency_rescan_artifacts_unknown');
  });

  it('retains incomplete inventory as inconclusive evidence', () => {
    const input = fixture(); const inventory = input.afterReport.internal?.dependencyInventory;
    if (!inventory) throw new Error('fixture inventory missing');
    inventory.complete = false; inventory.unknownCount = 1;
    expect(buildDependencyRescanScope(input)).toMatchObject({ result: 'inconclusive', reason: 'dependency_rescan_coverage_unknown', scope: { afterAnalysis: { inventory: { complete: false } } } });
  });
});
