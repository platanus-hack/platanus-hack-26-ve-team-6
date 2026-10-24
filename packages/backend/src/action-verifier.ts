import { actionV2Schema, customerSourceSnapshotSchema, validationFactsSchema } from '@gotchu/contracts';
import { computeGitTreeShaAfterPatch, type GitTree, type PatchFile, type WorkflowPolicyException, type WorkflowPolicyViolation } from '@gotchu/git-adapters';
import type { Database } from '@gotchu/database';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJson, sha256 } from './core.js';
import { scoreValidation, verifyValidationAttestation } from './validations.js';
import { createExecutionArtifactService } from './execution-artifacts.js';
import type { ActionEligibility, ActionVerifier } from './actions.js';
import { dependencyCommitMessage, expectedDependencyCommitSha } from './git-commit.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const workflowExceptionSchema = z.object({
  path: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
  rule: z.enum(['invalid_yaml','invalid_document','pull_request_target','push_without_branch_filter','push_to_gotchu_branch','forbidden_pull_request_secret']),
}).strict();
const factBundleSchema = validationFactsSchema.extend({
  runnerIsolationEvidence: z.unknown().nullable(),
  runExpiresAt: z.date(),
  runOrganizationId: z.uuid(),
  runApplicationId: z.uuid(),
  runActionRef: z.uuid(),
  storedRunId: z.uuid(),
  candidateSourceId: z.uuid(),
  validationMode: z.enum(['correction', 'dependency']),
  patchDigest: digest,
  candidateTreeDigest: digest,
  storedAttestations: z.array(z.object({ id: z.uuid(), keyId: digest, signature: z.string().min(1), expiresAt: z.date() }).strict()),
});
export type ValidationFactsPort = { getFacts(input: { organizationId: string; actionRef: string }): Promise<unknown | null> };

export interface ActionVerifierRepositoryPort {
  readHead(input: { organizationId: string; applicationId: string; repositoryKey: string; branch: string }): Promise<string>;
  readTree?(input: { organizationId: string; applicationId: string; repositoryKey: string; commitSha: string }): Promise<GitTree>;
  isPolicyCurrent(input: { organizationId: string; applicationId: string; capabilityId: string; policyVersion: string }): Promise<boolean>;
  inspectAutomation(input: { organizationId: string; applicationId: string; repositoryKey: string; baseCommit: string }): Promise<WorkflowPolicyViolation[]>;
}

