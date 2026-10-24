import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readArchiveFiles, validateInputArchive } from '@gotchu/runner';
import { scoreValidation, verifyValidationAttestation } from '@gotchu/backend';
import { sourceArchive } from '../src/archive.js';
import { loadValidatorKey, signAttestation } from '../src/keys.js';
import { suiteModifiedByCandidate } from '../src/validation-rules.js';
import type { ValidationEvidence } from '@gotchu/contracts';

const completeEvidence: ValidationEvidence[] = [
  { kind: 'base_reproduction', result: 'failed_for_target', exitCode: 1, durationMs: 20 },
  { kind: 'candidate_regression', result: 'passed', exitCode: 0, durationMs: 25 },
  { kind: 'functional_suite', suiteName: 'main', result: 'passed', counts: { passed: 3, failed: 0, skipped: 0 }, requiredCounts: 3 },
  { kind: 'independent_rescan', result: 'passed', before: { identities: ['tls-disabled'], coverage: 'complete' }, after: { identities: [], coverage: 'complete' }, targetedIdentities: ['tls-disabled'] },
];

describe('validator evidence rules', () => {
  it('passes only with reproduction, candidate, functional and complete rescan evidence', () => {
    expect(scoreValidation(completeEvidence)).toEqual({ state: 'passed', reason: null });
    expect(scoreValidation(completeEvidence.map(item => item.kind === 'independent_rescan' ? { ...item, after: { identities: [], coverage: 'partial' } } : item))).toMatchObject({ state: 'inconclusive', reason: 'rescan_coverage_unknown' });
    expect(scoreValidation(completeEvidence.map(item => item.kind === 'functional_suite' ? { ...item, counts: { passed: 0, failed: 0, skipped: 3 } } : item))).toMatchObject({ state: 'failed', reason: 'functional_suite_failed' });
    expect(scoreValidation(completeEvidence.map(item => item.kind === 'independent_rescan' ? { ...item, after: { identities: ['new-finding'], coverage: 'complete' } } : item))).toMatchObject({ state: 'failed', reason: 'new_findings' });
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
      expect(await readFile(path, 'utf8')).toContain('PRIVATE KEY');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses candidate edits to the configured script or any test file', () => {
    const base = { revision: 'base', files: [
      { path: 'package.json', content: '{"scripts":{"test":"node test/run.js"}}' },
      { path: 'test/run.js', content: 'assert(true)' },
      { path: 'src/feature.js', content: 'module.exports = true' },
    ] };
    const config = { scriptName: 'test', regressionTestPath: 'test/run.js' };
    expect(suiteModifiedByCandidate(base, base, config)).toBe(false);
    expect(suiteModifiedByCandidate(base, { ...base, files: base.files.map(file => file.path === 'test/run.js' ? { ...file, content: 'process.exit(0)' } : file) }, config)).toBe(true);
    expect(suiteModifiedByCandidate(base, { ...base, files: base.files.map(file => file.path === 'package.json' ? { ...file, content: '{"scripts":{"test":"true"}}' } : file) }, config)).toBe(true);
  });
});
