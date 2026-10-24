import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readArchiveFiles, validateInputArchive } from '@gotchu/runner';
import { scoreIndependentRescan } from '@gotchu/contracts';
import { scoreValidation, verifyValidationAttestation } from '@gotchu/backend';
import { sourceArchive } from '../src/archive.js';
import { loadValidatorKey, signAttestation } from '../src/keys.js';
import { suiteModifiedByCandidate, validationAdmissionReason } from '../src/validation-rules.js';
import type { ValidationEvidence } from '@gotchu/contracts';

const completeEvidence: ValidationEvidence[] = [
  { kind: 'base_reproduction', result: 'failed_for_target', exitCode: 1, durationMs: 20 },
  { kind: 'candidate_regression', result: 'passed', exitCode: 0, durationMs: 25 },
  { kind: 'functional_suite', suiteName: 'main', result: 'passed', counts: { passed: 3, failed: 0, skipped: 0 }, baseCounts: { passed: 3, failed: 0, skipped: 0 }, requiredCounts: 3 },
  { kind: 'independent_rescan', result: 'passed', before: { identities: ['tls-disabled'], coverage: 'complete' }, after: { identities: [], coverage: 'complete' }, targetedIdentities: ['tls-disabled'] },
];

describe('validator evidence rules', () => {
  it('refuses validation before VM execution when approval, configuration, or gate checks fail', () => {
    const good = { suiteConfigured: true, baseDigestMatches: true, candidateDigestMatches: true, scriptName: 'test', gateOpen: true };
    expect(validationAdmissionReason(good)).toBeNull();
    expect(validationAdmissionReason({ ...good, suiteConfigured: false })).toBe('suite_not_configured');
    expect(validationAdmissionReason({ ...good, baseDigestMatches: false })).toBe('approved_base_digest_mismatch');
    expect(validationAdmissionReason({ ...good, candidateDigestMatches: false })).toBe('candidate_digest_mismatch');
    expect(validationAdmissionReason({ ...good, scriptName: 'test:unit' })).toBe('runner_profile_script_mismatch');
    expect(validationAdmissionReason({ ...good, gateOpen: false })).toBe('runner_gate_closed');
  });

  it('scores rescan identity, coverage, and target branches consistently', () => {
    expect(scoreIndependentRescan({ before: { identities: ['target'], coverage: 'complete' }, after: { identities: [], coverage: 'complete' }, targetedIdentities: ['target'] })).toEqual({ result: 'passed', reason: null });
    expect(scoreIndependentRescan({ before: { identities: ['target'], coverage: 'complete' }, after: { identities: ['target'], coverage: 'complete' }, targetedIdentities: ['target'] })).toMatchObject({ result: 'failed', reason: 'targeted_findings_remain' });
    expect(scoreIndependentRescan({ before: { identities: ['target'], coverage: 'complete' }, after: { identities: ['target', 'new'], coverage: 'complete' }, targetedIdentities: ['target'] })).toMatchObject({ result: 'failed', reason: 'new_findings' });
    expect(scoreIndependentRescan({ before: { identities: ['target'], coverage: 'complete' }, after: { identities: [], coverage: 'partial' }, targetedIdentities: ['target'] })).toMatchObject({ result: 'inconclusive', reason: 'rescan_coverage_unknown' });
    expect(scoreIndependentRescan({ before: { identities: [], coverage: 'complete' }, after: { identities: [], coverage: 'complete' }, targetedIdentities: [] })).toMatchObject({ result: 'inconclusive', reason: 'target_identity_missing' });
  });

  it('scores every validation outcome and rejects a shrinking or newly skipped suite', () => {
    expect(scoreValidation(completeEvidence)).toEqual({ state: 'passed', reason: null });
    expect(scoreValidation([])).toMatchObject({ state: 'inconclusive', reason: 'required_evidence_missing' });
    const baseWith = (result: 'passed' | 'unavailable') => completeEvidence.map(item => item.kind === 'base_reproduction' ? { ...item, result } : item);
    expect(scoreValidation(baseWith('passed'))).toMatchObject({ state: 'inconclusive', reason: 'base_reproduction_not_confirmed' });
    expect(scoreValidation(baseWith('unavailable'))).toMatchObject({ state: 'inconclusive', reason: 'base_reproduction_not_confirmed' });
    const suiteWith = (update: (item: Extract<ValidationEvidence, { kind: 'functional_suite' }>) => Extract<ValidationEvidence, { kind: 'functional_suite' }>) => completeEvidence.map(item => item.kind === 'functional_suite' ? update(item) : item);
    expect(scoreValidation(suiteWith(item => ({ ...item, counts: { passed: 2, failed: 0, skipped: 0 } })))).toMatchObject({ state: 'failed', reason: 'suite_shrank' });
    expect(scoreValidation(suiteWith(item => ({ ...item, counts: { passed: 3, failed: 0, skipped: 1 } })))).toMatchObject({ state: 'failed', reason: 'suite_shrank' });
    expect(scoreValidation(suiteWith(item => ({ ...item, counts: { passed: 0, failed: 0, skipped: 0 } })))).toMatchObject({ state: 'failed', reason: 'suite_shrank' });
    expect(scoreValidation(suiteWith(item => ({ ...item, counts: { passed: 0, failed: 0, skipped: 3 } })))).toMatchObject({ state: 'failed' });
    expect(scoreValidation(suiteWith(item => ({ ...item, counts: { passed: 0, failed: 0, skipped: 0 }, baseCounts: undefined })))).toMatchObject({ state: 'failed', reason: 'functional_suite_failed' });
    expect(scoreValidation(suiteWith(item => ({ ...item, result: 'failed' })))).toMatchObject({ state: 'failed', reason: 'functional_suite_failed' });
    expect(scoreValidation(suiteWith(item => ({ ...item, result: 'inconclusive' })))).toMatchObject({ state: 'inconclusive', reason: 'required_test_not_passed' });
    const regressionFailed = completeEvidence.map(item => item.kind === 'candidate_regression' ? { ...item, result: 'failed' as const } : item);
    expect(scoreValidation(regressionFailed)).toMatchObject({ state: 'failed', reason: 'candidate_regression_failed' });
    expect(scoreValidation(completeEvidence.map(item => item.kind === 'independent_rescan' ? { ...item, after: { identities: ['new-finding'], coverage: 'complete' } } : item))).toMatchObject({ state: 'failed', reason: 'new_findings' });
    expect(scoreValidation(completeEvidence.map(item => item.kind === 'independent_rescan' ? { ...item, after: { identities: ['tls-disabled'], coverage: 'complete' } } : item))).toMatchObject({ state: 'failed', reason: 'targeted_findings_remain' });
    expect(scoreValidation(completeEvidence.map(item => item.kind === 'independent_rescan' ? { ...item, after: { identities: [], coverage: 'partial' } } : item))).toMatchObject({ state: 'inconclusive', reason: 'rescan_coverage_unknown' });
    expect(scoreValidation(completeEvidence.map(item => item.kind === 'independent_rescan' ? { ...item, targetedIdentities: [] } : item))).toMatchObject({ state: 'inconclusive', reason: 'target_identity_missing' });
    expect(scoreValidation(completeEvidence.map(item => item.kind === 'independent_rescan' ? { ...item, result: 'failed' as const } : item))).toMatchObject({ state: 'failed', reason: 'rescan_findings_changed' });
    expect(scoreValidation(completeEvidence.filter(item => item.kind !== 'base_reproduction'))).toMatchObject({ state: 'inconclusive', reason: 'base_reproduction_not_confirmed' });
  });

  it('builds a bounded runner archive and signs immutable attestation payloads', async () => {
    const archive = sourceArchive({ revision: 'base', files: [
      { path: 'package.json', content: '{"scripts":{"test":"node test.js"}}' },
      { path: 'package-lock.json', content: '{"lockfileVersion":3,"packages":{}}' },
      { path: 'test.js', content: 'process.exit(0)' },
    ] });
    const checked = validateInputArchive(archive.bytes);
    expect(readArchiveFiles(checked.tarBytes).get('test.js')?.toString()).toBe('process.exit(0)');

    const directory = await mkdtemp(join(tmpdir(), 'gotchu-validator-key-'));
    const path = join(directory, 'key.pem');
    try {
      const key = await loadValidatorKey(path);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const payload = { id: randomUUID(), organizationId: randomUUID(), applicationId: randomUUID(), runId: randomUUID(), actionRef: randomUUID(), evidence: completeEvidence[0]!, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
      const signed = signAttestation(payload, key);
      expect(verifyValidationAttestation(signed, key.publicKey)).toBe(true);
      expect(verifyValidationAttestation({ ...signed, payload: { ...signed.payload, actionRef: randomUUID() } }, key.publicKey)).toBe(false);
      const replacement = signed.signature[0] === 'A' ? 'B' : 'A';
      expect(verifyValidationAttestation({ ...signed, signature: `${replacement}${signed.signature.slice(1)}` }, key.publicKey)).toBe(false);
      expect(await readFile(path, 'utf8')).toContain('PRIVATE KEY');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses suite, runner, setup, and package changes', () => {
    const base = { revision: 'base', files: [
      { path: 'package.json', content: '{"scripts":{"test":"node test/run.js"}}' },
      { path: 'test/run.js', content: 'assert(true)' },
      { path: 'src/feature.js', content: 'module.exports = true' },
    ] };
    const config = { scriptName: 'test', regressionTestPath: 'test/run.js' };
    expect(suiteModifiedByCandidate(base, base, config)).toBe(false);
    const changed = (path: string, content: string) => ({ ...base, files: [...base.files.filter(file => file.path !== path), { path, content }] });
    for (const [path, content] of [
      ['test/run.js', 'process.exit(0)'], ['package.json', '{"scripts":{"test":"true"}}'],
      ['vitest.config.ts', 'export default { test: { include: [] } }'], ['vite.config.ts', 'export default { test: { include: [] } }'],
      ['jest.config.cjs', 'module.exports = { testPathIgnorePatterns: [".*"] }'], ['.mocharc.json', '{"spec":[]}'],
      ['ava.config.js', 'export default { files: [] }'], ['playwright.config.ts', 'export default { testDir: "none" }'],
      ['tsconfig.test.json', '{"include":[]}'], ['.npmrc', 'ignore-scripts=true'],
    ] as const) expect(suiteModifiedByCandidate(base, changed(path, content), config), path).toBe(true);
    const setupBase = { ...base, files: [...base.files, { path: 'vitest.config.ts', content: "export default { test: { setupFiles: ['./helpers/setup.ts'] } }" }, { path: 'helpers/setup.ts', content: 'assert(true)' }] };
    expect(suiteModifiedByCandidate(setupBase, { ...setupBase, files: setupBase.files.map(file => file.path === 'helpers/setup.ts' ? { ...file, content: 'process.exit(0)' } : file) }, config)).toBe(true);

    const scalarSetup = { ...base, files: [...base.files, { path: 'vitest.config.ts', content: "export default { test: { setupFiles: './helpers/setup.ts' } }" }, { path: 'helpers/setup.ts', content: 'assert(true)' }] };
    expect(suiteModifiedByCandidate(scalarSetup, scalarSetup, config)).toBe(false);
    expect(suiteModifiedByCandidate(scalarSetup, { ...scalarSetup, files: scalarSetup.files.map(file => file.path === 'helpers/setup.ts' ? { ...file, content: 'process.exit(0)' } : file) }, config)).toBe(true);

    const arraySetup = { ...base, files: [...base.files,
      { path: 'vitest.config.ts', content: "export default { test: { setupFiles: ['./helpers/first.ts', './helpers/second.ts'] } }" },
      { path: 'helpers/first.ts', content: 'assert(true)' }, { path: 'helpers/second.ts', content: 'assert(true)' },
    ] };
    expect(suiteModifiedByCandidate(arraySetup, { ...arraySetup, files: arraySetup.files.map(file => file.path === 'helpers/second.ts' ? { ...file, content: 'process.exit(0)' } : file) }, config)).toBe(true);

    const nestedSetup = { ...base, files: [...base.files,
      { path: 'config/vitest.config.ts', content: "export default { test: { setupFilesAfterEnv: '../helpers/setup.ts' } }" },
      { path: 'helpers/setup.ts', content: 'assert(true)' },
    ] };
    expect(suiteModifiedByCandidate(nestedSetup, { ...nestedSetup, files: nestedSetup.files.map(file => file.path === 'helpers/setup.ts' ? { ...file, content: 'process.exit(0)' } : file) }, config)).toBe(true);

    const quotedRootSetup = { ...base, files: [...base.files,
      { path: 'jest.config.json', content: '{"setupFiles":"./helpers/setup.ts"}' },
      { path: 'helpers/setup.ts', content: 'assert(true)' },
    ] };
    expect(suiteModifiedByCandidate(quotedRootSetup, quotedRootSetup, config)).toBe(false);
    expect(suiteModifiedByCandidate(quotedRootSetup, { ...quotedRootSetup, files: quotedRootSetup.files.map(file => file.path === 'helpers/setup.ts' ? { ...file, content: 'process.exit(0)' } : file) }, config)).toBe(true);

    const quotedNestedSetup = { ...base, files: [...base.files,
      { path: 'config/jest.config.json', content: '{"setupFilesAfterEnv":["../helpers/setup.ts"]}' },
      { path: 'helpers/setup.ts', content: 'assert(true)' },
    ] };
    expect(suiteModifiedByCandidate(quotedNestedSetup, quotedNestedSetup, config)).toBe(false);
    expect(suiteModifiedByCandidate(quotedNestedSetup, { ...quotedNestedSetup, files: quotedNestedSetup.files.map(file => file.path === 'helpers/setup.ts' ? { ...file, content: 'process.exit(0)' } : file) }, config)).toBe(true);
  });

  it('allows only explicitly targeted dependency version changes for dependency PRs', () => {
    const base = { revision: 'base', files: [{ path: 'package.json', content: '{"scripts":{"test":"node test/run.js"},"devDependencies":{"left-pad":"1.0.0","vitest":"3.2.4"}}' }, { path: 'package-lock.json', content: '{"lockfileVersion":3}' }, { path: 'test/run.js', content: 'assert(true)' }] };
    const candidate = { ...base, files: base.files.map(file => file.path === 'package.json' ? { ...file, content: '{"scripts":{"test":"node test/run.js"},"devDependencies":{"left-pad":"1.1.0","vitest":"3.2.4"}}' } : file).map(file => file.path === 'package-lock.json' ? { ...file, content: '{"lockfileVersion":3,"packages":{}}' } : file) };
    expect(suiteModifiedByCandidate(base, candidate, { scriptName: 'test', regressionTestPath: null, actionKind: 'dependency_pull_request', dependencyAllowlist: [{ name: 'left-pad', section: 'devDependencies', version: '1.1.0' }] })).toBe(false);
    expect(suiteModifiedByCandidate(base, candidate, { scriptName: 'test', regressionTestPath: null, actionKind: 'dependency_pull_request', dependencyAllowlist: [] })).toBe(true);
  });
});
