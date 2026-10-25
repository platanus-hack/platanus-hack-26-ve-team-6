import { createHash, randomUUID } from 'node:crypto';
import { actionV2Schema, customerSourceSnapshotSchema, scoreIndependentRescan, validationAttestationPayloadSchema, type ActionV2 } from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { computeGitTreeSha, type PatchFile, type WorkflowPolicyException } from '@gotchu/git-adapters';
import { z } from 'zod';
import { audit, authorize, BackendError, canonicalJson, parse, sha256, systemClock, type BaseDependencies, type Identity } from './core.js';
import { APPROVAL_TTL_MS, STEP_UP_MAX_AGE_MS, assertStepUp, verifiedStepUpSchema, type StepUpVerifier } from './proposals.js';
import { enqueue } from './jobs.js';
import { dependencyCommitMessage, expectedDependencyCommitSha } from './git-commit.js';
import { actionPolicyVersion } from './action-policies.js';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const actionHashSchema = digest;
const correctionSourceRefSchema = z.object({ type: z.literal('correction_candidate'), candidateId: z.uuid() }).strict();
const dependencySourceRefSchema = z.object({ type: z.literal('dependency_candidate'), candidateId: z.uuid() }).strict();
const gitCommit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const proposeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source_patch_pull_request'), sourceRef: correctionSourceRefSchema }).strict(),
  z.object({ kind: z.literal('dependency_pull_request'), sourceRef: dependencySourceRefSchema }).strict(),
]);
const actionRowSchema = z.object({ id: z.uuid(), actionHash: digest, action: actionV2Schema, state: z.enum(['proposed','eligible','ineligible','approved','expired','invalidated','executing','succeeded','failed','uncertain','reconciliation_required']), blockingReasons: z.array(z.string()), createdAt: z.date() }).strict();

export type ActionEligibility = { eligible: boolean; blockingReasons: string[]; baseChanged?: boolean; policyCurrent?: boolean; workflowExceptions?: readonly WorkflowPolicyException[] };
export interface ActionVerifier {
  verify(action: ActionV2, context: { phase: 'proposal' | 'approval' | 'execution' }): Promise<ActionEligibility>;
  getValidationAttestationIds?(action: ActionV2): Promise<readonly string[]>;
  prepareArtifact?(input: { organizationId: string; applicationId: string; repositoryKey: string; baseCommit: string; files: readonly PatchFile[] }): Promise<{ treeSha: string | null; unsupportedReason: string | null }>;
}
export interface ActionDependencies extends BaseDependencies { actionVerifier?: ActionVerifier; stepUpVerifier?: StepUpVerifier }

export function hashActionV2(action: ActionV2, recoveryEpoch: string): string {
  return sha256('gotchu-action-v2\n' + canonicalJson({ action: parse(actionV2Schema, action), recoveryEpoch: parse(z.string().regex(/^[1-9][0-9]*$/), recoveryEpoch) }));
}

function publicProjection(row: z.infer<typeof actionRowSchema>, details: { path?: string; diffSummary?: string }, execution: { status: string | null; pullRequestUrl: string | null; attempts: Array<Record<string, unknown>> } = { status:null,pullRequestUrl:null,attempts:[] }) {
  const kindLabel = row.action.kind === 'source_patch_pull_request' ? 'Abrir una solicitud de cambio para una corrección de código'
    : row.action.kind === 'dependency_pull_request' ? 'Abrir una solicitud de cambio para actualizar dependencias npm' : 'Acción propuesta';
  const blockerText: Record<string, string> = {
    'validación en VM no disponible': 'La validación en VM no está disponible. Mantén la propuesta en privado hasta configurar un verificador aislado.',
    'sin adaptador de escritura': 'No hay un adaptador de escritura disponible. No se modificará ningún repositorio.',
    'MFA requerido': 'Hace falta una verificación de seguridad reciente antes de aprobar.',
    'executor no disponible': 'El ejecutor independiente no está disponible con permisos de escritura en este momento.',
    'vínculo de repositorio sin verificar': 'Verifica el vínculo del repositorio en el contexto de la aplicación.',
    'validaciones pendientes': 'Completa el reanálisis objetivo y la suite pertinente antes de solicitar aprobación.',
    'base cambió desde la propuesta': 'La rama base cambió. Prepara y valida una propuesta nueva antes de aprobar.',
    'dependency_candidate_invalid': 'La instantánea de dependencias no coincide con la propuesta guardada.',
    'dependency_validation_missing': 'La validación independiente de la dependencia aún no está disponible.',
  };
  return {
    id: row.id, actionHash: row.actionHash, kind: row.action.kind, state: row.state,
    effect: kindLabel, scope: `Aplicación ${row.action.applicationId}`, target: row.action.target,
    cost: { state: 'unknown' as const, amount: null },
    diff: row.action.kind === 'dependency_pull_request'
      ? { path: 'package.json · package-lock.json', summary: details.diffSummary ?? row.action.changes.map(change => `${change.name}: ${change.from} → ${change.to}`).join('; ') }
      : details.path ? { path: details.path, summary: details.diffSummary ?? 'Cambio privado de una receta; el contenido del código no se comparte en esta vista.' } : null,
    validations: row.action.kind === 'dependency_pull_request'
      ? [{ label: 'reanálisis objetivo', state: row.state === 'eligible' ? 'passed' : 'pending' }, { label: 'suite configurada', state: row.state === 'eligible' ? 'passed' : 'pending' }]
      : [{ label: 'reanálisis objetivo', state: row.state === 'eligible' ? 'passed' : 'pending' }, { label: 'suite configurada', state: row.state === 'eligible' ? 'passed' : 'pending' }],
    limits: [execution.status ? 'Gotchu no fusionó el cambio ni lo desplegó.' : 'No se ha escrito en Git ni en producción.', 'La severidad y el texto de una recomendación no conceden permisos.'],
    blockingReasons: row.blockingReasons.map(reason => blockerText[reason] ?? reason),
    execution,
    createdAt: row.createdAt.toISOString(),
  };
}

const executionStateSchema = z.enum(['claimed','succeeded','failed','uncertain']);
const attemptEventSchema = z.object({
  attempt: z.number().int().positive(), step: z.enum(['claim','publish_branch','open_pr','verify']),
  state: z.enum(['claimed','branch_published','pr_opened','verified','failed','uncertain','reconciliation_required']),
  providerReference: z.string().min(1).max(1000).nullable(), detail: z.unknown(), occurredAt: z.date(),
}).strict();
const attemptDetailSchema = z.object({ reasonCode: z.string().max(100).optional(), branch: z.string().max(300).optional(), pullRequestNumber: z.number().int().positive().optional() }).strict();

function publicProviderUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname) ? url.toString() : null;
  } catch { return null; }
}

async function loadExecutionHistory(tx: Transaction, organizationId: string, proposalIds: readonly string[]) {
  const histories = new Map<string, { status: string | null; pullRequestUrl: string | null; attempts: Array<Record<string, unknown>> }>();
  for (const proposalId of proposalIds) histories.set(proposalId, { status: null, pullRequestUrl: null, attempts: [] });
  if (!proposalIds.length) return histories;
  const result = await tx.query<{
    proposal_id: string; execution_state: string; execution_reference: string | null; attempt: number | null;
    step: string | null; state: string | null; provider_reference: string | null; detail: unknown; occurred_at: Date | null;
  }>(`SELECT e.proposal_id,e.state AS execution_state,e.provider_reference AS execution_reference,
      ev.attempt,ev.step,ev.state,ev.provider_reference,ev.detail,ev.occurred_at
    FROM gotchu.executions e LEFT JOIN gotchu.executor_attempt_events ev
      ON ev.organization_id=e.organization_id AND ev.execution_id=e.id
    WHERE e.organization_id=$1 AND e.proposal_id=ANY($2::uuid[])
    ORDER BY e.created_at,e.id,ev.occurred_at,ev.attempt,ev.step`, [organizationId, proposalIds]);
  for (const row of result.rows) {
    const history = histories.get(row.proposal_id);
    if (!history) continue;
    history.status = executionStateSchema.parse(row.execution_state);
    history.pullRequestUrl = publicProviderUrl(row.execution_reference) ?? history.pullRequestUrl;
    if (row.attempt === null || row.step === null || row.state === null || row.occurred_at === null) continue;
    const event = attemptEventSchema.parse({ attempt:row.attempt,step:row.step,state:row.state,providerReference:row.provider_reference,detail:row.detail,occurredAt:row.occurred_at });
    const detail = attemptDetailSchema.parse(event.detail);
    const providerUrl = publicProviderUrl(event.providerReference);
    history.pullRequestUrl = providerUrl ?? history.pullRequestUrl;
    history.attempts.push({ attempt:event.attempt,step:event.step,state:event.state,reasonCode:detail.reasonCode ?? null,branch:detail.branch ?? null,pullRequestNumber:detail.pullRequestNumber ?? null,occurredAt:event.occurredAt.toISOString() });
  }
  return histories;
}

function publicReasons(blockingReasons: unknown, invalidationReason: string | null) {
  const reasons = z.array(z.string().max(500)).max(20).safeParse(blockingReasons);
  if (reasons.success && reasons.data.length) return reasons.data;
  const known: Record<string, string> = {
    recovery_epoch_changed: 'propuesta invalidada tras una recuperación', base_changed: 'La base del repositorio cambió; prepara y valida una propuesta nueva.',
    policy_changed: 'La política de esta acción cambió; prepara y valida una propuesta nueva.',
    cancelled: 'La propuesta se canceló antes de ejecutarse.', rejected: 'La propuesta se rechazó antes de ejecutarse.',
  };
  return invalidationReason ? [known[invalidationReason] ?? 'La propuesta se invalidó y debe prepararse de nuevo.'] : [];
}

async function loadCandidate(tx: Transaction, scope: { organizationId: string; applicationId: string }, candidateId: string) {
  const sourceResult = await tx.query<{ body: unknown; digest: string; deleted_at: Date | null }>(`SELECT body,digest,deleted_at FROM gotchu.customer_sources
    WHERE organization_id=$1 AND application_id=$2 AND id=$3`, [scope.organizationId, scope.applicationId, candidateId]);
  const source = sourceResult.rows[0];
  if (!source || source.deleted_at) throw new BackendError('candidate_unavailable', 'Private correction candidate is unavailable', 409);
  const auditResult = await tx.query<{ detail: unknown }>(`SELECT detail FROM gotchu.audit_records
    WHERE organization_id=$1 AND subject_id=$2 AND action='correction.prepared' ORDER BY created_at DESC LIMIT 1`, [scope.organizationId, candidateId]);
  const detail = z.object({ recipeId: z.string().min(1).max(100), recipeVersion: z.string().min(1).max(100), findingId: z.string().min(1).max(256), patchHash: digest, candidateSourceDigest: digest, path: z.string().min(1).max(512), paths: z.array(z.string().min(1).max(512)).min(1).max(4).optional(), originalSourceId: z.uuid().optional(), sourceDigest: digest.optional() }).passthrough().safeParse(auditResult.rows[0]?.detail);
  if (!detail.success || detail.data.candidateSourceDigest !== source.digest) throw new BackendError('candidate_mismatch', 'Stored correction metadata does not match the private candidate', 409);
  const linkResult = await tx.query<{ id: string; repository_key: string; default_branch: string; state: string; revoked: boolean; write_access: string }>(`SELECT id,repository_key,default_branch,state,revoked,write_access FROM gotchu.application_repository_links
    WHERE organization_id=$1 AND application_id=$2 AND NOT revoked ORDER BY created_at,id LIMIT 2`, [scope.organizationId, scope.applicationId]);
  if (linkResult.rows.length !== 1) throw new BackendError('repository_link_ambiguous', 'Exactly one active repository link is required to resolve the action target', 409);
  const link = linkResult.rows[0];
  if (!link) throw new BackendError('repository_link_unavailable', 'Repository link is missing or revoked', 409);
  const snapshot = parse(customerSourceSnapshotSchema, source.body);
  if (sha256(canonicalJson(snapshot)) !== source.digest) throw new BackendError('candidate_mismatch', 'Stored correction snapshot failed its digest check', 409);
  let patchFiles: PatchFile[] = [];
  let artifactUnsupportedReason: string | null = 'source_snapshot_completeness_unknown';
  if (detail.data.originalSourceId && detail.data.sourceDigest) {
    const originalResult = await tx.query<{ body: unknown; digest: string; deleted_at: Date | null }>(`SELECT body,digest,deleted_at FROM gotchu.customer_sources
      WHERE organization_id=$1 AND application_id=$2 AND id=$3`, [scope.organizationId, scope.applicationId, detail.data.originalSourceId]);
    const original = originalResult.rows[0];
    if (original && original.deleted_at === null && original.digest === detail.data.sourceDigest) {
      const baseSnapshot = customerSourceSnapshotSchema.safeParse(original.body);
      if (baseSnapshot.success && sha256(canonicalJson(baseSnapshot.data)) === original.digest && baseSnapshot.data.revision === snapshot.revision) {
        const before = new Map(baseSnapshot.data.files.map(file => [file.path, file.content]));
        const after = new Map(snapshot.files.map(file => [file.path, file.content]));
        const removed = [...before.keys()].filter(path => !after.has(path));
        const changed = snapshot.files.filter(file => before.get(file.path) !== file.content);
        const paths = detail.data.recipeId === 'ai-source-fix' ? detail.data.paths : [detail.data.path];
        const exactPaths = paths !== undefined && new Set(paths).size === paths.length && paths[0] === detail.data.path
          && changed.length === paths.length && changed.every(file => paths.includes(file.path) && before.has(file.path));
        if (removed.length === 0 && exactPaths) {
          patchFiles = changed.map(file => ({ path: file.path, content: file.content, mode: '100644' as const }));
          artifactUnsupportedReason = null;
        } else {
          artifactUnsupportedReason = 'artifact_patch_unsupported';
        }
      } else {
        artifactUnsupportedReason = 'artifact_patch_unsupported';
      }
    } else {
      artifactUnsupportedReason = 'artifact_patch_unsupported';
    }
  }
  const baseCommit = parse(gitCommit, snapshot.revision);
  const parsedAction = parse(actionV2Schema, {
    version: 2, kind: 'source_patch_pull_request', capabilityId: 'repository.source_patch_pr', organizationId: scope.organizationId, applicationId: scope.applicationId,
    policyVersion: actionPolicyVersion('repository.source_patch_pr') ?? 'unregistered-policy', target: { kind: 'repository', repositoryLinkId: link.id, repositoryKey: link.repository_key, branch: link.default_branch },
    baseCommit, recipeId: detail.data.recipeId, recipeVersion: detail.data.recipeVersion, snapshotSha256: source.digest, patchSha256: detail.data.patchHash,
    findingIdentities: [detail.data.findingId], validationAttestationIds: [], evidence: [{ id: candidateId, sha256: source.digest, kind: 'private_correction_candidate' }],
  });
  if (parsedAction.kind !== 'source_patch_pull_request') throw new BackendError('candidate_invalid', 'A source correction candidate must resolve to a source patch action', 409);
  const action = parsedAction;
  const blockingReasons = [
    ...(link.state !== 'verified' ? ['vínculo de repositorio sin verificar'] : []),
    ...(link.write_access !== 'granted' ? ['permiso de escritura del repositorio no concedido'] : []),
  ];
  return { action, path: detail.data.path, snapshot, patchFiles, artifactUnsupportedReason, blockingReasons };
}

