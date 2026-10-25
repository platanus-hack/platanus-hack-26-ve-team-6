import { describe, expect, it } from 'vitest';
import { validationRunSchema, validationSuiteConfigSchema, validationSuiteDefinitionSchema, validationTestSelectionSchema } from '../src/validation.js';

const scope = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  applicationId: '00000000-0000-4000-8000-000000000002',
  repositoryLinkId: '00000000-0000-4000-8000-000000000003',
};
const suiteConfig = { ...scope, scriptName: 'test', suiteName: 'focused regressions', requiredCount: 1 };
const selection = { files: ['src/unit.test.ts', 'test/smoke.test.mts'], namePattern: 'keeps the selected behavior' };

describe('selected validation contracts', () => {
  it('keeps old suite configuration on the legacy profile by default', () => {
    expect(validationSuiteConfigSchema.parse(suiteConfig)).toMatchObject({ profile: 'node24-npm-test', testSelection: null });
    expect(validationSuiteDefinitionSchema.parse({
      id: '00000000-0000-4000-8000-000000000004', ...scope, version: 1, profile: 'node24-npm-test',
      scriptName: 'custom-test', suiteName: 'legacy', requiredCount: 1, regressionTestPath: null,
      createdAt: '2026-10-25T00:00:00.000Z',
    })).toMatchObject({ testSelection: null });
  });

  it('accepts only bounded, unique, repository-relative test file selections', () => {
    expect(validationTestSelectionSchema.parse(selection)).toEqual(selection);
    expect(validationTestSelectionSchema.parse({ files: ['src/component.spec.tsx'] }).files).toEqual(['src/component.spec.tsx']);
    for (const files of [
      [],
      Array.from({ length: 21 }, (_, index) => `test/${index}.test.js`),
      ['test/one.test.js', 'test/one.test.js'],
      ['/test/one.test.js'],
      ['test/../one.test.js'],
      ['test\\one.test.js'],
      ['test/one.spec.json'],
      ['node_modules/pkg/test/one.test.js'],
    ]) {
      expect(validationTestSelectionSchema.safeParse({ files }).success).toBe(false);
    }
    expect(validationTestSelectionSchema.safeParse({ files: ['test/one.test.ts'], namePattern: '' }).success).toBe(false);
    expect(validationTestSelectionSchema.safeParse({ files: ['test/one.test.ts'], namePattern: '[' }).success).toBe(false);
    expect(validationTestSelectionSchema.safeParse({ files: ['test/one.test.ts'], namePattern: 'test\nname' }).success).toBe(false);
    expect(validationTestSelectionSchema.safeParse({ files: ['test/one.test.ts'], extra: true }).success).toBe(false);
  });

  it('requires an explicit selection and fixed test script on selected definitions', () => {
    const definition = {
      id: '00000000-0000-4000-8000-000000000004', ...scope, version: 2,
      profile: 'node24-tsx-selected-v1', scriptName: 'test', suiteName: 'selected', requiredCount: 1,
      regressionTestPath: null, testSelection: selection, createdAt: '2026-10-25T00:00:00.000Z',
    };
    expect(validationSuiteDefinitionSchema.parse(definition)).toMatchObject({ profile: 'node24-tsx-selected-v1', testSelection: selection });
    expect(validationSuiteDefinitionSchema.safeParse({ ...definition, testSelection: null }).success).toBe(false);
    expect(validationSuiteDefinitionSchema.safeParse({ ...definition, scriptName: 'arbitrary-command' }).success).toBe(false);
    expect(validationSuiteDefinitionSchema.safeParse({ ...definition, profile: 'node24-npm-test' }).success).toBe(false);
  });

  it('recognizes selected runner profiles while preserving the nullable regression path', () => {
    const run = {
      id: '00000000-0000-4000-8000-000000000004', organizationId: scope.organizationId, applicationId: scope.applicationId,
      actionRef: '00000000-0000-4000-8000-000000000005', targetFindingId: '00000000-0000-4000-8000-000000000006',
      candidateSourceId: '00000000-0000-4000-8000-000000000007', baseSourceId: '00000000-0000-4000-8000-000000000008',
      baseSnapshotDigest: 'a'.repeat(64), candidateTreeDigest: 'b'.repeat(64), patchDigest: 'c'.repeat(64),
      suiteRepositoryLinkId: scope.repositoryLinkId, suiteDefinitionId: '00000000-0000-4000-8000-000000000009', suiteVersion: 2,
      runnerProfile: 'node24-tsx-selected-v1', runnerDigest: null, firecrackerDigest: null, kernelDigest: null, rootfsDigest: null,
      sandboxKind: 'bwrap+systemd-scope', limits: { vcpu: 1, memMiB: 1024, pids: 128, wallMs: 120_000, outputBytes: 262_144, diskMiB: 2048 },
      state: 'queued', reason: null, queuedAt: '2026-10-25T00:00:00.000Z', startedAt: null, finishedAt: null,
      expiresAt: '2026-11-01T00:00:00.000Z',
    };
    expect(validationRunSchema.parse(run).runnerProfile).toBe('node24-tsx-selected-v1');
    expect(validationRunSchema.parse(run).containerImageDigest).toBeNull();
    expect(validationRunSchema.parse({ ...run, sandboxKind: 'docker', containerImageDigest: 'd'.repeat(64) }))
      .toMatchObject({ sandboxKind: 'docker', containerImageDigest: 'd'.repeat(64), rootfsDigest: null });
    expect(validationRunSchema.safeParse({ ...run, sandboxKind: 'docker', containerImageDigest: 'sha256:' + 'd'.repeat(64) }).success).toBe(false);
  });
});