function validationReason(raw: unknown, runner: {
  runnerIsolationEvidence: unknown; runExpiresAt: Date; runOrganizationId: string; runApplicationId: string;
  runActionRef: string; storedRunId: string; candidateSourceId: string; patchDigest: string; candidateTreeDigest: string;
  validationMode: 'correction' | 'dependency';
  storedAttestations: Array<{ id: string; keyId: string; signature: string; expiresAt: Date }>;
} | null, action: z.infer<typeof actionV2Schema>, rootfsDigest: string): string | null {
  if (raw === null) return 'validation_missing';
  if (!runner) return 'runner_isolation_unverified';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'validation_tampered';
  const parsed = factBundleSchema.safeParse({ ...raw, ...runner });
  if (!parsed.success) return 'validation_tampered';
  const facts = parsed.data;
  const expectedActionRef = action.kind === 'source_patch_pull_request'
    ? action.evidence.find(item => item.kind === 'private_correction_candidate')?.id
    : action.evidence[0]?.id;
  if (facts.runOrganizationId !== action.organizationId || facts.runApplicationId !== action.applicationId
    || facts.runActionRef !== facts.actionRef || facts.storedRunId !== facts.runId || facts.candidateSourceId !== expectedActionRef) return 'validation_tampered';
  if (action.kind === 'dependency_pull_request' && facts.validationMode !== 'dependency'
    || action.kind === 'source_patch_pull_request' && facts.validationMode !== 'correction') return 'validation_tampered';
  if (action.kind === 'source_patch_pull_request'
    && (facts.patchDigest !== action.patchSha256 || facts.candidateTreeDigest !== action.snapshotSha256)) return 'validation_tampered';
  const boundAttestationIds = action.kind === 'source_patch_pull_request' ? action.validationAttestationIds
    : action.kind === 'dependency_pull_request' ? [action.rescanAttestationId, action.suiteAttestationId] : [];
  if (facts.attestations.length === 0) return 'validation_unsigned';
  if (facts.attestations.length !== runner.storedAttestations.length) return 'validation_tampered';
  for (const attestation of facts.attestations) {
    const stored = runner.storedAttestations.find(item => item.id === attestation.payload.id);
    if (!stored || stored.keyId !== attestation.keyId || stored.signature !== attestation.signature) return 'validation_tampered';
    if (stored.expiresAt.getTime() <= Date.now() || Date.parse(attestation.payload.expiresAt) <= Date.now()) return 'validation_expired';
    if (stored.expiresAt.getTime() !== Date.parse(attestation.payload.expiresAt)) return 'validation_tampered';
  }
  if (new Set(facts.attestations.map(attestation => attestation.payload.id)).size !== facts.attestations.length
    || action.kind === 'source_patch_pull_request' && (boundAttestationIds.length === 0 || boundAttestationIds.length !== facts.attestations.length
      || boundAttestationIds.some(id => !facts.attestations.some(attestation => attestation.payload.id === id)))
    || action.kind === 'dependency_pull_request' && (boundAttestationIds.length !== 2
      || boundAttestationIds.some(id => !facts.attestations.some(attestation => attestation.payload.id === id)))) return 'validation_tampered';
  const keys = new Map(facts.keys.map(key => [key.keyId, key.publicKey]));
  if (facts.attestations.some(attestation => !keys.has(attestation.keyId))) return 'validation_unsigned';
  if (facts.attestations.some(attestation => {
    const publicKey = keys.get(attestation.keyId);
    return !publicKey || !verifyValidationAttestation(attestation, publicKey);
  })) return 'validation_tampered';
  if (facts.attestations.some(({ payload }) => payload.organizationId !== action.organizationId
      || payload.applicationId !== action.applicationId || payload.actionRef !== facts.actionRef || payload.actionRef !== expectedActionRef
      || payload.runId !== facts.runId)) return 'validation_tampered';
  if (!expectedActionRef || facts.actionRef !== expectedActionRef) return 'validation_tampered';
  if (action.kind === 'dependency_pull_request') {
    const rescan = facts.attestations.find(item => item.payload.id === action.rescanAttestationId);
    const suite = facts.attestations.find(item => item.payload.id === action.suiteAttestationId);
    if (rescan?.payload.evidence.kind !== 'independent_rescan' || rescan.payload.evidence.result !== 'passed'
      || suite?.payload.evidence.kind !== 'functional_suite' || suite.payload.evidence.result !== 'passed') return 'validation_tampered';
  }
  if (facts.state === 'failed') return 'validation_failed';
  if (facts.state === 'expired' || facts.runExpiresAt.getTime() <= Date.now()) return 'validation_expired';
  if (facts.state !== 'passed') return 'validation_inconclusive';
  const score = scoreValidation(facts.attestations.map(item => item.payload.evidence), action.kind === 'dependency_pull_request' ? 'dependency' : 'correction');
  if (score.state === 'inconclusive') return 'validation_inconclusive';
  if (score.state === 'failed') return 'validation_failed';
  if (action.kind === 'dependency_pull_request') {
    const rescan = facts.attestations.map(item => item.payload.evidence).find(item => item.kind === 'independent_rescan');
    if (!rescan || rescan.kind !== 'independent_rescan') return 'validation_tampered';
    const keys = action.changes.flatMap(change => action.advisoryIds.map(id => `npm:${change.name}:${id}`));
    if (keys.some(key => !rescan.targetedIdentities.includes(key) || !rescan.before.identities.includes(key) || rescan.after.identities.includes(key))) return 'validation_failed';
  }
  const isolation = facts.runnerIsolationEvidence;
  const parsedIsolation = z.object({ sandbox:z.object({ kind:z.string() }).passthrough(), cleanupVerified:z.boolean(), rootfsDigest:digest.nullable() }).passthrough().safeParse(isolation);
  if (!parsedIsolation.success || parsedIsolation.data.cleanupVerified !== true || parsedIsolation.data.rootfsDigest !== rootfsDigest
      || !['bwrap+systemd-scope', 'jailer'].includes(parsedIsolation.data.sandbox.kind)) return 'runner_isolation_unverified';
  return null;
}