type DependencyCandidate = {
  candidateSourceId: string;
  baseSourceId: string;
  repositoryLinkId: string;
  repositoryKey: string;
  branch: string;
  baseCommit: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  advisoryIds: string[];
  lockfileSha256: string;
  patchSha256: string;
  candidateDigest: string;
  validationRunId: string;
  rescanAttestationId: string;
  suiteAttestationId: string;
  patchFiles: PatchFile[];
  diffSummary: string;
};

async function loadDependencyCandidate(tx: Transaction, scope: { organizationId: string; applicationId: string }, candidateId: string): Promise<DependencyCandidate> {
  const result = await tx.query<{
    candidate_source_id: string; base_source_id: string; repository_link_id: string; repository_key: string; default_branch: string;
    base_commit: string; package_name: string; dependency_section: string; from_version: string; to_version: string;
    advisory_ids: unknown; package_json_path: string; package_lock_path: string; base_digest: string; candidate_digest: string;
    lockfile_sha256: string; patch_sha256: string; validation_run_id: string; source_body: unknown; source_digest: string; source_deleted_at: Date | null;
    base_body: unknown; stored_base_digest: string; base_deleted_at: Date | null; bound_repository_link_id: string; binding_commit: string; binding_digest: string;
    link_state: string; revoked: boolean; read_access: string; validation_state: string; validation_mode: string;
    validation_base_digest: string; validation_candidate_digest: string; validation_patch_digest: string; target_finding_ids: unknown;
  }>(`SELECT c.candidate_source_id,c.base_source_id,c.repository_link_id,l.repository_key,l.default_branch,c.base_commit,c.package_name,c.dependency_section,c.from_version,c.to_version,
      c.advisory_ids,c.package_json_path,c.package_lock_path,c.base_digest,c.candidate_digest,c.lockfile_sha256,c.patch_sha256,c.validation_run_id,
      s.body AS source_body,s.digest AS source_digest,s.deleted_at AS source_deleted_at,b.body AS base_body,b.digest AS stored_base_digest,b.deleted_at AS base_deleted_at,
      binding.repository_link_id AS bound_repository_link_id,binding.commit_sha AS binding_commit,binding.source_digest AS binding_digest,l.state AS link_state,l.revoked,l.read_access,
      v.state AS validation_state,v.validation_mode,v.base_snapshot_digest AS validation_base_digest,v.candidate_tree_digest AS validation_candidate_digest,
      v.patch_digest AS validation_patch_digest,v.target_finding_ids
    FROM gotchu.dependency_fix_candidates c
    JOIN gotchu.customer_sources s ON s.organization_id=c.organization_id AND s.application_id=c.application_id AND s.id=c.candidate_source_id
    JOIN gotchu.customer_sources b ON b.organization_id=c.organization_id AND b.application_id=c.application_id AND b.id=c.base_source_id
    JOIN gotchu.customer_source_repository_bindings binding ON binding.organization_id=c.organization_id AND binding.application_id=c.application_id AND binding.source_id=c.base_source_id
    JOIN gotchu.application_repository_links l ON l.organization_id=c.organization_id AND l.application_id=c.application_id AND l.id=c.repository_link_id
    JOIN gotchu.github_installations g ON g.organization_id=l.organization_id AND g.installation_id=l.installation_id AND g.state='active'
    JOIN gotchu.validation_runs v ON v.organization_id=c.organization_id AND v.application_id=c.application_id AND v.id=c.validation_run_id
    WHERE c.organization_id=$1 AND c.application_id=$2 AND c.candidate_source_id=$3`, [scope.organizationId, scope.applicationId, candidateId]);
  const row = result.rows[0];
  if (!row || row.source_deleted_at !== null || row.base_deleted_at !== null || row.link_state !== 'verified' || row.revoked || row.read_access !== 'granted'
    || row.bound_repository_link_id !== row.repository_link_id || row.binding_commit !== row.base_commit || row.binding_digest !== row.base_digest || row.validation_state !== 'passed'
    || row.validation_mode !== 'dependency' || row.validation_base_digest !== row.base_digest || row.validation_candidate_digest !== row.candidate_digest
    || row.validation_patch_digest !== row.patch_sha256) {
    throw new BackendError('dependency_candidate_invalid', 'The stored dependency candidate is unavailable or has not passed independent validation', 409);
  }
  const snapshot = customerSourceSnapshotSchema.parse(row.source_body);
  const baseSnapshot = customerSourceSnapshotSchema.parse(row.base_body);
  if (row.base_digest !== row.stored_base_digest || row.source_digest !== row.candidate_digest
    || snapshot.revision !== row.base_commit || baseSnapshot.revision !== row.base_commit
    || sha256(canonicalJson(snapshot)) !== row.candidate_digest || sha256(canonicalJson(baseSnapshot)) !== row.base_digest
    || !/^[a-f0-9]{40}$/.test(row.base_commit)) {
    throw new BackendError('dependency_candidate_invalid', 'The stored dependency snapshot does not match its bound repository commit', 409);
  }
  const advisoryIds = z.array(z.string().regex(/^[A-Za-z0-9._-]{1,128}$/)).min(1).max(20).parse(row.advisory_ids);
  z.array(z.uuid()).min(1).max(20).parse(row.target_finding_ids);
  const attestations = await tx.query<{ id: string; kind: string; body: unknown }>(`SELECT id,kind,body FROM gotchu.validation_attestations
    WHERE organization_id=$1 AND application_id=$2 AND run_id=$3 ORDER BY created_at,id`, [scope.organizationId, scope.applicationId, row.validation_run_id]);
  const attested = new Map<string, string>();
  for (const item of attestations.rows) {
    const payload = validationAttestationPayloadSchema.safeParse(item.body);
    if (!payload.success || payload.data.id !== item.id || payload.data.organizationId !== scope.organizationId || payload.data.applicationId !== scope.applicationId
      || payload.data.runId !== row.validation_run_id || payload.data.actionRef !== candidateId || payload.data.evidence.kind !== item.kind) {
      throw new BackendError('dependency_validation_invalid', 'A stored dependency validation attestation is invalid', 409);
    }
    if (item.kind === 'independent_rescan' || item.kind === 'functional_suite') attested.set(item.kind, payload.data.id);
  }
  const rescanAttestationId = attested.get('independent_rescan');
  const suiteAttestationId = attested.get('functional_suite');
  if (!rescanAttestationId || !suiteAttestationId) throw new BackendError('dependency_validation_missing', 'Signed rescan and functional suite facts are required', 409);

  const baseFiles = new Map(baseSnapshot.files.map(file => [file.path, file.content]));
  const candidateFiles = new Map(snapshot.files.map(file => [file.path, file.content]));
  const changedPaths = [...new Set([...baseFiles.keys(), ...candidateFiles.keys()])].filter(path => baseFiles.get(path) !== candidateFiles.get(path)).sort();
  const expectedLockPath = row.package_json_path.replace(/package\.json$/, 'package-lock.json');
  if (row.dependency_section !== 'dependencies' && row.dependency_section !== 'devDependencies' && row.dependency_section !== 'optionalDependencies'
    || row.package_json_path !== 'package.json'
    || row.package_lock_path !== expectedLockPath || changedPaths.length !== 2
    || !changedPaths.includes(row.package_json_path) || !changedPaths.includes(row.package_lock_path)) {
    throw new BackendError('dependency_candidate_invalid', 'The candidate changes files outside its package manifest and lockfile', 409);
  }
  const manifestText = candidateFiles.get(row.package_json_path);
  const lockText = candidateFiles.get(row.package_lock_path);
  const oldManifestText = baseFiles.get(row.package_json_path);
  const oldLockText = baseFiles.get(row.package_lock_path);
  if (!manifestText || !lockText || oldManifestText === undefined || oldLockText === undefined || sha256(lockText) !== row.lockfile_sha256) {
    throw new BackendError('dependency_candidate_invalid', 'The candidate manifest or lockfile digest does not match its stored metadata', 409);
  }
  const manifestRaw: unknown = JSON.parse(manifestText);
  const manifest = z.record(z.string(), z.unknown()).parse(manifestRaw);
  const manifestSection = z.record(z.string(), z.unknown()).parse(manifest[row.dependency_section]);
  const lockfileRaw: unknown = JSON.parse(lockText);
  const lockfile = z.record(z.string(), z.unknown()).parse(lockfileRaw);
  const packages = z.record(z.string(), z.unknown()).parse(lockfile.packages);
  const root = z.record(z.string(), z.unknown()).parse(packages['']);
  const lockSection = z.record(z.string(), z.unknown()).parse(root[row.dependency_section]);
  const packageEntry = z.record(z.string(), z.unknown()).parse(packages[`node_modules/${row.package_name}`]);
  const toVersion = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/).parse(row.to_version);
  if (manifestSection[row.package_name] !== toVersion || lockSection[row.package_name] !== toVersion || packageEntry.version !== toVersion
    || packageEntry.name !== undefined && packageEntry.name !== row.package_name
    || typeof packageEntry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(packageEntry.integrity)) {
    throw new BackendError('dependency_candidate_invalid', 'The locked package version does not match the proposal', 409);
  }
  const patchFiles: PatchFile[] = [row.package_json_path, row.package_lock_path].map(path => {
    const content = candidateFiles.get(path);
    if (content === undefined) throw new BackendError('dependency_candidate_invalid', 'A package artifact file is missing', 409);
    return { path, content, mode: '100644' as const };
  });
  const expectedPatchSha256 = sha256(canonicalJson(patchFiles.map(file => ({ path: file.path, before: sha256(baseFiles.get(file.path) ?? ''), after: sha256(file.content) }))));
  if (expectedPatchSha256 !== row.patch_sha256) throw new BackendError('dependency_candidate_invalid', 'The exact package patch digest does not match its stored metadata', 409);
  // An independent rescan must have selected every advisory identity for this package.
  const rescanRaw: unknown = attestations.rows.find(item => item.kind === 'independent_rescan')?.body;
  const rescanPayload = validationAttestationPayloadSchema.parse(rescanRaw);
  if (rescanPayload.evidence.kind !== 'independent_rescan'
    || scoreIndependentRescan(rescanPayload.evidence, 'dependency').result !== 'passed') {
    throw new BackendError('dependency_validation_invalid', 'The signed validation does not cover every package advisory', 409);
  }
  const targetKeys = advisoryIds.map(id => `npm:${row.package_name}:${id}`);
  const rescanEvidence = rescanPayload.evidence;
  if (rescanEvidence.kind !== 'independent_rescan') throw new BackendError('dependency_validation_invalid', 'Signed rescan evidence is missing', 409);
  if (targetKeys.some(key => !rescanEvidence.targetedIdentities.includes(key)
    || !rescanEvidence.before.identities.includes(key) || rescanEvidence.after.identities.includes(key))) {
    throw new BackendError('dependency_validation_invalid', 'The signed rescan did not target every matched advisory', 409);
  }
  return {
    candidateSourceId: row.candidate_source_id, baseSourceId: row.base_source_id, repositoryLinkId: row.repository_link_id,
    repositoryKey: row.repository_key, branch: row.default_branch, baseCommit: row.base_commit, packageName: row.package_name,
    fromVersion: row.from_version, toVersion, advisoryIds, lockfileSha256: row.lockfile_sha256, patchSha256: row.patch_sha256,
    candidateDigest: row.candidate_digest, validationRunId: row.validation_run_id, rescanAttestationId, suiteAttestationId,
    patchFiles, diffSummary: `Actualizar ${row.package_name} de ${row.from_version} a ${toVersion} en package.json y package-lock.json.`,
  };
}

