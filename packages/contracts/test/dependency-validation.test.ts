import { describe, expect, it } from 'vitest';
import {
  dependencyRescanScopeSchema, scoreDependencyRescanCoverage, suiteBindingSchema,
  type DependencyRescanScope,
} from '../src/dependency-validation.js';

function fixture(): DependencyRescanScope {
  const capabilities: DependencyRescanScope['beforeCapabilities'] = [
    ...['semgrep', 'gitleaks', 'dependency_inventory', 'dependency_advisories', 'license_metadata', 'dependency_artifact_analysis'].map(capability => ({ capability, state: 'inspected' as const, detail: 'Controlled fixture only.' })),
    ...['trivy_kubernetes', 'trivy_terraform', 'trivy_dockerfile'].map(capability => ({ capability, state: 'unsupported' as const, detail: 'No se encontraron candidatos para este perfil.' })),
    { capability: 'trivy', state: 'unsupported', detail: 'No se encontraron candidatos Kubernetes, Terraform ni Dockerfile.' },
    { capability: 'dependency_reachability', state: 'unavailable', detail: 'A TypeScript compiler AST inspected supported JavaScript/TypeScript import, require, literal dynamic import and re-export syntax. Static non-matches are not proof of unreachability.' },
  ];
  const analysis: DependencyRescanScope['beforeAnalysis'] = {
    status: 'partial', findingCount: 1, evidenceCount: 3,
    inventory: { complete: true, graphComplete: false, unknownCount: 0, lockfiles: [{ sourceFile: 'package-lock.json', format: 'npm-v3', state: 'inspected', packageCount: 1 }] },
  };
  const artifact: DependencyRescanScope['artifactResults']['before'][number]['analysis'] = {
    status: 'verified', integrity: 'verified', artifactSha256: 'c'.repeat(64), extractedFileCount: 10, scannedFileCount: 5,
    tools: (['semgrep', 'gitleaks'] as const).map(name => ({ name, version: '1', image: 'fixture-only', profileChecksum: 'd'.repeat(64) })), findings: [], limitation: ['Fixture only; no live scan.'],
  };
  return {
    coverageScope: 'dependency_rescan_v1', baseSnapshotDigest: 'a'.repeat(64), candidateSnapshotDigest: 'b'.repeat(64),
    beforeCapabilities: capabilities, afterCapabilities: structuredClone(capabilities), beforeAnalysis: analysis, afterAnalysis: structuredClone(analysis),
    artifactScope: { before: [{ name: 'example', version: '1.0.0' }], after: [{ name: 'example', version: '1.0.1' }] },
    artifactResults: { before: [{ name: 'example', version: '1.0.0', analysis: artifact }], after: [{ name: 'example', version: '1.0.1', analysis: structuredClone(artifact) }] },
  };
}

