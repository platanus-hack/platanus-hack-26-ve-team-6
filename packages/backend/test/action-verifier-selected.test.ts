import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { validationAttestationPayloadSchema, type ActionV2, type DependencyRescanScope, type ValidationEvidence, type ValidationFacts } from '@gotchu/contracts';
import type { Database, Transaction } from '@gotchu/database';
import { describe, expect, it, vi } from 'vitest';
import { createActionVerifier } from '../src/action-verifier.js';
import { canonicalJson, sha256 } from '../src/core.js';
import { dependencyCommitMessage, expectedDependencyCommitSha } from '../src/git-commit.js';

function scopeFixture(): DependencyRescanScope {
  const capabilities: DependencyRescanScope['beforeCapabilities'] = [
    ...['semgrep', 'gitleaks', 'dependency_inventory', 'dependency_advisories', 'license_metadata', 'dependency_artifact_analysis'].map(capability => ({ capability, state: 'inspected' as const, detail: 'Synthetic fixture.' })),
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
    tools: (['semgrep', 'gitleaks'] as const).map(name => ({ name, version: '1', image: 'fixture-only', profileChecksum: 'd'.repeat(64) })), findings: [], limitation: ['Synthetic fixture; no live scan.'],
  };
  return {
    coverageScope: 'dependency_rescan_v1', baseSnapshotDigest: 'a'.repeat(64), candidateSnapshotDigest: 'b'.repeat(64),
    beforeCapabilities: capabilities, afterCapabilities: structuredClone(capabilities), beforeAnalysis: analysis, afterAnalysis: structuredClone(analysis),
    artifactScope: { before: [{ name: 'example', version: '1.0.0' }], after: [{ name: 'example', version: '1.0.1' }] },
    artifactResults: { before: [{ name: 'example', version: '1.0.0', analysis: artifact }], after: [{ name: 'example', version: '1.0.1', analysis: structuredClone(artifact) }] },
  };
}