function createDependencyAction(scope: { organizationId: string; applicationId: string }, candidate: DependencyCandidate, treeSha: string): Extract<ActionV2, { kind: 'dependency_pull_request' }> {
  const commitMessage = dependencyCommitMessage(candidate);
  const action = parse(actionV2Schema, {
    version: 2, kind: 'dependency_pull_request', capabilityId: 'repository.dependency_pr', organizationId: scope.organizationId,
    applicationId: scope.applicationId, policyVersion: actionPolicyVersion('repository.dependency_pr') ?? 'unregistered-policy',
    target: { kind: 'repository', repositoryLinkId: candidate.repositoryLinkId, repositoryKey: candidate.repositoryKey, branch: candidate.branch },
    baseCommit: candidate.baseCommit, candidateCommit: expectedDependencyCommitSha(treeSha, candidate.baseCommit, commitMessage),
    changes: [{ name: candidate.packageName, from: candidate.fromVersion, to: candidate.toVersion }], advisoryIds: candidate.advisoryIds,
    lockfileSha256: candidate.lockfileSha256, patchSha256: candidate.patchSha256,
    rescanAttestationId: candidate.rescanAttestationId, suiteAttestationId: candidate.suiteAttestationId,
    evidence: [{ id: candidate.candidateSourceId, sha256: candidate.candidateDigest, kind: 'dependency_candidate' }],
  });
  if (action.kind !== 'dependency_pull_request') throw new BackendError('candidate_invalid', 'A dependency candidate must resolve to a dependency pull request action', 409);
  return action;
}