describe('dependency rescan coverage policy', () => {
  it('permits only scoped coverage while preserving unknown reachability and graph coverage', () => {
    const scope = fixture(); const original = structuredClone(scope);
    expect(scoreDependencyRescanCoverage(scope)).toEqual({ result: 'passed', reason: null });
    expect(scope).toEqual(original);
    expect(scope.beforeAnalysis.status).toBe('partial');
  });

  it('requires every capability on both sides and refuses duplicate or unrecognized capabilities', () => {
    for (const side of ['beforeCapabilities', 'afterCapabilities'] as const) {
      for (const entry of fixture()[side]) {
        const missing = fixture(); missing[side] = missing[side].filter(value => value.capability !== entry.capability);
        expect(scoreDependencyRescanCoverage(missing).result).toBe('inconclusive');
        const duplicate = fixture(); duplicate[side].push({ ...entry, state: 'unavailable' });
        expect(scoreDependencyRescanCoverage(duplicate).result).toBe('inconclusive');
      }
      const extra = fixture(); extra[side].push({ capability: 'new_unknown_profile', state: 'inspected', detail: 'Not defined in v1.' });
      expect(scoreDependencyRescanCoverage(extra).result).toBe('inconclusive');
    }
  });

  it('blocks every mandatory unknown and refuses invented no-input Trivy claims', () => {
    for (const capability of ['semgrep', 'gitleaks', 'dependency_inventory', 'dependency_advisories', 'license_metadata', 'dependency_artifact_analysis']) {
      for (const state of ['unavailable', 'unsupported', 'not_requested'] as const) {
        const scope = fixture(); scope.afterCapabilities = scope.afterCapabilities.map(entry => entry.capability === capability ? { ...entry, state } : entry);
        expect(scoreDependencyRescanCoverage(scope).result).toBe('inconclusive');
      }
    }
    for (const capability of ['trivy', 'trivy_kubernetes', 'trivy_terraform', 'trivy_dockerfile']) {
      const scope = fixture(); scope.afterCapabilities = scope.afterCapabilities.map(entry => entry.capability === capability ? { ...entry, detail: 'Probably not applicable.' } : entry);
      expect(scoreDependencyRescanCoverage(scope).result).toBe('inconclusive');
    }
    const contradictory = fixture(); contradictory.afterCapabilities = contradictory.afterCapabilities.map(entry => entry.capability === 'trivy_kubernetes' ? { ...entry, state: 'inspected' } : entry);
    expect(scoreDependencyRescanCoverage(contradictory).result).toBe('inconclusive');
  });

  it('requires the replacement artifact even when its advisory-selected analysis was not requested', () => {
    const scope = fixture(); scope.afterCapabilities = scope.afterCapabilities.map(entry => entry.capability === 'dependency_artifact_analysis'
      ? { ...entry, state: 'not_requested', detail: 'Exact package artifact analysis was not requested because OSV returned no advisory match.' } : entry);
    expect(scoreDependencyRescanCoverage(scope).result).toBe('passed');
    scope.artifactResults.after = [];
    expect(scoreDependencyRescanCoverage(scope)).toMatchObject({ result: 'inconclusive', reason: 'dependency_rescan_artifacts_unknown' });
  });

  it('rejects incomplete inventory, saturated report bounds and missing inventory', () => {
    for (const side of ['beforeAnalysis', 'afterAnalysis'] as const) {
      for (const patch of [{ complete: false }, { unknownCount: 1 }, { lockfiles: [] }]) {
        const scope = fixture(); const inventory = scope[side].inventory;
        if (!inventory) throw new Error('fixture inventory missing');
        scope[side].inventory = { ...inventory, ...patch };
        expect(scoreDependencyRescanCoverage(scope).result).toBe('inconclusive');
      }
      for (const patch of [{ findingCount: 100 }, { evidenceCount: 200 }, { inventory: null }]) {
        const scope = fixture(); scope[side] = { ...scope[side], ...patch };
        expect(scoreDependencyRescanCoverage(scope).result).toBe('inconclusive');
      }
    }
  });

  it('rejects substituted, duplicate, unverified, empty, and incompletely scanned artifacts', () => {
    const patches: Partial<DependencyRescanScope['artifactResults']['before'][number]['analysis']>[] = [
      { status: 'scan_incomplete' }, { integrity: 'missing' }, { artifactSha256: null }, { scannedFileCount: 0 }, { extractedFileCount: 0 }, { tools: [] },
    ];
    for (const side of ['before', 'after'] as const) {
      for (const patch of patches) {
        const scope = fixture(); scope.artifactResults[side] = scope.artifactResults[side].map(entry => ({ ...entry, analysis: { ...entry.analysis, ...patch } }));
        expect(scoreDependencyRescanCoverage(scope).result).toBe('inconclusive');
      }
      const wrong = fixture(); wrong.artifactResults[side] = wrong.artifactResults[side].map(entry => ({ ...entry, version: '9.0.0' }));
      expect(scoreDependencyRescanCoverage(wrong).result).toBe('inconclusive');
      const duplicate = fixture(); duplicate.artifactResults[side].push(...duplicate.artifactResults[side]);
      expect(dependencyRescanScopeSchema.safeParse(duplicate).success).toBe(false);
    }
  });
});

describe('selected suite binding', () => {
  const binding = { repositoryLinkId: '11111111-1111-4111-8111-111111111111', suiteDefinitionId: '22222222-2222-4222-8222-222222222222', suiteVersion: 1, profile: 'node24-tsx-selected-v1', testSelection: { files: ['test/security.test.ts'] }, selectionDigest: 'a'.repeat(64) };
  it('accepts bounded selections and requires exact binding fields', () => {
    expect(suiteBindingSchema.safeParse(binding).success).toBe(true);
    for (const update of [{ suiteVersion: 0 }, { selectionDigest: 'bad' }, { profile: 'node24-npm-test' }, { command: 'npm test' }]) {
      expect(suiteBindingSchema.safeParse({ ...binding, ...update }).success).toBe(false);
    }
  });
  it('rejects traversal, arguments, dependencies, duplicate files, oversized selections and invalid patterns', () => {
    for (const files of [[], ['../secret.test.ts'], ['/root/secret.test.ts'], ['--import=hook.test.ts'], ['node_modules/pkg/a.test.ts'], ['test/a.test.ts', 'test/a.test.ts'], Array.from({ length: 21 }, (_, index) => `test/${index}.test.ts`)]) {
      expect(suiteBindingSchema.safeParse({ ...binding, testSelection: { files } }).success).toBe(false);
    }
    for (const namePattern of ['[', '\n', 'x'.repeat(257)]) {
      expect(suiteBindingSchema.safeParse({ ...binding, testSelection: { ...binding.testSelection, namePattern } }).success).toBe(false);
    }
  });
});