/** Independent source/repository checks; no facts supplied by the browser or model are trusted. */
export function createActionVerifier(input: {
  database: Database;
  repository: ActionVerifierRepositoryPort;
  validationFacts: ValidationFactsPort;
  pinnedRootfsDigest: string;
}): ActionVerifier {
  const rootfsDigest = digest.parse(input.pinnedRootfsDigest);
  const repository = input.repository;
  return {
    async getValidationAttestationIds(action) {
      if (action.kind !== 'source_patch_pull_request') return [];
      const actionRef = action.evidence.find(item => item.kind === 'private_correction_candidate')?.id;
      if (!actionRef) return [];
      const raw = await input.validationFacts.getFacts({ organizationId: action.organizationId, actionRef });
      const facts = validationFactsSchema.safeParse(raw);
      return facts.success ? facts.data.attestations.map(attestation => attestation.payload.id) : [];
    },
    async prepareArtifact(input: { organizationId: string; applicationId: string; repositoryKey: string; baseCommit: string; files: readonly PatchFile[] }) {
      if (!input.files.length || !repository.readTree) return { treeSha: null, unsupportedReason: input.files.length ? 'repository_tree_unavailable' : 'artifact_patch_unsupported' };
      let tree: GitTree;
      try {
        tree = await repository.readTree({
          organizationId: input.organizationId,
          applicationId: input.applicationId,
          repositoryKey: input.repositoryKey,
          commitSha: input.baseCommit,
        });
      } catch {
        return { treeSha: null, unsupportedReason: 'repository_tree_unavailable' };
      }
      if (tree.truncated) return { treeSha: null, unsupportedReason: 'repository_tree_truncated' };
      const entries = new Map(tree.entries.map(entry => [entry.path, entry]));
      const entryPaths = [...entries.keys()].sort();
      const hasDescendant = (path: string) => {
        const prefix = `${path}/`;
        let low = 0; let high = entryPaths.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if ((entryPaths[middle] ?? '') < prefix) low = middle + 1;
          else high = middle;
        }
        return entryPaths[low]?.startsWith(prefix) ?? false;
      };
      const hasFileAncestor = (path: string) => {
        const parts = path.split('/');
        return parts.slice(1).some((_, index) => entries.has(parts.slice(0, index + 1).join('/')));
      };
      if (input.files.some(file => {
        const existing = entries.get(file.path);
        return (existing !== undefined && (existing.type !== 'blob' || existing.mode !== '100644'))
          || hasDescendant(file.path) || hasFileAncestor(file.path);
      })) return { treeSha: null, unsupportedReason: 'artifact_patch_unsupported' };
      try {
        return { treeSha: computeGitTreeShaAfterPatch(tree, input.files), unsupportedReason: null };
      } catch {
        return { treeSha: null, unsupportedReason: 'repository_tree_unavailable' };
      }
    },
    async verify(rawAction): Promise<ActionEligibility> {
      const action = actionV2Schema.parse(rawAction);
      if (action.kind !== 'source_patch_pull_request' && action.kind !== 'dependency_pull_request') {
        return { eligible: false, blockingReasons: ['sin adaptador de escritura'] };
      }
      const link = await input.database.tenant(action.organizationId, async tx => {
        type RepositoryLink = {
          repository_key: string; default_branch: string; state: string; revoked: boolean; write_access: string;
          installation_id: string | null; installation_state: string | null;
        };
        const result = action.kind === 'dependency_pull_request'
          ? await tx.query<RepositoryLink>(`SELECT l.repository_key,l.default_branch,l.state,l.revoked,l.write_access,l.installation_id,g.state AS installation_state
              FROM gotchu.application_repository_links l LEFT JOIN gotchu.github_installations g
                ON g.organization_id=l.organization_id AND g.installation_id=l.installation_id
              WHERE l.organization_id=$1 AND l.application_id=$2 AND l.id=$3`,
          [action.organizationId, action.applicationId, action.target.repositoryLinkId])
          : await tx.query<RepositoryLink>(`SELECT repository_key,default_branch,state,revoked,write_access,
                NULL::text AS installation_id,NULL::text AS installation_state
              FROM gotchu.application_repository_links
              WHERE organization_id=$1 AND application_id=$2 AND id=$3`,
          [action.organizationId, action.applicationId, action.target.repositoryLinkId]);
        return result.rows[0];
      });
      const linkValid = link !== undefined && !link.revoked && link.state === 'verified'
        && link.write_access === 'granted' && link.repository_key === action.target.repositoryKey
        && link.default_branch === action.target.branch;
      const githubConnectionValid = action.kind !== 'dependency_pull_request'
        || link !== undefined && link.installation_id !== null && link.installation_state === 'active';
      const capability = await input.database.tenant(action.organizationId, async tx => {
        const result = await tx.query<{ capability_id: string; adapter_available: boolean }>(
          'SELECT capability_id,adapter_available FROM gotchu.action_capabilities WHERE kind=$1', [action.kind],
        );
        return result.rows[0];
      });
      const candidate = action.kind === 'source_patch_pull_request'
        ? z.object({ id:z.uuid(),sha256:digest,kind:z.literal('private_correction_candidate') }).strict().safeParse(action.evidence.find(item => item.kind === 'private_correction_candidate'))
        : null;
      if (candidate && !candidate.success) return { eligible:false,blockingReasons:['artefacto candidato inválido'] };
      const dependencyCandidate = action.kind === 'dependency_pull_request'
        ? z.object({ id:z.uuid(),sha256:digest,kind:z.literal('dependency_candidate') }).strict().safeParse(action.evidence.find(item => item.kind === 'dependency_candidate'))
        : null;
      if (dependencyCandidate && !dependencyCandidate.success) return { eligible:false,blockingReasons:['dependency_candidate_invalid'] };

      let artifactValid = action.kind !== 'source_patch_pull_request' && action.kind !== 'dependency_pull_request';
      let artifactReason = 'execution_artifact_missing';
      if (action.kind === 'source_patch_pull_request' && candidate?.success) {
        const artifacts = await input.database.tenant(action.organizationId, async tx => {
          const sourceResult = await tx.query<{ body: unknown; digest: string; deleted_at: Date | null }>(
            'SELECT body,digest,deleted_at FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3',
            [action.organizationId, action.applicationId, candidate.data.id],
          );
          const auditResult = await tx.query<{ detail: unknown }>(`SELECT detail FROM gotchu.audit_records
            WHERE organization_id=$1 AND subject_id=$2 AND action='correction.prepared' ORDER BY created_at DESC LIMIT 1`,
          [action.organizationId,candidate.data.id]);
          return { source:sourceResult.rows[0],preparation:auditResult.rows[0]?.detail };
        });
        const preparation=z.object({candidateSourceDigest:digest,patchHash:digest}).passthrough().safeParse(artifacts.preparation);
        if (artifacts.source?.body && artifacts.source.deleted_at === null && artifacts.source.digest === candidate.data.sha256
          && preparation.success && preparation.data.candidateSourceDigest===candidate.data.sha256 && preparation.data.patchHash===action.patchSha256) {
          const snapshot = customerSourceSnapshotSchema.safeParse(artifacts.source.body);
          artifactValid = snapshot.success && sha256(canonicalJson(snapshot.data)) === artifacts.source.digest;
        }
        const artifactCheck = await createExecutionArtifactService(input.database).verifyCandidateDigest({
          organizationId:action.organizationId,applicationId:action.applicationId,candidateSourceId:candidate.data.id,
          snapshotSha256:action.snapshotSha256,patchSha256:action.patchSha256,
        });
        artifactValid = artifactValid && artifactCheck.valid;
      artifactValid = artifactValid && Boolean(action.expectedTreeSha && artifactCheck.treeSha === action.expectedTreeSha);
        artifactReason = artifactCheck.unsupportedReason ?? 'execution_artifact_digest_mismatch';
      }
      if (action.kind === 'dependency_pull_request' && dependencyCandidate?.success) {
        const metadata = await input.database.tenant(action.organizationId, async tx => {
          const result = await tx.query<{
            candidate_source_id:string;repository_link_id:string;base_commit:string;base_digest:string;package_name:string;from_version:string;to_version:string;
            advisory_ids:unknown;lockfile_sha256:string;patch_sha256:string;candidate_digest:string;validation_run_id:string;
            source_digest:string;source_deleted_at:Date|null;bound_repository_link_id:string;binding_commit:string;binding_digest:string;
            validation_state:string;validation_mode:string;tree_sha:string|null;commit_message:string;tree_complete:boolean;
          }>(`SELECT c.candidate_source_id,c.repository_link_id,c.base_commit,c.base_digest,c.package_name,c.from_version,c.to_version,c.advisory_ids,c.lockfile_sha256,c.patch_sha256,c.candidate_digest,c.validation_run_id,
              s.digest AS source_digest,s.deleted_at AS source_deleted_at,b.repository_link_id AS bound_repository_link_id,b.commit_sha AS binding_commit,b.source_digest AS binding_digest,
              v.state AS validation_state,v.validation_mode,a.tree_sha,a.commit_message,a.tree_complete
            FROM gotchu.dependency_fix_candidates c
            JOIN gotchu.customer_sources s ON s.organization_id=c.organization_id AND s.application_id=c.application_id AND s.id=c.candidate_source_id
            JOIN gotchu.customer_source_repository_bindings b ON b.organization_id=c.organization_id AND b.application_id=c.application_id AND b.source_id=c.base_source_id
            JOIN gotchu.validation_runs v ON v.organization_id=c.organization_id AND v.application_id=c.application_id AND v.id=c.validation_run_id
            JOIN gotchu.execution_artifacts a ON a.organization_id=c.organization_id AND a.application_id=c.application_id AND a.candidate_source_id=c.candidate_source_id
            WHERE c.organization_id=$1 AND c.application_id=$2 AND c.candidate_source_id=$3`, [action.organizationId,action.applicationId,dependencyCandidate.data.id]);
          return result.rows[0];
        });
        const advisoryIds = metadata ? z.array(z.string().regex(/^[A-Za-z0-9._-]{1,128}$/)).min(1).max(20).safeParse(metadata.advisory_ids) : null;
        const change = action.changes.length === 1 ? action.changes[0] : undefined;
        const metadataValid = metadata !== undefined && advisoryIds?.success === true && change !== undefined
          && metadata.candidate_source_id === dependencyCandidate.data.id && metadata.source_digest === dependencyCandidate.data.sha256
          && metadata.source_deleted_at === null && metadata.repository_link_id === action.target.repositoryLinkId
          && metadata.bound_repository_link_id === action.target.repositoryLinkId && metadata.base_commit === action.baseCommit
          && metadata.binding_commit === action.baseCommit && metadata.binding_digest === metadata.base_digest
          && metadata.package_name === change.name && metadata.from_version === change.from && metadata.to_version === change.to
          && canonicalJson(advisoryIds.data) === canonicalJson(action.advisoryIds) && metadata.lockfile_sha256 === action.lockfileSha256
          && metadata.patch_sha256 === action.patchSha256 && metadata.validation_state === 'passed' && metadata.validation_mode === 'dependency'
          && metadata.tree_complete && metadata.tree_sha !== null
          && action.candidateCommit === expectedDependencyCommitSha(metadata.tree_sha, metadata.base_commit,
            dependencyCommitMessage({ packageName: metadata.package_name, fromVersion: metadata.from_version, toVersion: metadata.to_version }));
        const artifactCheck = await createExecutionArtifactService(input.database).verifyCandidateDigest({
          organizationId:action.organizationId,applicationId:action.applicationId,candidateSourceId:dependencyCandidate.data.id,
          snapshotSha256:dependencyCandidate.data.sha256,patchSha256:action.patchSha256,
        });
        artifactValid = Boolean(metadataValid && artifactCheck.valid);
        artifactReason = artifactCheck.unsupportedReason ?? 'dependency_candidate_invalid';
      }

      let currentHead: string;
      try {
        currentHead = await input.repository.readHead({ organizationId:action.organizationId,applicationId:action.applicationId,repositoryKey:action.target.repositoryKey,branch:action.target.branch });
      } catch {
        return { eligible:false,blockingReasons:['base del repositorio desconocida'] };
      }
      const actionRef = candidate?.success ? candidate.data.id : dependencyCandidate?.success ? dependencyCandidate.data.id : action.evidence[0]?.id;
      let facts: unknown | null = null;
      let factsUnavailable = false;
      if (actionRef) {
        try { facts = await input.validationFacts.getFacts({ organizationId: action.organizationId, actionRef }); }
        catch { factsUnavailable = true; }
      }
      const runner = facts === null ? null : await input.database.tenant(action.organizationId, async tx => {
        const result = await tx.query<{ organization_id: string; application_id: string; id: string; action_ref: string; candidate_source_id: string; patch_digest: string; candidate_tree_digest: string; validation_mode: string; sandbox_kind: string; rootfs_digest: string | null; cleanup_verified: boolean; expires_at: Date }>(`SELECT organization_id,application_id,id,action_ref,candidate_source_id,patch_digest,candidate_tree_digest,validation_mode,sandbox_kind,rootfs_digest,cleanup_verified,expires_at FROM gotchu.validation_runs WHERE organization_id=$1 AND application_id=$2 AND action_ref=$3`, [action.organizationId, action.applicationId, actionRef]);
        const row = result.rows[0];
        if (!row) return null;
        const storedAttestations = await tx.query<{ id: string; key_id: string; signature: string; expires_at: Date }>(`SELECT id,key_id,signature,expires_at FROM gotchu.validation_attestations
          WHERE organization_id=$1 AND application_id=$2 AND run_id=$3 ORDER BY created_at,id`, [action.organizationId, action.applicationId, row.id]);
        return {
          runnerIsolationEvidence: { sandbox: { kind: row.sandbox_kind }, cleanupVerified: row.cleanup_verified, rootfsDigest: row.rootfs_digest },
          runExpiresAt: row.expires_at, runOrganizationId: row.organization_id, runApplicationId: row.application_id,
          runActionRef: row.action_ref, storedRunId: row.id, candidateSourceId: row.candidate_source_id,
          patchDigest: row.patch_digest, candidateTreeDigest: row.candidate_tree_digest,
          validationMode: row.validation_mode === 'dependency' ? 'dependency' as const : 'correction' as const,
          storedAttestations: storedAttestations.rows.map(item => ({ id: item.id, keyId: item.key_id, signature: item.signature, expiresAt: item.expires_at })),
        };
      });
      const reason = factsUnavailable ? 'validation_inconclusive' : validationReason(facts, runner, action, rootfsDigest);
      const reasons: string[] = [];
      if (!linkValid) reasons.push('vínculo de repositorio no autorizado o cambiado');
      if (!githubConnectionValid) reasons.push('github_connection_unavailable');
      if (capability?.capability_id !== action.capabilityId || !capability.adapter_available) reasons.push('adaptador no habilitado para la capacidad');
      const policyCurrent = await input.repository.isPolicyCurrent({ organizationId:action.organizationId,applicationId:action.applicationId,capabilityId:action.capabilityId,policyVersion:action.policyVersion }).catch(() => false);
      if (!policyCurrent) reasons.push('política vigente no verificada');
      if (!artifactValid) reasons.push(artifactReason);
      if (reason) reasons.push(reason);
      if (currentHead !== action.baseCommit) reasons.push('base cambió desde la propuesta');
      let violations: WorkflowPolicyViolation[];
      let workflowExceptions: WorkflowPolicyException[] = [];
      try {
        violations = await input.repository.inspectAutomation({ organizationId:action.organizationId,applicationId:action.applicationId,repositoryKey:action.target.repositoryKey,baseCommit:action.baseCommit });
      } catch {
        violations = [];
        reasons.push('repository_automation_unsafe', 'workflow_policy_unavailable');
      }
      if (violations.length) {
        const exceptionRows = await input.database.tenant(action.organizationId, async tx => {
          const result = await tx.query<{ workflow_path: string; rule: string }>(`SELECT workflow_path,rule FROM gotchu.workflow_policy_exceptions
            WHERE organization_id=$1 AND application_id=$2 AND repository_link_id=$3 AND removed_at IS NULL`,
          [action.organizationId, action.applicationId, action.target.repositoryLinkId]);
          return result.rows;
        });
        const parsedExceptions = z.array(workflowExceptionSchema).safeParse(exceptionRows.map(row => ({ path: row.workflow_path, rule: row.rule })));
        if (!parsedExceptions.success) {
          reasons.push('repository_automation_unsafe', 'workflow_policy_registry_invalid', ...violations.map(violation => `workflow_policy_rule:${violation.rule}`));
        } else {
          workflowExceptions = parsedExceptions.data.filter(exception => violations.some(violation =>
            exception.path === violation.path && exception.rule === violation.rule));
          const denied = violations.filter(violation => !workflowExceptions.some(exception =>
            exception.path === violation.path && exception.rule === violation.rule));
          if (denied.length) reasons.push('repository_automation_unsafe', ...denied.map(violation => `workflow_policy_rule:${violation.rule}`));
        }
      }
      return { eligible:reasons.length===0,blockingReasons:reasons,policyCurrent,workflowExceptions };
    },
  };
}

function findRunnerImagesLock(): string {
  let directory = process.cwd();
  while (true) {
    const candidate = resolve(directory, 'packages/runner/images.lock.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('runner_images_lock_unavailable');
}

/** Read the pinned runner root filesystem digest once during web runtime startup. */
export function readPinnedRootfsDigest(lockfile = findRunnerImagesLock()): string {
  const lock = z.object({ rootfs: z.object({ sha256: digest }).passthrough() }).passthrough().parse(JSON.parse(readFileSync(lockfile, 'utf8')));
  return lock.rootfs.sha256;
}

export function snapshotDigest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
