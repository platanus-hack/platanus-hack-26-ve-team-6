import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_MAX_SOURCE_FILE_BYTES, customerAssessmentReportSchema, type CustomerAssessmentReport, type CustomerRunInput } from '@gotchu/contracts';
import { buildRecipeRecommendations, calculateSourceDigest, correctionResponseForQueuedScan, prepareCandidatePatch, RecipeBoundaryError } from '../src/server.js';
import { prepareCorrectionResponseSchema, remediationRecipeCatalog } from '../src/contracts.js';

const organizationId = '10000000-0000-4000-8000-000000000001';
const applicationId = '20000000-0000-4000-8000-000000000002';
const jobId = '30000000-0000-4000-8000-000000000003';
const sourceId = '40000000-0000-4000-8000-000000000004';
const reportId = '50000000-0000-4000-8000-000000000005';
const findingId = '60000000-0000-4000-8000-000000000006';
const evidenceId = '70000000-0000-4000-8000-000000000007';
const timestamp = '2026-10-24T00:00:00.000Z';

function runInput(files: Array<{ path: string; content: string }>): CustomerRunInput {
  const snapshot = { revision: 'customer-upload-1', files };
  return {
    organizationId, applicationId, jobId, version: 2, applicationName: 'Customer application', mode: 'internal',
    source: { ...snapshot, id: sourceId, digest: calculateSourceDigest(snapshot) }, target: null,
  };
}

function selection(input: CustomerRunInput, recipeId: string) {
  if (!input.source) throw new Error('test_requires_source');
  return { recipeId, findingId, expectedSourceDigest: input.source.digest };
}

function finding(ruleId: string, location: string) {
  return {
    id: findingId, ruleId, correlationKey: `${ruleId}:${location}`, origin: 'internal' as const,
    title: 'Static finding', location, description: 'A bounded test observation.', severity: 'medium' as const,
    confidence: 'observed' as const, exploitability: 'unknown' as const, impact: 'Impact is not established.',
    recommendation: 'Review the evidence.', limitations: ['No customer code was run.'], evidenceIds: [evidenceId],
  };
}

function reportFor(
  input: CustomerRunInput,
  ruleId: string,
  location: string,
  coverageState: 'inspected' | 'unavailable' = 'inspected',
  binding?: { checkId: string; startLine: number; endLine: number; propertyLine: number },
): CustomerAssessmentReport {
  if (!input.source) throw new Error('test_requires_source');
  const f = finding(ruleId, location);
  const pathAndLine = /^(.+):(\d+)$/.exec(location);
  const excerpt = binding && pathAndLine
    ? JSON.stringify({ rule: ruleId, path: pathAndLine[1], line: binding.startLine, checkId: binding.checkId, causeStartLine: binding.startLine, causeEndLine: binding.endLine, correctionLocationLine: binding.propertyLine, sourceDigest: input.source.digest })
    : '[redacted]';
  return customerAssessmentReportSchema.parse({
    version: 2, id: reportId, organizationId, applicationId, jobId, applicationName: input.applicationName,
    mode: 'internal', startedAt: timestamp, finishedAt: timestamp, responseMode: 'observation', actionsPerformed: [],
    subject: { sourceSnapshotId: input.source.id, sourceDigest: input.source.digest, targetId: null, targetVersion: null, origin: null },
    internal: {
      origin: 'internal', status: 'completed', startedAt: timestamp, finishedAt: timestamp, snapshotRef: `source:${sourceId}:sha256:${input.source.digest}`,
      tool: { name: 'test-profile', version: '1.0.0' }, findings: [f],
      evidence: [{ id: evidenceId, origin: 'internal', kind: 'configuration', locator: location, collectedAt: timestamp, snapshotRef: `source:${sourceId}:sha256:${input.source.digest}`, tool: { name: binding ? 'trivy' : 'test-profile', version: '1.0.0' }, checksum: createHash('sha256').update(excerpt).digest('hex'), excerpt }],
      coverage: [{ capability: 'semgrep', state: coverageState, detail: 'Test coverage state.' }], limitations: ['Test-only evidence.'],
    },
    external: null, comparison: [{ key: f.correlationKey, classification: 'unverified', internalFindingIds: [findingId], externalFindingIds: [], explanation: 'No external comparison was requested.' }],
    limitations: ['Test report only.'],
  });
}