function fixture() {
  const organizationId = randomUUID(); const applicationId = randomUUID(); const candidateId = randomUUID();
  const repositoryLinkId = randomUUID(); const runId = randomUUID(); const suiteId = randomUUID();
  const expiresAt = new Date(Date.now() + 60_000); const treeSha = 'c'.repeat(40); const baseCommit = 'a'.repeat(40);
  const selection = { files: ['test/security.test.ts'], namePattern: 'security' };
  const profile = 'node24-tsx-selected-v1';
  const suite: Extract<ValidationEvidence, { kind: 'functional_suite' }> = {
    kind: 'functional_suite', suiteName: 'Selected security tests', result: 'passed', requiredCounts: 1,
    counts: { passed: 1, failed: 0, skipped: 0 }, baseCounts: { passed: 1, failed: 0, skipped: 0 },
    suiteBinding: { repositoryLinkId, suiteDefinitionId: suiteId, suiteVersion: 1, profile, testSelection: selection,
      selectionDigest: sha256(canonicalJson({ profile, testSelection: selection })) },
  };
  const rescan: Extract<ValidationEvidence, { kind: 'independent_rescan' }> = {
    kind: 'independent_rescan', result: 'passed', before: { identities: ['npm:example:GHSA-test'], coverage: 'partial' },
    after: { identities: [], coverage: 'partial' }, targetedIdentities: ['npm:example:GHSA-test'], dependencyScope: scopeFixture(),
  };
  const evidence: ValidationEvidence[] = [
    { kind: 'base_reproduction', result: 'not_required', exitCode: null, durationMs: 0 },
    { kind: 'candidate_regression', result: 'passed', exitCode: 0, durationMs: 1 }, suite, rescan,
  ];
  const run = {
    organization_id: organizationId, application_id: applicationId, id: runId, action_ref: candidateId, candidate_source_id: candidateId,
    patch_digest: 'd'.repeat(64), candidate_tree_digest: 'b'.repeat(64), base_snapshot_digest: 'a'.repeat(64),
    validation_mode: 'dependency', state: 'passed', runner_profile: profile,
    suite_repository_link_id: repositoryLinkId, suite_definition_id: suiteId, suite_version: 1,
    sandbox_kind: 'jailer', rootfs_digest: 'e'.repeat(64), cleanup_verified: true, expires_at: expiresAt,
  };
  const definition = {
    organization_id: organizationId, application_id: applicationId, repository_link_id: repositoryLinkId, id: suiteId, version: 1,
    profile, script_name: 'test', suite_name: suite.suiteName, required_count: 1, regression_test_path: null,
    test_selection: structuredClone(selection), created_at: new Date(),
  };
  const commitMessage = dependencyCommitMessage({ packageName: 'example', fromVersion: '1.0.0', toVersion: '1.0.1' });
  const action: Extract<ActionV2, { kind: 'dependency_pull_request' }> = {
    version: 2, organizationId, applicationId, policyVersion: 'v1', kind: 'dependency_pull_request', capabilityId: 'repository.dependency_pr',
    target: { kind: 'repository', repositoryLinkId, repositoryKey: 'gh-fixture', branch: 'main' },
    evidence: [{ id: candidateId, sha256: 'b'.repeat(64), kind: 'dependency_candidate' }], baseCommit,
    candidateCommit: expectedDependencyCommitSha(treeSha, baseCommit, commitMessage), changes: [{ name: 'example', from: '1.0.0', to: '1.0.1' }],
    advisoryIds: ['GHSA-test'], lockfileSha256: 'f'.repeat(64), patchSha256: 'd'.repeat(64), rescanAttestationId: randomUUID(), suiteAttestationId: randomUUID(),
  };
  const metadata = {
    candidate_source_id: candidateId, repository_link_id: repositoryLinkId, base_commit: baseCommit, base_digest: 'a'.repeat(64),
    package_name: 'example', from_version: '1.0.0', to_version: '1.0.1', advisory_ids: action.advisoryIds,
    lockfile_sha256: action.lockfileSha256, patch_sha256: action.patchSha256, candidate_digest: 'b'.repeat(64), validation_run_id: runId,
    source_digest: 'b'.repeat(64), source_deleted_at: null, bound_repository_link_id: repositoryLinkId, binding_commit: baseCommit,
    binding_digest: 'a'.repeat(64), validation_state: 'passed', validation_mode: 'dependency', tree_sha: treeSha, commit_message: commitMessage, tree_complete: true,
  };
  let missingDefinition = false;
  const transaction: Transaction = { query: async () => { throw new Error('unexpected query'); } };
  const query = vi.spyOn(transaction, 'query');
  const database: Database = {
    role: 'gotchu_api', tenant: async (id, work) => { expect(id).toBe(organizationId); return work(transaction); },
    integration: async () => { throw new Error('unexpected integration access'); }, system: async () => { throw new Error('unexpected system access'); },
    checkHealth: async () => {}, close: async () => {},
  };
  const key = generateKeyPairSync('ed25519');
  const keyId = sha256(key.publicKey.export({ type: 'spki', format: 'der' }));
  const facts: ValidationFacts = { actionRef: candidateId, runId, state: 'passed', attestations: [], keys: [{ keyId, publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] };
  const verifier = createActionVerifier({ database, pinnedRootfsDigest: 'e'.repeat(64), validationFacts: { getFacts: async () => facts },
    repository: { readHead: async () => baseCommit, isPolicyCurrent: async () => true, inspectAutomation: async () => [] } });
  const rows = (values: Record<string, unknown>[]) => query.mockResolvedValueOnce({ rows: values, rowCount: values.length, command: 'SELECT', oid: 0, fields: [] });
  return { action, run, metadata, definition, suite, rescan, evidence, facts, query,
    omitDefinition: () => { missingDefinition = true; },
    async verify(override: ActionV2 = action) {
      facts.attestations = evidence.map(item => {
        const payload = validationAttestationPayloadSchema.parse({ id: item.kind === 'functional_suite' ? action.suiteAttestationId : item.kind === 'independent_rescan' ? action.rescanAttestationId : randomUUID(),
          organizationId, applicationId, runId, actionRef: candidateId, evidence: item, createdAt: new Date().toISOString(), expiresAt: expiresAt.toISOString() });
        return { payload, keyId, signature: sign(null, Buffer.from(JSON.stringify(payload)), key.privateKey).toString('base64url') };
      });
      if (override.kind === 'source_patch_pull_request') override.validationAttestationIds = facts.attestations.map(item => item.payload.id);
      rows([{ repository_key: 'gh-fixture', default_branch: 'main', state: 'verified', source: 'github_app', revoked: false,
        read_access: 'granted', write_access: 'granted', installation_id: '1', installation_state: 'active',
        writer_installation_id: '2', writer_verified_at: new Date(), writer_verified_commit: baseCommit }]);
      rows([{ capability_id: override.capabilityId, adapter_available: true }]);
      if (override.kind === 'source_patch_pull_request') { rows([]); rows([]); } else rows([metadata]);
      rows([{ snapshot_sha256: 'b'.repeat(64), artifact_sha256: 'b'.repeat(64), patch_sha256: action.patchSha256, tree_sha: treeSha, tree_complete: true, unsupported_reason: null }]);
      rows([run]);
      if (run.runner_profile === profile) rows(missingDefinition ? [] : [definition]);
      rows(facts.attestations.map(item => ({ id: item.payload.id, key_id: item.keyId, signature: item.signature, expires_at: expiresAt })));
      return verifier.verify(override, { phase: 'execution' });
    },
  };
}

describe('selected action validation (mocked database; real signatures, no infrastructure or customer execution)', () => {
  it('accepts the bound suite and dependency scope without promoting global coverage', async () => {
    const f = fixture();
    expect(await f.verify()).toMatchObject({ eligible: true, blockingReasons: [] });
    expect(f.rescan.after.coverage).toBe('partial');
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('AND ($4::uuid IS NULL OR id=$4)'), [f.action.organizationId, f.action.applicationId, f.facts.actionRef, f.metadata.validation_run_id]);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('FROM gotchu.validation_suite_definitions'),
      [f.action.organizationId, f.action.applicationId, f.definition.repository_link_id, f.definition.id, f.definition.version]);
  });

  it('rejects facts for a different persisted run', async () => {
    const f = fixture(); f.run.id = randomUUID();
    expect((await f.verify()).blockingReasons).toContain('validation_tampered');
  });

  it.each(['patch_digest', 'candidate_tree_digest', 'base_snapshot_digest'] as const)('rejects a persisted %s mismatch', async field => {
    const f = fixture(); f.run[field] = '9'.repeat(64);
    expect((await f.verify()).blockingReasons).toContain('validation_tampered');
  });

  it.each(['baseSnapshotDigest', 'candidateSnapshotDigest'] as const)('rejects signed scope %s substitution', async field => {
    const f = fixture(); if (!f.rescan.dependencyScope) throw new Error('missing scope');
    f.rescan.dependencyScope[field] = '9'.repeat(64);
    expect((await f.verify()).blockingReasons).toContain('validation_tampered');
  });

  it('rejects a metadata base digest that differs from the run even with a matching repository binding', async () => {
    const f = fixture(); f.metadata.base_digest = f.metadata.binding_digest = '9'.repeat(64);
    expect((await f.verify()).blockingReasons).toContain('validation_tampered');
  });

  it.each(['suiteBinding', 'baseCounts'] as const)('requires %s on selected suite evidence', async field => {
    const f = fixture(); delete f.suite[field];
    expect((await f.verify()).blockingReasons).toContain('validation_tampered');
  });

  it('requires dependency scope even when the signed global coverage claims complete', async () => {
    const f = fixture(); delete f.rescan.dependencyScope; f.rescan.before.coverage = f.rescan.after.coverage = 'complete';
    expect((await f.verify()).blockingReasons).toContain('validation_tampered');
  });

  it.each(['repositoryLinkId', 'suiteDefinitionId', 'suiteVersion', 'selectionDigest', 'testSelection'] as const)('rejects forged suite %s', async field => {
    const f = fixture(); const binding = f.suite.suiteBinding; if (!binding) throw new Error('missing binding');
    if (field === 'suiteVersion') binding.suiteVersion++;
    else if (field === 'testSelection') {
      binding.testSelection = { files: ['test/other.test.ts'] };
      binding.selectionDigest = sha256(canonicalJson({ profile: binding.profile, testSelection: binding.testSelection }));
    } else binding[field] = field === 'selectionDigest' ? '9'.repeat(64) : randomUUID();
    expect((await f.verify()).blockingReasons).toContain('validation_tampered');
  });

  it.each(['missing', 'required_count', 'profile', 'version', 'organization_id', 'application_id', 'repository_link_id', 'test_selection'] as const)('rejects mismatched immutable suite row: %s', async field => {
    const f = fixture();
    if (field === 'missing') f.omitDefinition();
    else if (field === 'required_count' || field === 'version') f.definition[field]++;
    else if (field === 'profile') f.definition.profile = 'node24-npm-test';
    else if (field === 'test_selection') f.definition.test_selection.namePattern = 'other';
    else f.definition[field] = randomUUID();
    expect((await f.verify()).blockingReasons).toContain('validation_tampered');
  });

  it.each(['baseCounts', 'counts'] as const)('rejects nonzero failures in %s despite a signed passing result', async field => {
    const f = fixture(); const counts = f.suite[field]; if (!counts) throw new Error('missing counts'); counts.failed = 1;
    expect((await f.verify()).blockingReasons).toContain('validation_failed');
  });

  it('recomputes coverage and rejects a signed pass with an unknown capability', async () => {
    const f = fixture(); if (!f.rescan.dependencyScope) throw new Error('missing scope');
    f.rescan.dependencyScope.afterCapabilities.push({ capability: 'unknown_scanner', state: 'inspected', detail: 'forged' });
    expect((await f.verify()).blockingReasons).toContain('validation_inconclusive');
  });

  it('requires real passing base tests for the selected profile', async () => {
    const f = fixture();
    f.suite.baseCounts = { passed: 0, failed: 0, skipped: 0 };
    expect((await f.verify()).blockingReasons).toContain('validation_failed');
  });

  it('binds frozen artifact packages to the approved dependency upgrade', async () => {
    const f = fixture(); const scope = f.rescan.dependencyScope;
    if (!scope) throw new Error('missing scope');
    for (const side of ['before', 'after'] as const) {
      scope.artifactScope[side] = scope.artifactScope[side].map(pkg => ({ ...pkg, name: 'unrelated' }));
      scope.artifactResults[side] = scope.artifactResults[side].map(pkg => ({ ...pkg, name: 'unrelated' }));
    }
    expect((await f.verify()).blockingReasons).toContain('validation_tampered');
  });

  it('rejects a new signed artifact finding omitted from the projected identities', async () => {
    const f = fixture(); const artifact = f.rescan.dependencyScope?.artifactResults.after[0];
    if (!artifact) throw new Error('missing artifact');
    artifact.analysis.findings.push({ tool: 'semgrep', ruleId: 'new-rule', title: 'Synthetic new observation', location: 'index.js:1',
      severity: 'medium', confidence: 'inferred', exploitability: 'unknown', description: 'Synthetic regression for independent identity validation.', evidenceIds: [randomUUID()] });
    expect((await f.verify()).blockingReasons).toContain('validation_inconclusive');
  });

  it('rejects selected scope under a persisted legacy profile', async () => {
    const f = fixture(); f.run.runner_profile = 'node24-npm-test';
    expect((await f.verify()).blockingReasons).toContain('validation_tampered');
  });

  it('preserves legacy dependency validation with complete coverage', async () => {
    const f = fixture(); f.run.runner_profile = 'node24-npm-test';
    delete f.suite.suiteBinding; delete f.rescan.dependencyScope;
    f.rescan.before.coverage = f.rescan.after.coverage = 'complete';
    expect(await f.verify()).toMatchObject({ eligible: true, blockingReasons: [] });
  });

  it('does not let supplied facts overwrite persisted run fields', async () => {
    const f = fixture(); f.run.patch_digest = '9'.repeat(64);
    Object.assign(f.facts, { patchDigest: f.action.patchSha256, runnerProfile: 'node24-npm-test', configuredSuite: f.definition });
    expect((await f.verify()).blockingReasons).toContain('validation_tampered');
  });

  it('uses persisted state even when facts claim passed', async () => {
    const f = fixture(); f.run.state = 'failed';
    expect((await f.verify()).blockingReasons).toContain('validation_failed');
  });

  it('fails closed for selected-profile source corrections', async () => {
    const f = fixture(); f.run.validation_mode = 'correction';
    const source: ActionV2 = { version: 2, organizationId: f.action.organizationId, applicationId: f.action.applicationId,
      policyVersion: 'v1', kind: 'source_patch_pull_request', capabilityId: 'repository.source_patch_pr', target: f.action.target,
      evidence: [{ id: f.facts.actionRef, sha256: 'b'.repeat(64), kind: 'private_correction_candidate' }], baseCommit: f.action.baseCommit,
      recipeId: 'fixture', recipeVersion: '1', snapshotSha256: 'b'.repeat(64), patchSha256: f.action.patchSha256,
      findingIdentities: ['npm:example:GHSA-test'], validationAttestationIds: [],
    };
    expect((await f.verify(source)).blockingReasons).toContain('validation_tampered');
  });
});
