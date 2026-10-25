import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { actionV2Schema, type ValidationEvidence } from '@gotchu/contracts';
import { createLocalGitAdapter } from '@gotchu/git-adapters';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createActionVerifier, readPinnedRootfsDigest } from '../src/action-verifier.js';
import { createBackend } from '../src/index.js';
import { createValidationService } from '../src/validations.js';
import { canonicalJson, sha256 } from '../src/core.js';
import { fixture, liveUrl } from '../../database/test/support.js';
import { insertValidationAttestations, passingValidationEvidence } from './action-verifier.test-support.js';

const live = liveUrl ? describe : describe.skip;
const temporaryRepositories: string[] = [];
const executorInstanceId = randomUUID();

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'gotchu-action-verifier-'));
  temporaryRepositories.push(root);
  const seed = join(root, 'seed');
  await mkdir(join(seed, 'src'), { recursive: true });
  await writeFile(join(seed, 'README.md'), `${randomUUID()}\n`);
  await writeFile(join(seed, 'src', 'config.ts'), 'export const secure = false;\n');
  git(seed, 'init', '-b', 'main');
  git(seed, 'add', '--all');
  git(seed, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'base');
  git(root, 'clone', '--bare', seed, join(root, 'repository.git'));
  return { adapter: await createLocalGitAdapter(root), baseCommit: git(seed, 'rev-parse', 'HEAD') };
}

