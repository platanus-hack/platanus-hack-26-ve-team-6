import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { customerAssessmentReportSchema, customerRunInputSchema, customerSourceSnapshotSchema, scoreIndependentRescan, validationEvidenceSchema, validationLimitsSchema, validationSuiteDefinitionSchema, type ValidationEvidence, type ValidationRun } from '@gotchu/contracts';
import { createCustomerAssessmentRunner } from '@gotchu/customer-assessment';
import { createFirecrackerRunner, checkRunnerGate, runnerJobSchema, runnerPackageRoot, runnerResultSchema, type RunnerResult } from '@gotchu/runner';
import type { Database } from '@gotchu/database';
import { scoreValidation } from '@gotchu/backend';
import { sourceArchive } from './archive.js';
import { signAttestation, type ValidatorKey } from './keys.js';
import { createValidationInputRegistry } from './input-registry.js';
import { suiteModifiedByCandidate, validationAdmissionReason } from './validation-rules.js';

const leaseMs = 300_000;
const scanner = createCustomerAssessmentRunner();
const suiteResultSchema = z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), regression: z.enum(['failed_for_target', 'passed']).optional() }).strict();
const imageLockSchema = z.object({ firecracker: z.object({ binarySha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(), kernel: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(), rootfs: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough() }).passthrough();

function scanIdentities(report: unknown) {
  const parsed = customerAssessmentReportSchema.parse(report);
  const analysis = parsed.internal;
  if (!analysis || analysis.status !== 'completed') return { identities: [] as string[], coverage: 'unknown' as const };
  return {
    identities: [...new Set(analysis.findings.map(finding => finding.correlationKey))].sort(),
    coverage: analysis.coverage.length > 0 && analysis.coverage.every(item => item.state === 'inspected') ? 'complete' as const : 'partial' as const,
  };
}

function suiteCounts(result: RunnerResult) {
  if (result.status !== 'completed') return null;
  for (const artifact of result.artifacts) {
    if (!artifact.path.startsWith('test-results/')) continue;
    try {
      const raw: unknown = JSON.parse(Buffer.from(artifact.contentBase64, 'base64').toString('utf8'));
      const parsed = suiteResultSchema.safeParse(raw); if (parsed.success) return { counts: { passed: parsed.data.passed, failed: parsed.data.failed, skipped: parsed.data.skipped }, regression: parsed.data.regression ?? null };
    } catch { /* Invalid guest output stays untrusted and does not become a pass. */ }
  }
  return null;
}

function testPassed(result: RunnerResult): boolean { return result.status === 'completed' && result.exitCode === 0 && result.isolation.cleanupVerified; }

async function waitForReconciliationOrShutdown(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, 5_000);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export interface ValidationWorkerOptions {
  readonly database: Database;
  readonly key: ValidatorKey;
  readonly runnerGate?: typeof checkRunnerGate;
  readonly scanner?: typeof scanner;
  readonly runnerJobAdapter?: (
    job: z.infer<typeof runnerJobSchema>,
    options: { signal?: AbortSignal } | undefined,
    resolveInput: (reference: z.infer<typeof runnerJobSchema>['input'], scope: { organizationId: string; jobId: string }) => Promise<Uint8Array>,
  ) => Promise<unknown>;
  readonly concurrency?: number;
  readonly shutdownSignal?: AbortSignal;
}

export async function runValidatedRunnerJob(adapter: (job: z.infer<typeof runnerJobSchema>, options?: { signal?: AbortSignal }) => Promise<unknown>, job: z.infer<typeof runnerJobSchema>, options?: { signal?: AbortSignal }): Promise<RunnerResult> {
  const result = runnerResultSchema.safeParse(await adapter(job, options));
  if (!result.success) throw new Error('validation_runner_frame_invalid');
  return result.data;
}

export function createValidationWorker(options: ValidationWorkerOptions) {
  const inputRegistry = createValidationInputRegistry();
  const vmRunner = createFirecrackerRunner({ maxConcurrent: options.concurrency ?? 1, resolveInput: inputRegistry.resolveInput });
  const runnerDigests = readFile(join(runnerPackageRoot, 'images.lock.json'), 'utf8').then(async raw => {
    const lockValue: unknown = JSON.parse(raw);
    const lock = imageLockSchema.parse(lockValue);
    const implementation = await Promise.all(['firecracker.js', 'vm-config.js', 'contracts.js'].map(name => readFile(join(runnerPackageRoot, 'dist', name))));
    return { runner: createHash('sha256').update(Buffer.concat(implementation)).digest('hex'), firecracker: lock.firecracker.binarySha256, kernel: lock.kernel.sha256, rootfs: lock.rootfs.sha256 };
  });

  async function loadRun(organizationId: string, applicationId: string, runId: string) {
    return options.database.tenant(organizationId, async tx => {
      const runResult = await tx.query<Record<string, unknown>>(`SELECT v.*,s.body AS candidate_body,s.digest AS candidate_source_digest,b.body AS base_body,b.digest AS base_source_digest,d.repository_link_id,d.profile,d.script_name,d.suite_name,d.required_count,d.regression_test_path
        FROM gotchu.validation_runs v
        JOIN gotchu.customer_sources s ON s.organization_id=v.organization_id AND s.application_id=v.application_id AND s.id=v.candidate_source_id
        JOIN gotchu.customer_sources b ON b.organization_id=v.organization_id AND b.application_id=v.application_id AND b.id=v.base_source_id
        LEFT JOIN gotchu.validation_suite_definitions d ON d.organization_id=v.organization_id AND d.application_id=v.application_id AND d.id=v.suite_definition_id AND d.version=v.suite_version
        WHERE v.organization_id=$1 AND v.application_id=$2 AND v.id=$3 AND v.state='running' FOR UPDATE OF v`, [organizationId, applicationId, runId]);
      return runResult.rows[0] ?? null;
    });
  }

  async function finish(run: ValidationRun, leaseToken: string, evidence: ValidationEvidence[], state: string, reason: string | null, results: RunnerResult[]) {
    const now = new Date().toISOString();
    const attestations = evidence.map(evidenceItem => signAttestation({ id: randomUUID(), organizationId: run.organizationId, applicationId: run.applicationId, runId: run.id, actionRef: run.actionRef, evidence: validationEvidenceSchema.parse(evidenceItem), createdAt: now, expiresAt: run.expiresAt }, options.key));
    const digests = await runnerDigests;
    await options.database.tenant(run.organizationId, async tx => {
      const current = await tx.query<{ state: string }>(`SELECT state FROM gotchu.validation_runs WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE`, [run.organizationId, run.applicationId, run.id, leaseToken]);
      if (!current.rowCount) throw new Error('validation_lease_lost');
      await tx.query('INSERT INTO gotchu.validation_keys(id,public_key) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [options.key.keyId, options.key.publicKey]);
      for (const item of attestations) await tx.query(`INSERT INTO gotchu.validation_attestations(organization_id,application_id,run_id,id,kind,body,key_id,signature,expires_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, [run.organizationId, run.applicationId, run.id, item.payload.id, item.payload.evidence.kind, JSON.stringify(item.payload), item.keyId, item.signature, item.payload.expiresAt]);
      await tx.query(`UPDATE gotchu.validation_runs SET state=$5,reason=$6,finished_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,
        runner_digest=$7,firecracker_digest=$8,kernel_digest=$9,rootfs_digest=$10 WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND lease_token=$4`,
      [run.organizationId, run.applicationId, run.id, leaseToken, state, reason, results.length ? digests.runner : null,
        results.length ? digests.firecracker : null, results.length ? digests.kernel : null, results.length ? digests.rootfs : null]);
    });
  }

  async function processClaimInner(claim: { organizationId: string; applicationId: string; runId: string; leaseToken: string }) {
    const row = await loadRun(claim.organizationId, claim.applicationId, claim.runId);
    if (!row) return;
    const run: ValidationRun = {
      id: String(row.id), organizationId: claim.organizationId, applicationId: claim.applicationId, actionRef: String(row.action_ref), targetFindingId: String(row.target_finding_id), candidateSourceId: String(row.candidate_source_id), baseSourceId: String(row.base_source_id),
      baseSnapshotDigest: String(row.base_snapshot_digest), candidateTreeDigest: String(row.candidate_tree_digest), patchDigest: String(row.patch_digest), suiteRepositoryLinkId: row.suite_repository_link_id ? String(row.suite_repository_link_id) : null, suiteDefinitionId: row.suite_definition_id ? String(row.suite_definition_id) : null, suiteVersion: row.suite_version ? Number(row.suite_version) : null,
      runnerProfile: 'node24-npm-test', runnerDigest: null, firecrackerDigest: null, kernelDigest: null, rootfsDigest: null, sandboxKind: 'bwrap+systemd-scope', limits: validationLimitsSchema.parse(row.limits), state: 'running', reason: null,
      queuedAt: new Date(String(row.queued_at)).toISOString(), startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null, finishedAt: null, expiresAt: new Date(String(row.expires_at)).toISOString(),
    };
    const inconclusive = async (why: string) => finish(run, claim.leaseToken, [
      { kind: 'base_reproduction', result: 'unavailable', exitCode: null, durationMs: 0 },
      { kind: 'candidate_regression', result: 'unavailable', exitCode: null, durationMs: 0 },
      { kind: 'functional_suite', suiteName: String(row.suite_name ?? 'unconfigured'), result: 'inconclusive', counts: { passed: 0, failed: 0, skipped: 0 }, requiredCounts: Number(row.required_count ?? 1) },
      { kind: 'independent_rescan', result: 'inconclusive', before: { identities: [], coverage: 'unknown' }, after: { identities: [], coverage: 'unknown' }, targetedIdentities: [] },
    ], 'inconclusive', why, []);

    const admission = { suiteConfigured: Boolean(run.suiteDefinitionId && row.suite_name && row.script_name && row.required_count), baseDigestMatches: row.base_source_digest === run.baseSnapshotDigest, candidateDigestMatches: row.candidate_source_digest === run.candidateTreeDigest, scriptName: typeof row.script_name === 'string' ? row.script_name : null, gateOpen: true };
    const preflightReason = validationAdmissionReason(admission);
    if (preflightReason) return inconclusive(preflightReason);
    const gate = await (options.runnerGate ?? checkRunnerGate)();
    const gateReason = validationAdmissionReason({ ...admission, gateOpen: gate.status === 'open' });
    if (gateReason) return inconclusive(gateReason);
    const base = customerSourceSnapshotSchema.parse(row.base_body); const candidate = customerSourceSnapshotSchema.parse(row.candidate_body);
    const suite = validationSuiteDefinitionSchema.parse({ id: run.suiteDefinitionId, organizationId: run.organizationId, applicationId: run.applicationId, repositoryLinkId: String(row.repository_link_id ?? '00000000-0000-0000-0000-000000000000'), version: run.suiteVersion, profile: row.profile, scriptName: row.script_name, suiteName: row.suite_name, requiredCount: Number(row.required_count), regressionTestPath: row.regression_test_path, createdAt: run.queuedAt });
    if (suite.regressionTestPath && !base.files.some(file => file.path === suite.regressionTestPath)) return inconclusive('regression_test_missing');
    if (suiteModifiedByCandidate(base, candidate, { scriptName: suite.scriptName, regressionTestPath: suite.regressionTestPath })) return inconclusive('suite_modified_by_candidate');
    const beforeArchive = sourceArchive(base); const candidateArchive = sourceArchive(candidate);
    const runVm = async (bytes: Buffer) => {
      const objectId = randomUUID();
      const job = runnerJobSchema.parse({ jobId: randomUUID(), organizationId: run.organizationId, profile: run.runnerProfile, input: { objectId, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }, limits: run.limits, networkPolicy: { mode: 'deny' } });
      const runnerOptions = options.shutdownSignal ? { signal: options.shutdownSignal } : {};
      const adapter = options.runnerJobAdapter;
      const runJob = adapter
        ? (runnerJob: z.infer<typeof runnerJobSchema>, runOptions?: { signal?: AbortSignal }) => adapter(runnerJob, runOptions, inputRegistry.resolveInput)
        : (runnerJob: z.infer<typeof runnerJobSchema>, runOptions?: { signal?: AbortSignal }) => vmRunner.runJob(runnerJob, runOptions);
      return inputRegistry.withInput(run.organizationId, objectId, bytes, () => runValidatedRunnerJob(runJob, job, runnerOptions));
    };
    const results: RunnerResult[] = [];
    let cleanupUncertainObserved = false;
    const quarantineAndWait = async (result: RunnerResult): Promise<boolean> => {
      if (result.status !== 'cleanup_uncertain') return false;
      cleanupUncertainObserved = true;
      const owned = await options.database.tenant(run.organizationId, async tx => tx.query<{ state: string; lease_token: string }>(`UPDATE gotchu.validation_runs
        SET state='quarantined',reason='cleanup_uncertain',finished_at=NULL
        WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND lease_token=$4 AND state IN ('running','quarantined')
        RETURNING state,lease_token`, [run.organizationId, run.applicationId, run.id, claim.leaseToken]));
      const stillOwned = owned.rows[0]?.state === 'quarantined' && owned.rows[0].lease_token === claim.leaseToken;
      if (stillOwned) {
        while (!options.shutdownSignal?.aborted) {
          await waitForReconciliationOrShutdown(options.shutdownSignal);
          if (options.shutdownSignal?.aborted) break;
          const current = await options.database.tenant(run.organizationId, async tx => tx.query<{ state: string; lease_token: string | null }>(`SELECT state,lease_token
            FROM gotchu.validation_runs WHERE organization_id=$1 AND application_id=$2 AND id=$3`, [run.organizationId, run.applicationId, run.id]));
          if (current.rows[0]?.state !== 'quarantined' || current.rows[0].lease_token !== claim.leaseToken) break;
        }
      }
      return true;
    };
    try {
      const baseResult = await runVm(beforeArchive.bytes); results.push(baseResult);
      if (await quarantineAndWait(baseResult)) return;
      const candidateRegression = await runVm(candidateArchive.bytes); results.push(candidateRegression);
      if (await quarantineAndWait(candidateRegression)) return;
      const candidateSuite = await runVm(candidateArchive.bytes); results.push(candidateSuite);
      if (await quarantineAndWait(candidateSuite)) return;
      const reportInput = customerRunInputSchema.parse({ version: 2, organizationId: run.organizationId, applicationId: run.applicationId, jobId: randomUUID(), applicationName: 'Validation candidate', mode: 'internal', source: { ...candidate, id: run.candidateSourceId, digest: run.candidateTreeDigest }, target: null });
      const baseInput = customerRunInputSchema.parse({ ...reportInput, jobId: randomUUID(), source: { ...base, id: run.baseSourceId, digest: run.baseSnapshotDigest } });
      const [beforeReport, afterReport] = await Promise.all([(options.scanner ?? scanner).run(baseInput), (options.scanner ?? scanner).run(reportInput)]);
      const before = scanIdentities(beforeReport); const after = scanIdentities(afterReport);
      const selected = await options.database.tenant(run.organizationId, async tx => {
        const reports = await tx.query<{ body: unknown }>(`SELECT body FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND body->'subject'->>'sourceSnapshotId'=$3 ORDER BY created_at DESC LIMIT 1`, [run.organizationId, run.applicationId, run.baseSourceId]);
        const body = reports.rows[0]?.body;
        if (typeof body !== 'object' || body === null) return [];
        const internal = (body as { internal?: { findings?: Array<{ id?: string; correlationKey?: string }> } }).internal;
        return [...new Set((internal?.findings ?? []).filter(finding => finding.id === run.targetFindingId).map(finding => finding.correlationKey).filter((item): item is string => typeof item === 'string'))];
      });
      const baseEvidence = suiteCounts(baseResult); const regressionEvidence = suiteCounts(candidateRegression); const counts = suiteCounts(candidateSuite);
      const suiteShrank = counts !== null && baseEvidence !== null && (counts.counts.passed + counts.counts.failed + counts.counts.skipped < baseEvidence.counts.passed + baseEvidence.counts.failed + baseEvidence.counts.skipped || counts.counts.skipped > baseEvidence.counts.skipped);
      const rescan = scoreIndependentRescan({ before, after, targetedIdentities: selected });
      const evidence: ValidationEvidence[] = [
        { kind: 'base_reproduction', result: suite.regressionTestPath && baseEvidence?.regression === 'failed_for_target' ? 'failed_for_target' : suite.regressionTestPath && baseEvidence?.regression === 'passed' ? 'passed' : 'unavailable', exitCode: baseResult.status === 'completed' ? baseResult.exitCode : null, durationMs: baseResult.durationMs },
        { kind: 'candidate_regression', result: testPassed(candidateRegression) && (!suite.regressionTestPath || regressionEvidence?.regression === 'passed') ? 'passed' : candidateRegression.status === 'completed' ? 'failed' : 'unavailable', exitCode: candidateRegression.status === 'completed' ? candidateRegression.exitCode : null, durationMs: candidateRegression.durationMs },
        { kind: 'functional_suite', suiteName: suite.suiteName, result: counts ? (testPassed(candidateSuite) && !suiteShrank && counts.counts.passed >= suite.requiredCount && !(counts.counts.skipped > 0 && counts.counts.passed === 0) ? 'passed' : 'failed') : 'inconclusive', counts: counts?.counts ?? { passed: 0, failed: 0, skipped: 0 }, ...(baseEvidence ? { baseCounts: baseEvidence.counts } : {}), requiredCounts: suite.requiredCount },
        { kind: 'independent_rescan', result: rescan.result, before, after, targetedIdentities: selected },
      ];
      const score = scoreValidation(evidence);
      await finish(run, claim.leaseToken, evidence, score.state, score.reason, results);
    } catch (error) {
      if (cleanupUncertainObserved) throw error;
      const why = error instanceof Error && error.message === 'validation_lease_lost' ? 'lease_lost' : 'validation_execution_failed';
      await inconclusive(why);
    }
  }

  async function processClaim(claim: { organizationId: string; applicationId: string; runId: string; leaseToken: string }) {
    let heartbeating = false;
    const heartbeat = setInterval(() => {
      if (heartbeating) return;
      heartbeating = true;
      options.database.tenant(claim.organizationId, async tx => {
        await tx.query(`UPDATE gotchu.validation_runs SET lease_until=clock_timestamp()+$5*interval '1 millisecond'
          WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND lease_token=$4 AND state IN ('running','quarantined')`, [claim.organizationId, claim.applicationId, claim.runId, claim.leaseToken, leaseMs]);
      }).catch(error => process.emitWarning(`Validator lease heartbeat failed: ${error instanceof Error ? error.name : 'unknown'}`)).finally(() => { heartbeating = false; });
    }, Math.floor(leaseMs / 3));
    heartbeat.unref();
    try { await processClaimInner(claim); }
    finally { clearInterval(heartbeat); }
  }
  async function claim() {
    const leaseToken = randomUUID();
    const row = await options.database.tenant('00000000-0000-0000-0000-000000000000', async tx => {
      const claimed = await tx.query<{ organization_id: string; application_id: string; run_id: string }>('SELECT * FROM gotchu.validation_claim($1,$2)', [leaseToken, leaseMs]);
      return claimed.rows[0] ?? null;
    });
    return row ? { organizationId: row.organization_id, applicationId: row.application_id, runId: row.run_id, leaseToken } : null;
  }
  return { claim, processClaim } as const;
}