describe('versioned evidence-selected recipes', () => {
  it('catalogs current source/HTTPS detectors separately from operational gaps', () => {
    const ids = new Set(remediationRecipeCatalog.map((recipe) => recipe.id));
    for (const id of ['dynamic-evaluation', 'shell-command-execution', 'tls-certificate-verification', 'credential-exposure', 'dependency-advisory', 'kubernetes-config-hardening', 'https-security-headers', 'authentication-failure-spike', 'route-enumeration', 'application-errors', 'resource-pressure', 'provider-outage']) {
      expect(ids.has(id)).toBe(true);
    }
    expect(remediationRecipeCatalog.find((recipe) => recipe.id === 'authentication-failure-spike')?.detectorAvailability).toBe('available');
    expect(remediationRecipeCatalog.find((recipe) => recipe.id === 'route-enumeration')?.detectorAvailability).toBe('not_implemented');
  });

  it.each(['gotchu.javascript.tls-disabled', 'profile.gotchu.javascript.tls-disabled'])('selects the exact scanner rule %s and preserves unknown coverage', ruleId => {
    const input = runInput([{ path: 'src/client.ts', content: 'const client = { rejectUnauthorized: false };\n' }]);
    const report = reportFor(input, ruleId, 'src/client.ts:1', 'unavailable');
    const result = buildRecipeRecommendations(input, report);

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      recipeId: 'tls-certificate-verification', recipeVersion: '1.0.0', availability: 'candidate_patch',
      evidenceFindingIds: [findingId], scope: { organizationId, applicationId, sourceSnapshotId: sourceId, sourceDigest: input.source?.digest, reportId },
    });
    expect(result.coverage.find((item) => item.recipeId === 'tls-certificate-verification')).toEqual({
      recipeId: 'tls-certificate-verification', recipeVersion: '1.0.0', detectorAvailability: 'available', coverage: 'unknown',
    });
    expect(result.recommendations[0]?.title).not.toContain('gotchu.javascript');
  });

  it('derives architecture context only from literal dependency keys and config paths', () => {
    const input = runInput([
      { path: 'package.json', content: JSON.stringify({ dependencies: { express: '^5.0.0' }, scripts: { start: 'echo @tanstack/start' } }) },
      { path: 'src/app.ts', content: "import '@tanstack/start';\n" },
      { path: 'next.config.ts', content: 'throw new Error("must not execute");\n' },
      { path: 'k8s/deployment.yaml', content: 'not parsed for architecture context\n' },
    ]);
    const report = reportFor(input, 'gotchu.javascript.tls-disabled', 'src/app.ts:1');
    const result = buildRecipeRecommendations(input, report);

    expect(result.repositoryContext.dependencyKeys).toEqual(['express']);
    expect(result.repositoryContext.manifestState).toBe('observed');
    expect(result.repositoryContext.frameworks).toEqual(['express', 'next']);
    expect(result.repositoryContext.configurationPaths).toEqual(['k8s/deployment.yaml', 'next.config.ts']);
    expect(result.repositoryContext.configurationState).toBe('identified');
    expect(result.recommendations[0]?.architectureHints).toEqual({ frameworks: ['express', 'next'], relevantConfigurationPaths: [] });
    expect((globalThis as { mustNotExecute?: boolean }).mustNotExecute).toBeUndefined();
  });

  it('prepares one TypeScript AST literal edit and binds exact file bytes and report scope', () => {
    const content = [
      '// rejectUnauthorized: false is only a comment',
      "const label = 'rejectUnauthorized: false';",
      'const client = {',
      '  rejectUnauthorized: false,',
      '};',
      'throw new Error("customer source must never run");',
      '',
    ].join('\n');
    const input = runInput([{ path: 'src/client.ts', content }]);
    const report = reportFor(input, 'gotchu.javascript.tls-disabled', 'src/client.ts:4');
    const result = prepareCandidatePatch(input, report, selection(input, 'tls-certificate-verification'));

    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(result.path).toBe('src/client.ts');
    expect(result.beforeBytes).toBe(content);
    expect(result.afterBytes).toBe(content.replace('rejectUnauthorized: false,', 'rejectUnauthorized: true,'));
    expect(result.originalFileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.patchHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.scope).toMatchObject({ organizationId, applicationId, sourceSnapshotId: sourceId, sourceDigest: input.source?.digest, reportId });
    expect(result.candidateSourceDigest).toBe(calculateSourceDigest(result.candidateSourceSnapshot));
    expect(result.candidateSourceSnapshot.files[0]?.content).toBe(result.afterBytes);
    const response = correctionResponseForQueuedScan(result, '80000000-0000-4000-8000-000000000008', '90000000-0000-4000-8000-000000000009');
    expect(prepareCorrectionResponseSchema.parse(response)).toEqual(response);
    expect(response).toEqual({
      sourceId: '80000000-0000-4000-8000-000000000008',
      jobId: '90000000-0000-4000-8000-000000000009',
      changes: [{ path: 'src/client.ts', description: 'Enabled TLS certificate verification at the reported source property.' }],
      patchHash: result.patchHash,
    });
    expect(JSON.stringify(response)).not.toContain('rejectUnauthorized');
    expect((globalThis as { mustNotExecute?: boolean }).mustNotExecute).toBeUndefined();
  });

  it('uses the only matching TLS property in a reported source file when the scanner anchors its enclosing object', () => {
    const content = 'const tlsOptions = {\n  rejectUnauthorized: false,\n};\n';
    const input = runInput([{ path: 'src/client.ts', content }]);
    const report = reportFor(input, 'gotchu.javascript.tls-disabled', 'src/client.ts:1');
    const result = prepareCandidatePatch(input, report, selection(input, 'tls-certificate-verification'));

    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(result.afterBytes).toBe(content.replace('rejectUnauthorized: false', 'rejectUnauthorized: true'));
  });

  it('does not edit comments or strings that resemble TLS properties', () => {
    const content = "const sample = 'rejectUnauthorized: false';\n// rejectUnauthorized: false\nconst client = { rejectUnauthorized: true };\n";
    const input = runInput([{ path: 'src/client.js', content }]);
    const report = reportFor(input, 'gotchu.javascript.tls-disabled', 'src/client.js:2');
    const result = prepareCandidatePatch(input, report, selection(input, 'tls-certificate-verification'));

    expect(result).toMatchObject({ status: 'blocked', reason: 'unsupported_transform' });
    expect(buildRecipeRecommendations(input, report).recommendations[0]?.availability).toBe('guided_review');

    const invalid = runInput([{ path: 'src/client.ts', content: 'const client = { rejectUnauthorized: false\n' }]);
    const invalidReport = reportFor(invalid, 'gotchu.javascript.tls-disabled', 'src/client.ts:1');
    expect(prepareCandidatePatch(invalid, invalidReport, selection(invalid, 'tls-certificate-verification'))).toMatchObject({ status: 'blocked', reason: 'syntax_invalid' });
  });

  it('binds a Trivy parent range to the exact KSV017 privileged literal', () => {
    const content = 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: customer\nspec:\n  containers:\n    - name: app\n      securityContext:\n        privileged: true # customer comment\n';
    const input = runInput([{ path: 'k8s/pod.yaml', content }]);
    const report = reportFor(input, 'AVD-KSV-0017', 'k8s/pod.yaml:9', 'inspected', { checkId: 'KSV017', startLine: 7, endLine: 9, propertyLine: 9 });
    const result = prepareCandidatePatch(input, report, selection(input, 'kubernetes-config-hardening'));

    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(result.afterBytes).toBe(content.replace('privileged: true # customer comment', 'privileged: false # customer comment'));
  });

  it.each([
    ['AVD-KSV-0001', 'KSV001', 'allowPrivilegeEscalation: true', 'allowPrivilegeEscalation: false'],
    ['AVD-KSV-0012', 'KSV012', 'runAsNonRoot: false', 'runAsNonRoot: true'],
    ['AVD-KSV-0014', 'KSV014', 'readOnlyRootFilesystem: false', 'readOnlyRootFilesystem: true'],
  ])('supports the exact %s Trivy correction only', (ruleId, checkId, before, after) => {
    const content = `apiVersion: v1\nkind: Pod\nmetadata:\n  name: customer\nspec:\n  containers:\n    - name: app\n      securityContext:\n        ${before}\n`;
    const input = runInput([{ path: 'k8s/pod.yaml', content }]);
    const report = reportFor(input, ruleId, 'k8s/pod.yaml:9', 'inspected', { checkId, startLine: 7, endLine: 9, propertyLine: 9 });
    const result = prepareCandidatePatch(input, report, selection(input, 'kubernetes-config-hardening'));

    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(result.afterBytes).toBe(content.replace(before, after));
  });

  it('keeps Kubernetes findings guidance-only without a unique scanner binding', () => {
    const duplicate = 'spec:\n  containers:\n    - name: app\n      securityContext:\n        privileged: true\n        privileged: true\n';
    const input = runInput([{ path: 'k8s/pod.yaml', content: duplicate }]);
    const report = reportFor(input, 'AVD-KSV-0017', 'k8s/pod.yaml:5');
    expect(buildRecipeRecommendations(input, report).recommendations[0]).toMatchObject({ availability: 'guided_review' });
    expect(prepareCandidatePatch(input, report, selection(input, 'kubernetes-config-hardening'))).toMatchObject({ status: 'blocked', reason: 'location_unbound' });

    const opaque = 'metadata:\n  annotations:\n    description: |\n      securityContext:\n        privileged: true\n';
    const opaqueInput = runInput([{ path: 'k8s/pod.yaml', content: opaque }]);
    const opaqueReport = reportFor(opaqueInput, 'AVD-KSV-0017', 'k8s/pod.yaml:5');
    expect(prepareCandidatePatch(opaqueInput, opaqueReport, selection(opaqueInput, 'kubernetes-config-hardening'))).toMatchObject({ status: 'blocked', reason: 'location_unbound' });

    const plainText = 'metadata:\n  annotations:\n    note: ordinary text\n      securityContext:\n        privileged: true\n';
    const plainInput = runInput([{ path: 'k8s/pod.yaml', content: plainText }]);
    const plainReport = reportFor(plainInput, 'AVD-KSV-0017', 'k8s/pod.yaml:5');
    expect(prepareCandidatePatch(plainInput, plainReport, selection(plainInput, 'kubernetes-config-hardening'))).toMatchObject({ status: 'blocked', reason: 'location_unbound' });
  });

  it('blocks a candidate that would exceed the shared file-size cap', () => {
    const base = 'apiVersion: v1\nkind: Pod\nspec:\n  containers:\n    - name: app\n      securityContext:\n        privileged: true';
    const content = base + ' '.repeat(CUSTOMER_MAX_SOURCE_FILE_BYTES - base.length);
    const input = runInput([{ path: 'k8s/pod.yaml', content }]);
    const report = reportFor(input, 'AVD-KSV-0017', 'k8s/pod.yaml:7', 'inspected', { checkId: 'KSV017', startLine: 5, endLine: 7, propertyLine: 7 });

    expect(prepareCandidatePatch(input, report, selection(input, 'kubernetes-config-hardening'))).toMatchObject({ status: 'blocked', reason: 'source_limit_exceeded' });
  });

  it('requires exact report tenant and source digest binding before recommending or preparing', () => {
    const input = runInput([{ path: 'src/client.ts', content: 'const client = { rejectUnauthorized: false };\n' }]);
    const report = reportFor(input, 'gotchu.javascript.tls-disabled', 'src/client.ts:1');
    const otherTenant = customerAssessmentReportSchema.parse({ ...report, organizationId: '90000000-0000-4000-8000-000000000009' });
    expect(() => buildRecipeRecommendations(input, otherTenant)).toThrowError(new RecipeBoundaryError('assessment_scope_mismatch'));
    const wrongEvidenceSource = customerAssessmentReportSchema.parse({
      ...report,
      internal: report.internal ? { ...report.internal, snapshotRef: 'source:another-snapshot:sha256:'.concat('d'.repeat(64)) } : null,
    });
    expect(() => buildRecipeRecommendations(input, wrongEvidenceSource)).toThrowError(new RecipeBoundaryError('assessment_scope_mismatch'));

    const badDigestInput = { ...input, source: { ...input.source!, digest: 'b'.repeat(64) } };
    expect(() => prepareCandidatePatch(badDigestInput, report, selection(badDigestInput, 'tls-certificate-verification'))).toThrowError(new RecipeBoundaryError('source_digest_mismatch'));
    expect(() => prepareCandidatePatch(input, report, { ...selection(input, 'tls-certificate-verification'), expectedSourceDigest: 'c'.repeat(64) })).toThrowError(new RecipeBoundaryError('expected_source_digest_mismatch'));
  });

  it('enforces shared per-file source caps before deriving recommendations', () => {
    const input = runInput([{ path: 'src/oversized.ts', content: 'x'.repeat(1_048_577) }]);
    const report = reportFor(input, 'gotchu.javascript.tls-disabled', 'src/oversized.ts:1');
    expect(() => buildRecipeRecommendations(input, report)).toThrow();
  });

  it('keeps secret rotation and dependency fixes behind integrations', () => {
    const input = runInput([{ path: 'package.json', content: '{"dependencies":{"lodash":"4.17.20"}}\n' }]);
    const advisory = reportFor(input, 'osv.GHSA-example', 'package-lock.json:1');
    const credential = reportFor(input, 'generic-api-key', 'src/config.ts:1');
    expect(buildRecipeRecommendations(input, advisory).recommendations[0]?.availability).toBe('integration_required');
    expect(buildRecipeRecommendations(input, credential).recommendations[0]?.availability).toBe('integration_required');
    expect(prepareCandidatePatch(input, credential, selection(input, 'credential-exposure'))).toMatchObject({ status: 'blocked', reason: 'recipe_requires_integration' });
  });

  it.each([undefined, 'root', 'public_surface'] as const)('supports authorized HTTPS-only reports with profile %s', (scanProfile) => {
    const input: CustomerRunInput = {
      organizationId, applicationId, jobId, version: 2, applicationName: 'External application', mode: 'external', source: null,
      target: { id: sourceId, origin: 'https://app.example.com', version: 3, verifiedAt: timestamp, expiresAt: '2026-10-31T00:00:00.000Z', ...(scanProfile ? { scanProfile } : {}) },
    };
    const targetSnapshotRef = `target:${sourceId}:3:${createHash('sha256').update('https://app.example.com').digest('hex')}${scanProfile === 'public_surface' ? ':public_surface' : ''}`;
    const externalFinding = {
      id: findingId, ruleId: 'https.missing-content-security-policy', correlationKey: 'http:content-security-policy', origin: 'external' as const,
      title: 'Response omits Content-Security-Policy', location: 'https://app.example.com/', description: 'The observed root response omitted a header.',
      severity: 'low' as const, confidence: 'observed' as const, exploitability: 'unknown' as const,
      impact: 'Browser hardening may be reduced.', recommendation: 'Review the response policy.', limitations: ['Only the root response was observed.'], evidenceIds: [evidenceId],
    };
    const report = customerAssessmentReportSchema.parse({
      version: 2, id: reportId, organizationId, applicationId, jobId, applicationName: input.applicationName, mode: 'external',
      startedAt: timestamp, finishedAt: timestamp, responseMode: 'observation', actionsPerformed: [],
      subject: { sourceSnapshotId: null, sourceDigest: null, targetId: sourceId, targetVersion: 3, origin: 'https://app.example.com' },
      internal: null,
      external: {
        origin: 'external', status: 'completed', startedAt: timestamp, finishedAt: timestamp, snapshotRef: targetSnapshotRef, tool: { name: 'https-test', version: '1' },
        findings: [externalFinding],
        evidence: [{ id: evidenceId, origin: 'external', kind: 'http_response', locator: 'https://app.example.com/', collectedAt: timestamp, snapshotRef: targetSnapshotRef, tool: { name: 'https-test', version: '1' }, checksum: 'c'.repeat(64), excerpt: 'status=200; headers=[redacted]' }],
        coverage: [{ capability: 'root_headers', state: 'inspected', detail: 'Root response observed.' }], limitations: ['No route enumeration.'],
      },
      comparison: [{ key: externalFinding.correlationKey, classification: 'unverified', internalFindingIds: [], externalFindingIds: [findingId], explanation: 'No source assessment was requested.' }],
      limitations: ['External-only report.'],
    });
    const result = buildRecipeRecommendations(input, report);

    if (report.external) {
      const wrong = structuredClone(report);
      if (!wrong.external) throw new Error('external_required');
      wrong.external.snapshotRef = targetSnapshotRef + ':wrong-profile';
      expect(() => buildRecipeRecommendations(input, wrong)).toThrow(RecipeBoundaryError);
      wrong.external.snapshotRef = targetSnapshotRef;
      const evidence = wrong.external.evidence[0];
      if (!evidence) throw new Error('evidence_required');
      evidence.snapshotRef = targetSnapshotRef + ':wrong-profile';
      expect(() => buildRecipeRecommendations(input, wrong)).toThrow(RecipeBoundaryError);
    }
    expect(result.scope).toMatchObject({ sourceSnapshotId: null, sourceDigest: null, targetId: sourceId, targetVersion: 3, targetOrigin: 'https://app.example.com' });
    expect(result.repositoryContext.manifestState).toBe('not_requested');
    expect(result.repositoryContext.configurationState).toBe('not_requested');
    expect(result.coverage.find((item) => item.recipeId === 'https-security-headers')?.coverage).toBe('inspected');
    expect(result.coverage.find((item) => item.recipeId === 'tls-certificate-verification')?.coverage).toBe('not_requested');
    expect(result.recommendations[0]).toMatchObject({ recipeId: 'https-security-headers', availability: 'guided_review', evidenceFindingIds: [findingId] });
  });
});