live('action verifier on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const identity = () => ({ userId: f.a.userId });
  beforeAll(async () => {
    f = await fixture({ max: 3 });
    await f.admin.query("UPDATE gotchu.action_capabilities SET adapter_available=true WHERE kind='source_patch_pull_request'");
    await f.admin.query("INSERT INTO gotchu.action_executor_instances(instance_id,capability_id) VALUES($1,'repository.source_patch_pr')", [executorInstanceId]);
  }, 30_000);
  afterEach(async () => { await Promise.all(temporaryRepositories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
  afterAll(async () => {
    await f?.admin.query("UPDATE gotchu.action_capabilities SET adapter_available=false WHERE kind='source_patch_pull_request'");
    await f?.admin.query('DELETE FROM gotchu.action_executor_instances WHERE instance_id=$1', [executorInstanceId]);
    await f?.close();
  });

  async function prepare(options: {
    runState?: 'passed'|'failed'|'inconclusive'|'expired';
    runExists?: boolean;
    evidence?: readonly ValidationEvidence[];
    signed?: boolean;
    invalidSignatureKind?: ValidationEvidence['kind'];
    cleanupVerified?: boolean;
    rootfsDigest?: string;
    expiresAt?: Date;
    lockApplicationDuringRepositoryRead?: boolean;
  } = {}) {
    await f.admin.query('UPDATE gotchu.application_repository_links SET revoked=true WHERE organization_id=$1 AND application_id=$2 AND NOT revoked', [f.a.organizationId, f.a.applicationId]);
    const repo = await repositoryFixture();
    const originalSourceId = randomUUID(); const candidateSourceId = randomUUID(); const repositoryLinkId = randomUUID();
    const runId = randomUUID(); const patchHash = 'e'.repeat(64);
    let workflowViolations: Array<{ path: string; rule: 'invalid_yaml'|'invalid_document'|'pull_request_target'|'push_without_branch_filter'|'push_to_gotchu_branch'|'forbidden_pull_request_secret' }> = [];
    const original = { revision: repo.baseCommit, files: [{ path: 'src/config.ts', content: 'export const secure = false;\n' }] };
    const candidate = { revision: repo.baseCommit, files: [{ path: 'src/config.ts', content: 'export const secure = true;\n' }] };
    const sourceDigest = sha256(canonicalJson(original)); const candidateDigest = sha256(canonicalJson(candidate));
    await f.admin.query(`INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor)
      VALUES($1,$2,$3,$4,$5::jsonb,$6),($1,$2,$7,$8,$9::jsonb,$6)`, [f.a.organizationId, f.a.applicationId, originalSourceId, sourceDigest, JSON.stringify(original), f.a.userId, candidateSourceId, candidateDigest, JSON.stringify(candidate)]);
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,state,source,writer_installation_id,writer_verified_at,writer_verified_commit)
      VALUES($1,$2,$3,$4,'main','granted','granted','verified','operator','174788477',clock_timestamp(),$5)`, [f.a.organizationId, f.a.applicationId, repositoryLinkId, `catalog:${randomUUID()}`,'a'.repeat(40)]);
    const repositoryKey = (await f.admin.query<{ repository_key: string }>('SELECT repository_key FROM gotchu.application_repository_links WHERE id=$1', [repositoryLinkId])).rows[0]?.repository_key;
    const sourceDetail = { applicationId: f.a.applicationId, originalSourceId, sourceDigest, candidateSourceDigest: candidateDigest, patchHash, recipeId: 'tls-certificate-verification', recipeVersion: '1.0.0', findingId: 'finding-1', path: 'src/config.ts' };
    await f.admin.query('INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [f.a.organizationId, randomUUID(), f.a.userId, 'correction.prepared', candidateSourceId, JSON.stringify(sourceDetail)]);

    const expiry = options.expiresAt ?? new Date(Date.now() + 60_000);
    if (options.runExists !== false) await f.admin.query(`INSERT INTO gotchu.validation_runs(organization_id,application_id,id,action_ref,target_finding_id,candidate_source_id,base_source_id,
      base_snapshot_digest,candidate_tree_digest,patch_digest,runner_profile,sandbox_kind,rootfs_digest,cleanup_verified,limits,state,finished_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'node24-npm-test','bwrap+systemd-scope',$11,$12,$13::jsonb,$14,clock_timestamp(),$15)`, [
      f.a.organizationId, f.a.applicationId, runId, candidateSourceId, randomUUID(), candidateSourceId, originalSourceId,
      sourceDigest, candidateDigest, patchHash, options.rootfsDigest ?? readPinnedRootfsDigest(), options.cleanupVerified ?? true,
      JSON.stringify({ vcpu: 1, memMiB: 1024, pids: 128, wallMs: 120_000, outputBytes: 262_144, diskMiB: 2048 }),
      options.runState ?? 'passed', expiry,
    ]);
    const keyPair = generateKeyPairSync('ed25519');
    const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const publicKeyDer = keyPair.publicKey.export({ type: 'spki', format: 'der' });
    if (options.signed !== false && options.runExists !== false) {
      await insertValidationAttestations({
        database: f.databases.gotchu_validator, organizationId: f.a.organizationId, applicationId: f.a.applicationId,
        runId, actionRef: candidateSourceId, evidence: options.evidence ?? passingValidationEvidence,
        publicKeyPem, publicKeyDer, privateKey: keyPair.privateKey,
        expiresAt: expiry.toISOString(), ...(options.invalidSignatureKind ? { invalidSignatureKind: options.invalidSignatureKind } : {}),
      });
    }
    let factsTransform: ((facts: Record<string, unknown>) => Record<string, unknown>) | undefined;
    const verifierFor = (database: typeof f.databases.gotchu_api) => {
      const validations = createValidationService({ database });
      return createActionVerifier({
        database,
        pinnedRootfsDigest: readPinnedRootfsDigest(),
        repository: {
          readHead: async input => {
            if (options.lockApplicationDuringRepositoryRead) await database.tenant(input.organizationId, async tx => {
              await tx.query("SET LOCAL lock_timeout='250ms'");
              await tx.query('SELECT gotchu.lock_customer_application($1,$2)', [input.organizationId,input.applicationId]);
            });
            return repo.adapter.readHead(input.branch);
          },
          readTree: async input => repo.adapter.readTree(input.commitSha),
          isPolicyCurrent: async () => true,
          inspectAutomation: async () => workflowViolations,
        },
        validationFacts: {
          getFacts: async input => {
            const facts = await validations.getValidationFacts(input);
            return facts && factsTransform ? factsTransform(facts as unknown as Record<string, unknown>) : facts;
          },
        },
      });
    };
    const verifier = verifierFor(f.databases.gotchu_api);
    const api = createBackend({
      database: f.databases.gotchu_api,
      actionVerifier: verifier,
    });
    const proposed = await api.actions.propose(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, kind: 'source_patch_pull_request', sourceRef: { type: 'correction_candidate', candidateId: candidateSourceId } });
    return { api, verifier, verifierFor, proposed, candidateSourceId, repositoryLinkId, runId, repositoryKey, keyPair, publicKeyPem, publicKeyDer,
      setFactsTransform: (transform: typeof factsTransform) => { factsTransform = transform; },
      setWorkflowViolations: (violations: typeof workflowViolations) => { workflowViolations = violations; } };
  }

  async function eligibility(prepared: Awaited<ReturnType<typeof prepare>>) {
    return await prepared.api.actions.getEligibility(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId: prepared.proposed.proposalId });
  }

  it('makes a fully signed, unexpired, isolated validation eligible', async () => {
    const prepared = await prepare();
    await expect(eligibility(prepared)).resolves.toMatchObject({ status: 'eligible', blockingReasons: [] });
    const proposal = await f.databases.gotchu_executor.tenant(f.a.organizationId, tx => tx.query<{ body: unknown }>('SELECT body FROM gotchu.proposals WHERE organization_id=$1 AND application_id=$2 AND id=$3', [f.a.organizationId, f.a.applicationId, prepared.proposed.proposalId]));
    const verifier = prepared.verifierFor(f.databases.gotchu_executor);
    await expect(verifier.verify(actionV2Schema.parse(proposal.rows[0]?.body), { phase: 'execution' })).resolves.toMatchObject({ eligible: true, workflowExceptions: [] });
  });

  it('allows broker application locking during exact approval and records session authorization', async () => {
    const prepared = await prepare({ lockApplicationDuringRepositoryRead: true });
    await expect(eligibility(prepared)).resolves.toMatchObject({ status: 'eligible' });
    const approved = await prepared.api.actions.approve(identity(), {
      organizationId: f.a.organizationId, applicationId: f.a.applicationId,
      proposalId: prepared.proposed.proposalId, actionHash: prepared.proposed.actionHash,
    });
    const stored = await f.admin.query('SELECT authorization_method,proof_id FROM gotchu.approvals WHERE organization_id=$1 AND id=$2', [f.a.organizationId,approved.approvalId]);
    expect(stored.rows).toEqual([{ authorization_method: 'owner_session', proof_id: null }]);
  });

  it('returns specific blockers for missing, unsigned, inconclusive, and failed validations', async () => {
    const missing = await prepare({ runExists: false });
    expect((await eligibility(missing)).blockingReasons).toContain('validation_missing');

    const unsigned = await prepare({ signed: false });
    expect((await eligibility(unsigned)).blockingReasons).toContain('validation_unsigned');

    const inconclusive = await prepare({ evidence: passingValidationEvidence.map(item => item.kind === 'functional_suite' ? { ...item, result: 'inconclusive' as const } : item) });
    expect((await eligibility(inconclusive)).blockingReasons).toContain('validation_inconclusive');

    const failed = await prepare({ runState: 'failed' });
    expect((await eligibility(failed)).blockingReasons).toContain('validation_failed');
  });

  it('rejects bad signatures, expired evidence, tenant rebinding, and mismatched artifact digests', async () => {
    const badSignature = await prepare({ invalidSignatureKind: 'functional_suite' });
    expect((await eligibility(badSignature)).blockingReasons).toContain('validation_tampered');

    const expired = await prepare({ runState: 'expired', expiresAt: new Date(Date.now() - 60_000) });
    expect((await eligibility(expired)).blockingReasons).toContain('validation_expired');

    const wrongTenant = await prepare();
    wrongTenant.setFactsTransform(facts => {
      const attestations = facts.attestations as Array<{ payload: Record<string, unknown>; keyId: string; signature: string }>;
      return { ...facts, attestations: attestations.map(attestation => {
        const payload = { ...attestation.payload, organizationId: f.b.organizationId };
        return { ...attestation, payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), wrongTenant.keyPair.privateKey).toString('base64url') };
      }) };
    });
    expect((await eligibility(wrongTenant)).blockingReasons).toContain('validation_tampered');

    const digestMismatch = await prepare();
    const stored = await f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query<{ body: unknown }>('SELECT body FROM gotchu.proposals WHERE id=$1', [digestMismatch.proposed.proposalId]));
    const mismatchedAction = { ...actionV2Schema.parse(stored.rows[0]?.body), patchSha256: 'f'.repeat(64) };
    expect((await digestMismatch.verifier.verify(mismatchedAction, { phase: 'proposal' })).blockingReasons).toEqual(expect.arrayContaining(['execution_artifact_digest_mismatch', 'validation_tampered']));
  });

  it('requires cleanup and the locked runner rootfs before eligibility', async () => {
    const cleanup = await prepare({ cleanupVerified: false });
    expect((await eligibility(cleanup)).blockingReasons).toContain('runner_isolation_unverified');
    const wrongRootfs = await prepare({ rootfsDigest: 'f'.repeat(64) });
    expect((await eligibility(wrongRootfs)).blockingReasons).toContain('runner_isolation_unverified');
  });

  it('denies workflow violations by exact rule until an Owner records a matching exception', async () => {
    const prepared = await prepare();
    const violation = { path: '.github/workflows/ci.yml', rule: 'pull_request_target' as const };
    prepared.setWorkflowViolations([violation]);
    expect((await eligibility(prepared)).blockingReasons).toEqual(expect.arrayContaining(['repository_automation_unsafe', 'workflow_policy_rule:pull_request_target']));
    const exception = { organizationId: f.a.organizationId, applicationId: f.a.applicationId, repositoryLinkId: prepared.repositoryLinkId,
      workflowPath: violation.path, rule: violation.rule, justification: 'This workflow is reviewed and constrained.' };
    const { actionHash } = await prepared.api.workflowExceptions.getHash(identity(), exception);
    await prepared.api.workflowExceptions.create(identity(), { ...exception, actionHash });
    await expect(eligibility(prepared)).resolves.toMatchObject({ status: 'eligible', blockingReasons: [] });
    prepared.setWorkflowViolations([{ ...violation, rule: 'push_without_branch_filter' }]);
    expect((await eligibility(prepared)).blockingReasons).toContain('workflow_policy_rule:push_without_branch_filter');
  });
});
