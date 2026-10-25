import { randomUUID, createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { scoreIndependentRescan, validationAttestationPayloadSchema, validationAttestationSchema, validationEvidenceSchema, validationFactsSchema, validationPublicProjectionSchema, validationSuiteConfigSchema, validationSuiteDefinitionSchema, type ValidationEvidence } from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { audit, authorize, BackendError, parse, type BaseDependencies, type Identity } from './core.js';

const scopeSchema = z.object({ organizationId: z.uuid(), applicationId: z.uuid() }).strict();
const configureSchema = validationSuiteConfigSchema;
const defaultLimits = { vcpu: 1, memMiB: 1024, pids: 128, wallMs: 120_000, outputBytes: 262_144, diskMiB: 2048 } as const;

function suiteNameForConfig(name: string, selection: { files: readonly string[] } | null): string {
  if (!selection) return name;
  const marker = selection.files.length === 1 ? ' [selected test: 1 file]' : ` [selected tests: ${selection.files.length} files]`;
  return `${name.slice(0, 128 - marker.length).trimEnd()}${marker}`;
}

export function scoreValidation(evidence: readonly ValidationEvidence[], mode: 'correction' | 'dependency' = 'correction'): { state: 'passed' | 'failed' | 'inconclusive'; reason: string | null } {
  const base = evidence.find(item => item.kind === 'base_reproduction');
  const regression = evidence.find(item => item.kind === 'candidate_regression');
  const suite = evidence.find(item => item.kind === 'functional_suite');
  const rescan = evidence.find(item => item.kind === 'independent_rescan');
  if (!regression || !suite || !rescan) return { state: 'inconclusive', reason: 'required_evidence_missing' };
  if (suite.baseCounts && (suite.counts.passed + suite.counts.failed + suite.counts.skipped < suite.baseCounts.passed + suite.baseCounts.failed + suite.baseCounts.skipped || suite.counts.skipped > suite.baseCounts.skipped)) return { state: 'failed', reason: 'suite_shrank' };
  if (suite.result === 'failed' || suite.counts.passed < suite.requiredCounts || suite.counts.skipped > 0 && suite.counts.passed === 0) return { state: 'failed', reason: 'functional_suite_failed' };
  if (regression.result === 'failed') return { state: 'failed', reason: 'candidate_regression_failed' };
  if (rescan.result === 'failed') return { state: 'failed', reason: 'rescan_findings_changed' };
  const rescanScore = scoreIndependentRescan(rescan);
  if (rescanScore.result === 'failed') return { state: 'failed', reason: rescanScore.reason };
  if (rescan.result !== 'passed' || rescanScore.result !== 'passed') return { state: 'inconclusive', reason: rescanScore.reason ?? 'rescan_coverage_unknown' };
  if (mode === 'correction' && base?.result !== 'failed_for_target') return { state: 'inconclusive', reason: 'base_reproduction_not_confirmed' };
  if (mode === 'dependency' && base?.result !== 'not_required') return { state: 'inconclusive', reason: 'dependency_validation_mode_missing' };
  if (regression.result !== 'passed' || suite.result !== 'passed') return { state: 'inconclusive', reason: 'required_test_not_passed' };
  return { state: 'passed', reason: null };
}

/** Add a validation record in the same transaction as a private correction candidate. */
export async function enqueueValidation(tx: Transaction, input: {
  organizationId: string; applicationId: string; candidateSourceId: string; baseSourceId: string; targetFindingId: string; targetFindingIds?: readonly string[]; baseDigest: string; candidateDigest: string; patchDigest: string; repositoryLinkId?: string; mode?: 'correction' | 'dependency'; dependencyAllowlist?: readonly { name: string; section: 'dependencies' | 'devDependencies' | 'optionalDependencies'; version: string }[];
}) {
  const repository = await tx.query<{ id: string }>(`SELECT id FROM gotchu.application_repository_links
    WHERE organization_id=$1 AND application_id=$2 AND NOT revoked
      AND ($4::boolean=false OR (state='verified' AND read_access='granted'))
      AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at,id LIMIT 2`, [input.organizationId, input.applicationId, input.repositoryLinkId ?? null, input.mode === 'dependency']);
  if (repository.rows.length > 1) throw new BackendError('repository_link_ambiguous', 'Independent validation requires one exact repository link', 409);
  const linkId = repository.rows[0]?.id;
  const suite = linkId ? await tx.query<{ id: string; version: number; repository_link_id: string; profile: string }>(`SELECT id,version,repository_link_id,profile FROM gotchu.validation_suite_definitions
    WHERE organization_id=$1 AND application_id=$2 AND repository_link_id=$3 ORDER BY version DESC LIMIT 1`, [input.organizationId, input.applicationId, linkId]) : null;
  const selectedSuite = suite?.rows[0];
  if (input.mode === 'dependency' && !selectedSuite) throw new BackendError('validation_suite_missing', 'A dependency candidate requires a configured validation suite', 409);
  const id = randomUUID();
  const targetFindingIds = [...new Set(input.targetFindingIds ?? [input.targetFindingId])];
  const dependencyAllowlist = input.dependencyAllowlist ?? [];
  if (!targetFindingIds.length || targetFindingIds.length > 20 || dependencyAllowlist.length > 20
    || (input.mode ?? 'correction') === 'dependency' && dependencyAllowlist.length !== 1) {
    throw new BackendError('validation_scope_invalid', 'Independent validation scope is invalid', 409);
  }
  await tx.query(`INSERT INTO gotchu.validation_runs(organization_id,application_id,id,action_ref,target_finding_id,target_finding_ids,validation_mode,dependency_allowlist,candidate_source_id,base_source_id,
    suite_repository_link_id,suite_definition_id,suite_version,base_snapshot_digest,candidate_tree_digest,patch_digest,state,reason,runner_profile,sandbox_kind,limits,finished_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'bwrap+systemd-scope',$20::jsonb,CASE WHEN $17='inconclusive' THEN clock_timestamp() ELSE NULL END)`,
  [input.organizationId, input.applicationId, id, input.candidateSourceId, input.targetFindingId, JSON.stringify(targetFindingIds), input.mode ?? 'correction', JSON.stringify(dependencyAllowlist), input.candidateSourceId, input.baseSourceId,
    selectedSuite?.repository_link_id ?? null, selectedSuite?.id ?? null, selectedSuite?.version ?? null, input.baseDigest, input.candidateDigest, input.patchDigest,
    selectedSuite ? 'queued' : 'inconclusive', selectedSuite ? null : 'suite_not_configured', selectedSuite?.profile ?? 'node24-npm-test', JSON.stringify(defaultLimits)]);
  return id;
}

export function createValidationService(deps: BaseDependencies) {
  return {
    async configureSuite(identity: Identity, raw: z.input<typeof configureSchema>) {
      const actor = parse(z.object({ userId: z.string().min(1).max(256) }).strict(), identity);
      const input = parse(configureSchema, raw);
      if (input.profile === 'node24-tsx-selected-v1' ? input.scriptName !== 'test' || input.testSelection === null : input.testSelection !== null) {
        throw new BackendError('validation_profile_config_invalid', 'The selected profile requires the test script and an explicit file selection; legacy profiles cannot include selected files');
      }
      const suiteName = suiteNameForConfig(input.suiteName, input.testSelection);
      return deps.database.tenant(input.organizationId, async tx => {
        await authorize(tx, input.organizationId, actor, ['owner', 'operator']);
        const link = await tx.query<{ revoked: boolean }>('SELECT revoked FROM gotchu.application_repository_links WHERE organization_id=$1 AND application_id=$2 AND id=$3', [input.organizationId, input.applicationId, input.repositoryLinkId]);
        if (!link.rows[0] || link.rows[0].revoked) throw new BackendError('repository_link_unavailable', 'An active repository link is required to configure validation', 409);
        const prior = await tx.query<{ version: number }>('SELECT max(version)::int AS version FROM gotchu.validation_suite_definitions WHERE organization_id=$1 AND application_id=$2 AND repository_link_id=$3', [input.organizationId, input.applicationId, input.repositoryLinkId]);
        const version = (prior.rows[0]?.version ?? 0) + 1;
        const id = randomUUID();
        await tx.query(`INSERT INTO gotchu.validation_suite_definitions(organization_id,application_id,repository_link_id,id,version,profile,script_name,suite_name,required_count,regression_test_path,test_selection,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`, [input.organizationId, input.applicationId, input.repositoryLinkId, id, version, input.profile, input.scriptName, suiteName, input.requiredCount, input.regressionTestPath ?? null, input.testSelection === null ? null : JSON.stringify(input.testSelection), actor.userId]);
        await audit(tx, input.organizationId, actor.userId, 'validation.suite_configured', id, { applicationId: input.applicationId, repositoryLinkId: input.repositoryLinkId, version, profile: input.profile, suiteName });
        return validationSuiteDefinitionSchema.parse({ id, organizationId: input.organizationId, applicationId: input.applicationId, repositoryLinkId: input.repositoryLinkId, version, profile: input.profile, scriptName: input.scriptName, suiteName, requiredCount: input.requiredCount, regressionTestPath: input.regressionTestPath ?? null, testSelection: input.testSelection, createdAt: new Date().toISOString() });
      });
    },
    async getStatus(identity: Identity, raw: { organizationId: string; applicationId: string; candidateSourceId: string }) {
      const actor = parse(z.object({ userId: z.string().min(1).max(256) }).strict(), identity); const input = parse(scopeSchema.extend({ candidateSourceId: z.uuid() }).strict(), raw);
      return deps.database.tenant(input.organizationId, async tx => {
        await authorize(tx, input.organizationId, actor);
        const result = await tx.query<{ id: string; action_ref: string; target_finding_id: string; candidate_source_id: string; base_source_id: string; suite_repository_link_id: string | null; suite_definition_id: string | null; suite_version: number | null; base_snapshot_digest: string; candidate_tree_digest: string; patch_digest: string; state: string; reason: string | null; runner_profile: string; sandbox_kind: string; runner_digest: string | null; firecracker_digest: string | null; kernel_digest: string | null; rootfs_digest: string | null; limits: unknown; queued_at: Date; started_at: Date | null; finished_at: Date | null; expires_at: Date }>(`SELECT * FROM gotchu.validation_runs WHERE organization_id=$1 AND application_id=$2 AND candidate_source_id=$3`, [input.organizationId, input.applicationId, input.candidateSourceId]);
        const row = result.rows[0];
        if (!row) return null;
        const attestations = await tx.query<{ body: unknown }>('SELECT body FROM gotchu.validation_attestations WHERE organization_id=$1 AND application_id=$2 AND run_id=$3 ORDER BY created_at,id', [input.organizationId, input.applicationId, row.id]);
        const payloads = attestations.rows.map(item => validationAttestationPayloadSchema.parse(item.body));
        const evidence = payloads.map(item => item.evidence);
        const scan = evidence.find(item => item.kind === 'independent_rescan'); const suite = evidence.find(item => item.kind === 'functional_suite');
        const run = {
          id: row.id, organizationId: input.organizationId, applicationId: input.applicationId, actionRef: row.action_ref, targetFindingId: row.target_finding_id, candidateSourceId: row.candidate_source_id, baseSourceId: row.base_source_id,
          suiteRepositoryLinkId: row.suite_repository_link_id, suiteDefinitionId: row.suite_definition_id, suiteVersion: row.suite_version, baseSnapshotDigest: row.base_snapshot_digest, candidateTreeDigest: row.candidate_tree_digest, patchDigest: row.patch_digest,
          runnerProfile: row.runner_profile, sandboxKind: row.sandbox_kind, runnerDigest: row.runner_digest, firecrackerDigest: row.firecracker_digest, kernelDigest: row.kernel_digest, rootfsDigest: row.rootfs_digest,
          limits: row.limits, state: row.state, reason: row.reason, queuedAt: row.queued_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null, expiresAt: row.expires_at.toISOString(),
        };
        return validationPublicProjectionSchema.parse({ run, attestations: payloads, facts: { objectiveRescanPassed: scan?.kind === 'independent_rescan' && scan.result === 'passed', functionalSuitePassed: suite?.kind === 'functional_suite' && suite.result === 'passed', suiteName: suite?.kind === 'functional_suite' ? suite.suiteName : null, passedCount: suite?.kind === 'functional_suite' ? suite.counts.passed : null } });
      });
    },
    async getValidationFacts(input: { organizationId: string; actionRef: string }) {
      const value = parse(z.object({ organizationId: z.uuid(), actionRef: z.uuid() }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        const runResult = await tx.query<{ id: string; state: string }>('SELECT id,state FROM gotchu.validation_runs WHERE organization_id=$1 AND action_ref=$2', [value.organizationId, value.actionRef]);
        const run = runResult.rows[0]; if (!run) return null;
        const rows = await tx.query<{ body: unknown; key_id: string; signature: string; public_key: string }>(`SELECT a.body,a.key_id,a.signature,k.public_key FROM gotchu.validation_attestations a
          JOIN gotchu.validation_keys k ON k.id=a.key_id WHERE a.organization_id=$1 AND a.run_id=$2 ORDER BY a.created_at,a.id`, [value.organizationId, run.id]);
        return validationFactsSchema.parse({ actionRef: value.actionRef, runId: run.id, state: run.state,
          attestations: rows.rows.map(row => validationAttestationSchema.parse({ payload: row.body, keyId: row.key_id, signature: row.signature })),
          keys: [...new Map(rows.rows.map(row => [row.key_id, { keyId: row.key_id, publicKey: row.public_key }])).values()] });
      });
    },
  };
}

export function digestValidationPayload(payload: unknown): string { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }

/** The action verifier must verify every signed payload before treating any fact as evidence. */
export function verifyValidationAttestation(attestationInput: unknown, publicKeyPem: string): boolean {
  try {
    const attestation = validationAttestationSchema.parse(attestationInput);
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const der = key.export({ type: 'spki', format: 'der' });
    if (createHash('sha256').update(der).digest('hex') !== attestation.keyId) return false;
    return verify(null, Buffer.from(JSON.stringify(attestation.payload)), key, Buffer.from(attestation.signature, 'base64url'));
  } catch { return false; }
}