type PullRequestAction = Extract<ActionV2, { kind: 'source_patch_pull_request' }> | Extract<ActionV2, { kind: 'dependency_pull_request' }>;

function createSourcePatchAction(input: unknown): Extract<ActionV2, { kind: 'source_patch_pull_request' }> {
  const action = parse(actionV2Schema, input);
  if (action.kind !== 'source_patch_pull_request') throw new BackendError('candidate_invalid', 'A source correction candidate must resolve to a source patch action', 409);
  return action;
}

function actionSnapshotDigest(action: PullRequestAction): string {
  if (action.kind === 'source_patch_pull_request') return action.snapshotSha256;
  const candidate = action.evidence.find(item => item.kind === 'dependency_candidate');
  if (!candidate) throw new BackendError('dependency_candidate_invalid', 'Dependency proposal has no candidate evidence', 409);
  return candidate.sha256;
}

async function insertExecutionArtifact(tx: Transaction, scope: { organizationId: string; applicationId: string }, proposalId: string, action: PullRequestAction, patchFiles: readonly PatchFile[], unsupportedReason: string | null, treeSha: string | null) {
  const files = patchFiles.map(file => ({ path: file.path, mode: file.mode ?? '100644', contentBase64: Buffer.from(file.content, 'utf8').toString('base64'), sha256: createHash('sha256').update(file.content, 'utf8').digest('hex') }));
  const sizeBytes = patchFiles.reduce((total, file) => total + Buffer.byteLength(file.path, 'utf8') + Buffer.byteLength(file.content, 'utf8'), 0);
  if (sizeBytes > 4_194_304) throw new BackendError('candidate_too_large', 'Candidate exceeds the stored publication size limit', 413);
  const candidateTreeSha = await computeGitTreeSha(patchFiles);
  const completeTreeSha = unsupportedReason === null ? treeSha : null;
  const unsupported = completeTreeSha === null ? unsupportedReason ?? 'repository_tree_unavailable' : null;
  const snapshotSha256 = actionSnapshotDigest(action);
  const change = action.kind === 'dependency_pull_request' ? action.changes[0] : undefined;
  if (action.kind === 'dependency_pull_request' && !change) throw new BackendError('dependency_candidate_invalid', 'Dependency proposal has no package change', 409);
  const commitMessage = change ? dependencyCommitMessage({ packageName: change.name, fromVersion: change.from, toVersion: change.to }) : `Gotchu approved correction ${action.patchSha256.slice(0,16)}`;
  await tx.query(`INSERT INTO gotchu.execution_artifacts(organization_id,application_id,proposal_id,candidate_source_id,base_commit,files,candidate_tree_sha,tree_sha,tree_complete,unsupported_reason,commit_message,snapshot_sha256,patch_sha256,artifact_sha256,size_bytes)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [scope.organizationId,scope.applicationId,proposalId,action.evidence[0]?.id,action.baseCommit,JSON.stringify(files),candidateTreeSha,completeTreeSha,completeTreeSha !== null,unsupported,commitMessage,snapshotSha256,action.patchSha256,snapshotSha256,sizeBytes]);
}

async function executorAvailable(tx: Transaction, capabilityId: string): Promise<boolean> {
  const result = await tx.query<{ available: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM gotchu.action_executor_instances
    WHERE capability_id=$1 AND heartbeat_at > clock_timestamp() - interval '90 seconds'
  ) AS available`, [capabilityId]);
  return result.rows[0]?.available === true;
}

export function createActionService(deps: ActionDependencies) {
  const clock = deps.clock ?? systemClock;
  return {
    async list(identity: Identity, input: { organizationId: string; applicationId: string }) {
      const scope = parse(z.object({ organizationId: z.uuid(), applicationId: z.uuid() }).strict(), input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity, undefined, scope.applicationId);
        const epoch = await tx.query<{ recovery_epoch: string }>('SELECT recovery_epoch FROM gotchu.lock_authorization_state()');
        const recoveryEpoch = String(epoch.rows[0]?.recovery_epoch ?? '');
        await tx.query(`UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='recovery_epoch_changed',blocking_reasons='["propuesta invalidada tras una recuperación"]'::jsonb
          WHERE organization_id=$1 AND application_id=$2 AND version=2 AND recovery_epoch<>$3 AND state IN ('proposed','eligible','ineligible','approved')`, [scope.organizationId,scope.applicationId,recoveryEpoch]);
        const result = await tx.query<{ id: string; action_hash: string; body: unknown; recovery_epoch: string; state: string; blocking_reasons: unknown; invalidation_reason: string | null; created_at: Date }>(`SELECT id,action_hash,body,recovery_epoch,state,blocking_reasons,invalidation_reason,created_at FROM gotchu.proposals WHERE organization_id=$1 AND application_id=$2 AND version=2 ORDER BY created_at DESC,id LIMIT 100`, [scope.organizationId, scope.applicationId]);
        const rows = result.rows.map(row => {
          const action = parse(actionV2Schema, row.body);
          if (hashActionV2(action, String(row.recovery_epoch)) !== row.action_hash) throw new BackendError('proposal_corrupt', 'Stored action does not match its immutable hash', 409);
          return actionRowSchema.parse({ id: row.id, actionHash: row.action_hash, action, state: row.state, blockingReasons: publicReasons(row.blocking_reasons,row.invalidation_reason), createdAt: row.created_at });
        });
        const histories = await loadExecutionHistory(tx, scope.organizationId, rows.map(row => row.id));
        return rows.map(row => publicProjection(row, {}, histories.get(row.id)));
      });
    },
    async get(identity: Identity, input: { organizationId: string; applicationId: string; proposalId: string }) {
      const scope = parse(z.object({ organizationId: z.uuid(), applicationId: z.uuid(), proposalId: z.uuid() }).strict(), input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity, undefined, scope.applicationId);
        const epoch = await tx.query<{ recovery_epoch: string }>('SELECT recovery_epoch FROM gotchu.lock_authorization_state()');
        const recoveryEpoch = String(epoch.rows[0]?.recovery_epoch ?? '');
        await tx.query(`UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='recovery_epoch_changed',blocking_reasons='["propuesta invalidada tras una recuperación"]'::jsonb
          WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND version=2 AND recovery_epoch<>$4 AND state IN ('proposed','eligible','ineligible','approved')`, [scope.organizationId,scope.applicationId,scope.proposalId,recoveryEpoch]);
        const result = await tx.query<{ id: string; action_hash: string; body: unknown; recovery_epoch: string; state: string; blocking_reasons: unknown; invalidation_reason: string | null; created_at: Date }>('SELECT id,action_hash,body,recovery_epoch,state,blocking_reasons,invalidation_reason,created_at FROM gotchu.proposals WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND version=2', [scope.organizationId, scope.applicationId, scope.proposalId]);
        const row = result.rows[0];
        if (!row) throw new BackendError('not_found', 'Action proposal not found', 404);
        const action = parse(actionV2Schema, row.body);
        if (hashActionV2(action, String(row.recovery_epoch)) !== row.action_hash) throw new BackendError('proposal_corrupt', 'Stored action does not match its immutable hash', 409);
        let path: string | undefined;
        if (action.kind === 'source_patch_pull_request') {
          const metadata = await tx.query<{ detail: unknown }>(`SELECT detail FROM gotchu.audit_records WHERE organization_id=$1 AND subject_id=$2 AND action='correction.prepared' ORDER BY created_at DESC LIMIT 1`, [scope.organizationId, action.evidence[0]?.id]);
          const parsed = z.object({ path: z.string().min(1).max(512) }).passthrough().safeParse(metadata.rows[0]?.detail);
          path = parsed.success ? parsed.data.path : undefined;
        }
        const history = await loadExecutionHistory(tx, scope.organizationId, [scope.proposalId]);
        return publicProjection(actionRowSchema.parse({ id: row.id, actionHash: row.action_hash, action, state: row.state, blockingReasons: publicReasons(row.blocking_reasons,row.invalidation_reason), createdAt: row.created_at }), path === undefined ? {} : { path }, history.get(scope.proposalId));
      });
    },
    async propose(identity: Identity, input: { organizationId: string; applicationId: string; kind: string; sourceRef: unknown }) {
      const scope = parse(z.object({ organizationId: z.uuid(), applicationId: z.uuid() }).strict(), {
        organizationId: input.organizationId, applicationId: input.applicationId,
      });
      const proposal = parse(proposeSchema, { kind: input.kind, sourceRef: input.sourceRef });
      const value = { ...scope, ...proposal };
      const candidateId = proposal.sourceRef.candidateId;
      const prepared = await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator'], value.applicationId);
        return proposal.kind === 'source_patch_pull_request'
          ? { type: 'correction' as const, value: await loadCandidate(tx, value, candidateId) }
          : { type: 'dependency' as const, value: await loadDependencyCandidate(tx, value, candidateId) };
      });
      const patchFiles = prepared.value.patchFiles;
      const repositoryKey = prepared.type === 'correction' ? prepared.value.action.target.repositoryKey : prepared.value.repositoryKey;
      const baseCommit = prepared.type === 'correction' ? prepared.value.action.baseCommit : prepared.value.baseCommit;
      let treeSha: string | null = null;
      let unsupportedReason = prepared.type === 'correction' ? prepared.value.artifactUnsupportedReason : null;
      if (!unsupportedReason && patchFiles.length && deps.actionVerifier?.prepareArtifact) {
        try {
          const tree = await deps.actionVerifier.prepareArtifact({
            organizationId: value.organizationId, applicationId: value.applicationId,
            repositoryKey, baseCommit, files: patchFiles,
          });
          treeSha = tree.treeSha;
          unsupportedReason = tree.unsupportedReason;
        } catch {
          unsupportedReason = 'repository_tree_unavailable';
        }
      } else if (!unsupportedReason) {
        unsupportedReason = 'repository_tree_unavailable';
      }
      if (prepared.type === 'dependency' && (unsupportedReason || !treeSha)) {
        throw new BackendError('dependency_artifact_unavailable', 'A complete repository tree is required to bind this dependency proposal', 409);
      }
      const validationAttestationIds = prepared.type === 'correction' && deps.actionVerifier?.getValidationAttestationIds
        ? await deps.actionVerifier.getValidationAttestationIds(prepared.value.action).catch(() => []) : [];
      const proposedAction: PullRequestAction = prepared.type === 'correction'
        ? createSourcePatchAction({ ...prepared.value.action, expectedTreeSha: treeSha, validationAttestationIds })
        : createDependencyAction(value, prepared.value, treeSha ?? '');
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator'], value.applicationId);
        const app = await tx.query<{ archived: boolean }>('SELECT archived FROM gotchu.applications WHERE organization_id=$1 AND id=$2 FOR UPDATE', [value.organizationId, value.applicationId]);
        if (!app.rows[0]) throw new BackendError('not_found', 'Application not found', 404);
        if (app.rows[0].archived) throw new BackendError('application_archived', 'Restore the application before proposing an action', 409);
        const current = proposal.kind === 'source_patch_pull_request'
          ? { type: 'correction' as const, value: await loadCandidate(tx, value, candidateId) }
          : { type: 'dependency' as const, value: await loadDependencyCandidate(tx, value, candidateId) };
        const currentAction: PullRequestAction = current.type === 'correction'
          ? createSourcePatchAction({ ...current.value.action, expectedTreeSha: treeSha, validationAttestationIds })
          : createDependencyAction(value, current.value, treeSha ?? '');
        const currentPatchFiles = current.value.patchFiles;
        const preparedUnsupported = prepared.type === 'correction' ? prepared.value.artifactUnsupportedReason : null;
        const currentUnsupported = current.type === 'correction' ? current.value.artifactUnsupportedReason : null;
        if (canonicalJson(currentAction) !== canonicalJson(proposedAction)
          || canonicalJson(currentPatchFiles) !== canonicalJson(patchFiles)
          || currentUnsupported !== preparedUnsupported) {
          throw new BackendError('candidate_changed', 'The stored candidate changed while its repository tree was being read', 409);
        }
        const authorization = await tx.query<{ recovery_epoch: string }>('SELECT recovery_epoch FROM gotchu.lock_authorization_state()');
        const recoveryEpoch = String(authorization.rows[0]?.recovery_epoch ?? '');
        const actionHash = hashActionV2(currentAction, recoveryEpoch);
        const prior = await tx.query<{ id: string }>('SELECT id FROM gotchu.proposals WHERE organization_id=$1 AND action_hash=$2', [value.organizationId, actionHash]);
        if (prior.rows[0]) return { proposalId: prior.rows[0].id, actionHash };
        const open = await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM gotchu.proposals WHERE organization_id=$1 AND application_id=$2 AND state NOT IN ('expired','invalidated','succeeded','failed')`, [value.organizationId, value.applicationId]);
        if ((open.rows[0]?.count ?? 0) >= 100) throw new BackendError('proposal_capacity', 'At most 100 open action proposals are allowed per application', 429);
        const id = randomUUID();
        const state = 'ineligible';
        const writeCapability = await tx.query<{ adapter_available: boolean }>('SELECT adapter_available FROM gotchu.action_capabilities WHERE kind=$1', [currentAction.kind]);
        const workerAvailable = await executorAvailable(tx, currentAction.capabilityId);
        const reasons = [
          ...(current.type === 'correction' ? current.value.blockingReasons : []),
          ...(unsupportedReason ? [unsupportedReason] : []),
          ...(writeCapability.rows[0]?.adapter_available ? [] : ['sin adaptador de escritura']),
          ...(workerAvailable ? [] : ['executor no disponible']),
          ...(!deps.actionVerifier ? ['validation_verifier_unavailable'] : []),
        ];
        const inserted = await tx.query('INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id,state,source_ref,blocking_reasons) VALUES($1,$2,$3,$4,$5::jsonb,$6,2,$7,$8,$9,$10::jsonb,$11::jsonb) ON CONFLICT(organization_id,action_hash) DO NOTHING RETURNING id', [value.organizationId,value.applicationId,id,actionHash,JSON.stringify(currentAction),recoveryEpoch,currentAction.kind,currentAction.capabilityId,state,JSON.stringify(value.sourceRef),JSON.stringify(reasons)]);
        if (!inserted.rowCount) {
          const prior = await tx.query<{ id: string }>('SELECT id FROM gotchu.proposals WHERE organization_id=$1 AND action_hash=$2', [value.organizationId, actionHash]);
          const existing = prior.rows[0];
          if (!existing) throw new BackendError('proposal_conflict', 'Idempotent action proposal disappeared', 409);
          return { proposalId: existing.id, actionHash };
        }
        await insertExecutionArtifact(tx, value, id, currentAction, currentPatchFiles, unsupportedReason, treeSha);
        await audit(tx, value.organizationId, identity.userId, 'action.proposed', id, { actionHash, kind: currentAction.kind, capabilityId: currentAction.capabilityId });
        return { proposalId: id, actionHash };
      });
    },
    async getEligibility(identity: Identity, input: { organizationId: string; applicationId: string; proposalId: string }) {
      const value = parse(z.object({ organizationId: z.uuid(), applicationId: z.uuid(), proposalId: z.uuid() }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner'], value.applicationId);
        const result = await tx.query<{ body: unknown; action_hash: string; recovery_epoch: string; state: string; adapter_available: boolean }>(`SELECT p.body,p.action_hash,p.recovery_epoch,p.state,c.adapter_available FROM gotchu.proposals p JOIN gotchu.action_capabilities c ON c.kind=p.kind WHERE p.organization_id=$1 AND p.application_id=$2 AND p.id=$3 AND p.version=2`, [value.organizationId,value.applicationId,value.proposalId]);
        const row = result.rows[0];
        if (!row) throw new BackendError('not_found', 'Action proposal not found', 404);
        const action = parse(actionV2Schema, row.body);
        if (hashActionV2(action, String(row.recovery_epoch)) !== row.action_hash) throw new BackendError('proposal_corrupt', 'Stored action does not match its immutable hash', 409);
        const currentEpoch = await tx.query<{ recovery_epoch: string }>('SELECT recovery_epoch FROM gotchu.lock_authorization_state()');
        if (String(row.recovery_epoch) !== String(currentEpoch.rows[0]?.recovery_epoch)) {
          await tx.query(`UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='recovery_epoch_changed',blocking_reasons='["propuesta invalidada tras una recuperación"]'::jsonb WHERE organization_id=$1 AND id=$2`, [value.organizationId,value.proposalId]);
          return { status: 'ineligible' as const, blockingReasons: ['propuesta invalidada tras una recuperación'] };
        }
        const reasons: string[] = [];
        if (!deps.actionVerifier) reasons.push('validación en VM no disponible');
        if (!row.adapter_available) reasons.push('sin adaptador de escritura');
        if (!await executorAvailable(tx, action.capabilityId)) reasons.push('executor no disponible');
        if (action.kind !== 'source_patch_pull_request' && action.kind !== 'dependency_pull_request') reasons.push('sin adaptador de escritura');
        const verification = deps.actionVerifier ? await deps.actionVerifier.verify(action, { phase: 'proposal' }) : undefined;
        if (verification?.baseChanged) reasons.push('base cambió desde la propuesta');
        if (verification && !verification.eligible) reasons.push(...(verification.blockingReasons.length ? verification.blockingReasons : ['validaciones pendientes']));
        if (row.adapter_available && !deps.stepUpVerifier) reasons.push('MFA requerido');
        const eligible = reasons.length === 0;
        const invalidationReason = verification?.baseChanged ? 'base_changed' : verification?.policyCurrent === false ? 'policy_changed' : null;
        await tx.query('UPDATE gotchu.proposals SET state=$4,blocking_reasons=$5::jsonb,invalidated_at=CASE WHEN $6 THEN clock_timestamp() ELSE invalidated_at END,invalidation_reason=CASE WHEN $6 THEN $7 ELSE invalidation_reason END WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND state IN (\'proposed\',\'eligible\',\'ineligible\')', [value.organizationId,value.applicationId,value.proposalId,invalidationReason ? 'invalidated' : eligible ? 'eligible' : 'ineligible',JSON.stringify(reasons),Boolean(invalidationReason),invalidationReason]);
        return { status: eligible ? 'eligible' as const : 'ineligible' as const, blockingReasons: reasons };
      });
    },
    async approve(identity: Identity, input: { organizationId: string; applicationId: string; proposalId: string; actionHash: string; stepUpProof: string }) {
      const value = parse(z.object({ organizationId: z.uuid(), applicationId: z.uuid(), proposalId: z.uuid(), actionHash: actionHashSchema, stepUpProof: z.string().min(1).max(4096) }).strict(), input);
      if (!deps.stepUpVerifier) throw new BackendError('step_up_unavailable', 'A trusted second-factor verifier must be configured', 503);
      const result = await deps.database.tenant(value.organizationId, async tx => {
        const state = await tx.query<{ recovery_epoch: string; writes_frozen: boolean }>('SELECT * FROM gotchu.lock_authorization_state()');
        const current = state.rows[0];
        if (!current || current.writes_frozen) throw new BackendError('writes_frozen', 'Provider writes are frozen pending reconciliation', 409);
        await authorize(tx, value.organizationId, identity, ['owner'], value.applicationId);
        const stored = await tx.query<{ body: unknown; action_hash: string; recovery_epoch: string; state: string; invalidated_at: Date | null; adapter_available: boolean }>(`SELECT p.body,p.action_hash,p.recovery_epoch,p.state,p.invalidated_at,c.adapter_available FROM gotchu.proposals p JOIN gotchu.action_capabilities c ON c.kind=p.kind WHERE p.organization_id=$1 AND p.application_id=$2 AND p.id=$3 AND p.version=2 FOR UPDATE OF p`, [value.organizationId,value.applicationId,value.proposalId]);
        const row = stored.rows[0];
        if (!row || row.invalidated_at) throw new BackendError('not_found', 'Action proposal not found or invalidated', 404);
        const action = parse(actionV2Schema, row.body);
        const actionHash = hashActionV2(action, String(row.recovery_epoch));
        if (actionHash !== row.action_hash || actionHash !== value.actionHash) throw new BackendError('hash_mismatch', 'Approval must bind the exact stored action hash', 409);
        if (String(row.recovery_epoch) !== String(current.recovery_epoch)) {
          await tx.query(`UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='recovery_epoch_changed',blocking_reasons='["propuesta invalidada tras una recuperación"]'::jsonb WHERE organization_id=$1 AND id=$2`, [value.organizationId,value.proposalId]);
          return new BackendError('stale_epoch', 'A new proposal is required after recovery', 409);
        }
        if (row.state !== 'eligible') throw new BackendError('proposal_ineligible', 'Action proposal is not eligible', 409);
        if (!row.adapter_available || !deps.actionVerifier || !(await executorAvailable(tx, action.capabilityId))) throw new BackendError('proposal_ineligible', 'No eligible independent verifier, write adapter, or live executor is configured', 409);
        const check = await deps.actionVerifier.verify(action, { phase: 'approval' });
        if (check.baseChanged || check.policyCurrent === false) {
          const invalidationReason = check.baseChanged ? 'base_changed' : 'policy_changed';
          await tx.query("UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason=$3 WHERE organization_id=$1 AND id=$2", [value.organizationId,value.proposalId,invalidationReason]);
          return new BackendError(check.baseChanged ? 'stale_state' : 'stale_policy', check.baseChanged ? 'The target base changed; prepare and validate a new proposal' : 'The action policy changed; prepare and validate a new proposal', 409);
        }
        if (!check.eligible || check.blockingReasons.length) throw new BackendError('proposal_ineligible', 'Action became ineligible before approval', 409);
        const expected = { userId: identity.userId, organizationId: value.organizationId, actionHash };
        const proof = parse(verifiedStepUpSchema, await deps.stepUpVerifier!.verify({ ...expected, proof: value.stepUpProof }));
        assertStepUp(proof, expected, clock.now());
        const expiresAt = new Date(Math.min(clock.now().getTime() + APPROVAL_TTL_MS, proof.authenticatedAt.getTime() + STEP_UP_MAX_AGE_MS, proof.expiresAt.getTime()));
        const approvalId = randomUUID();
        const inserted = await tx.query('INSERT INTO gotchu.approvals(organization_id,id,proposal_id,action_hash,user_id,proof_id,recovery_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(proof_id) DO NOTHING RETURNING id', [value.organizationId,approvalId,value.proposalId,actionHash,identity.userId,proof.proofId,current.recovery_epoch,expiresAt]);
        if (!inserted.rowCount) throw new BackendError('proof_replayed', 'Second-factor proof has already been used', 409);
        await tx.query("UPDATE gotchu.proposals SET state='approved' WHERE organization_id=$1 AND id=$2", [value.organizationId,value.proposalId]);
        await audit(tx, value.organizationId, identity.userId, 'action.approved', approvalId, { proposalId: value.proposalId, actionHash });
        if (action.kind !== 'source_patch_pull_request' && action.kind !== 'dependency_pull_request') throw new BackendError('proposal_ineligible','This action kind has no executor queue adapter',409);
        await enqueue(tx, { id:randomUUID(),organizationId:value.organizationId,applicationId:value.applicationId,kind:'execution',idempotencyKey:`execution:${approvalId}`,payload:{approvalId,expectedActionHash:actionHash,expectedResourceVersion:action.baseCommit} });
        return { approvalId, expiresAt };
      });
      if (result instanceof BackendError) throw result;
      return result;
    },
    async cancel(identity: Identity, input: { organizationId: string; applicationId: string; proposalId: string; reason: 'cancelled' | 'rejected' }) {
      const value = parse(z.object({ organizationId: z.uuid(), applicationId: z.uuid(), proposalId: z.uuid(), reason: z.enum(['cancelled','rejected']) }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner','operator'], value.applicationId);
        const result = await tx.query("UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason=$4 WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND version=2 AND state IN ('proposed','eligible','ineligible') RETURNING id", [value.organizationId,value.applicationId,value.proposalId,value.reason]);
        if (!result.rowCount) throw new BackendError('proposal_not_cancellable', 'Action has started or is no longer open', 409);
        await audit(tx, value.organizationId, identity.userId, `action.${value.reason}`, value.proposalId);
      });
    },
  };
}
