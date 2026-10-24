import { createHash, randomUUID } from 'node:crypto';
import { actionV2Schema, customerSourceSnapshotSchema, type ActionV2 } from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { computeGitTreeSha, type PatchFile, type WorkflowPolicyException } from '@gotchu/git-adapters';
import { z } from 'zod';
import { audit, authorize, BackendError, canonicalJson, parse, sha256, systemClock, type BaseDependencies, type Identity } from './core.js';
import { APPROVAL_TTL_MS, STEP_UP_MAX_AGE_MS, assertStepUp, verifiedStepUpSchema, type StepUpVerifier } from './proposals.js';
import { enqueue } from './jobs.js';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const actionHashSchema = digest;
const sourceRefSchema = z.object({ type: z.literal('correction_candidate'), candidateId: z.uuid() }).strict();
const gitCommit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const proposeSchema = z.object({ kind: z.literal('source_patch_pull_request'), sourceRef: sourceRefSchema }).strict();
const actionRowSchema = z.object({ id: z.uuid(), actionHash: digest, action: actionV2Schema, state: z.enum(['proposed','eligible','ineligible','approved','expired','invalidated','executing','succeeded','failed','uncertain','reconciliation_required']), blockingReasons: z.array(z.string()), createdAt: z.date() }).strict();

export type ActionEligibility = { eligible: boolean; blockingReasons: string[]; baseChanged?: boolean; workflowExceptions?: readonly WorkflowPolicyException[] };
export interface ActionVerifier {
  verify(action: ActionV2, context: { phase: 'proposal' | 'approval' | 'execution' }): Promise<ActionEligibility>;
  prepareArtifact?(input: { organizationId: string; applicationId: string; repositoryKey: string; baseCommit: string; files: readonly PatchFile[] }): Promise<{ treeSha: string | null; unsupportedReason: string | null }>;
}
export interface ActionDependencies extends BaseDependencies { actionVerifier?: ActionVerifier; stepUpVerifier?: StepUpVerifier }

export function hashActionV2(action: ActionV2, recoveryEpoch: string): string {
  return sha256('gotchu-action-v2\n' + canonicalJson({ action: parse(actionV2Schema, action), recoveryEpoch: parse(z.string().regex(/^[1-9][0-9]*$/), recoveryEpoch) }));
}

function publicProjection(row: z.infer<typeof actionRowSchema>, details: { path?: string; diffSummary?: string }) {
  const kindLabel = row.action.kind === 'source_patch_pull_request' ? 'Abrir una solicitud de cambio para una corrección de código' : 'Acción propuesta';
  const blockerText: Record<string, string> = {
    'validación en VM no disponible': 'La validación en VM no está disponible. Mantén la propuesta en privado hasta configurar un verificador aislado.',
    'sin adaptador de escritura': 'No hay un adaptador de escritura disponible. No se modificará ningún repositorio.',
    'MFA requerido': 'Hace falta una verificación de seguridad reciente antes de aprobar.',
    'vínculo de repositorio sin verificar': 'Verifica el vínculo del repositorio en el contexto de la aplicación.',
    'validaciones pendientes': 'Completa el reanálisis objetivo y la suite pertinente antes de solicitar aprobación.',
    'base cambió desde la propuesta': 'La rama base cambió. Prepara y valida una propuesta nueva antes de aprobar.',
  };
  return {
    id: row.id, actionHash: row.actionHash, kind: row.action.kind, state: row.state,
    effect: kindLabel, scope: `Aplicación ${row.action.applicationId}`, target: row.action.target,
    cost: { state: 'unknown' as const, amount: null },
    diff: details.path ? { path: details.path, summary: details.diffSummary ?? 'Cambio privado de una receta; el contenido del código no se comparte en esta vista.' } : null,
    validations: [{ label: 'reanálisis objetivo', state: 'pending' }, { label: 'suite configurada', state: 'pending' }],
    limits: ['No se ha escrito en Git ni en producción.', 'La severidad y el texto de una recomendación no conceden permisos.'],
    blockingReasons: row.blockingReasons.map(reason => blockerText[reason] ?? reason),
    createdAt: row.createdAt.toISOString(),
  };
}

function publicReasons(blockingReasons: unknown, invalidationReason: string | null) {
  const reasons = z.array(z.string().max(500)).max(20).safeParse(blockingReasons);
  if (reasons.success && reasons.data.length) return reasons.data;
  const known: Record<string, string> = {
    recovery_epoch_changed: 'propuesta invalidada tras una recuperación', base_changed: 'La base del repositorio cambió; prepara y valida una propuesta nueva.',
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
  const detail = z.object({ recipeId: z.string().min(1).max(100), recipeVersion: z.string().min(1).max(100), findingId: z.string().min(1).max(256), patchHash: digest, candidateSourceDigest: digest, path: z.string().min(1).max(512), originalSourceId: z.uuid().optional(), sourceDigest: digest.optional() }).passthrough().safeParse(auditResult.rows[0]?.detail);
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
        if (removed.length === 0 && changed.length === 1 && changed[0]?.path === detail.data.path) {
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
  const action = parse(actionV2Schema, {
    version: 2, kind: 'source_patch_pull_request', capabilityId: 'repository.source_patch_pr', organizationId: scope.organizationId, applicationId: scope.applicationId,
    policyVersion: 'gotchu-action-policy-v2', target: { kind: 'repository', repositoryLinkId: link.id, repositoryKey: link.repository_key, branch: link.default_branch },
    baseCommit, recipeId: detail.data.recipeId, recipeVersion: detail.data.recipeVersion, snapshotSha256: source.digest, patchSha256: detail.data.patchHash,
    findingIdentities: [detail.data.findingId], validationAttestationIds: [], evidence: [{ id: candidateId, sha256: source.digest, kind: 'private_correction_candidate' }],
  });
  const blockingReasons = [
    ...(link.state !== 'verified' ? ['vínculo de repositorio sin verificar'] : []),
    ...(link.write_access !== 'granted' ? ['permiso de escritura del repositorio no concedido'] : []),
  ];
  return { action, path: detail.data.path, snapshot, patchFiles, artifactUnsupportedReason, blockingReasons };
}

async function insertExecutionArtifact(tx: Transaction, scope: { organizationId: string; applicationId: string }, proposalId: string, action: Extract<ActionV2,{kind:'source_patch_pull_request'}>, patchFiles: readonly PatchFile[], unsupportedReason: string | null, treeSha: string | null) {
  const files = patchFiles.map(file => ({ path: file.path, mode: file.mode ?? '100644', contentBase64: Buffer.from(file.content, 'utf8').toString('base64'), sha256: createHash('sha256').update(file.content, 'utf8').digest('hex') }));
  const sizeBytes = patchFiles.reduce((total, file) => total + Buffer.byteLength(file.path, 'utf8') + Buffer.byteLength(file.content, 'utf8'), 0);
  if (sizeBytes > 4_194_304) throw new BackendError('candidate_too_large', 'Candidate exceeds the stored publication size limit', 413);
  const candidateTreeSha = await computeGitTreeSha(patchFiles);
  const completeTreeSha = unsupportedReason === null ? treeSha : null;
  const unsupported = completeTreeSha === null ? unsupportedReason ?? 'repository_tree_unavailable' : null;
  await tx.query(`INSERT INTO gotchu.execution_artifacts(organization_id,application_id,proposal_id,candidate_source_id,base_commit,files,candidate_tree_sha,tree_sha,tree_complete,unsupported_reason,commit_message,snapshot_sha256,patch_sha256,artifact_sha256,size_bytes)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [scope.organizationId,scope.applicationId,proposalId,action.evidence[0]?.id,action.baseCommit,JSON.stringify(files),candidateTreeSha,completeTreeSha,completeTreeSha !== null,unsupported,`Gotchu approved correction ${action.patchSha256.slice(0,16)}`,action.snapshotSha256,action.patchSha256,action.snapshotSha256,sizeBytes]);
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
        return rows.map(row => publicProjection(row, {}));
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
        return publicProjection(actionRowSchema.parse({ id: row.id, actionHash: row.action_hash, action, state: row.state, blockingReasons: publicReasons(row.blocking_reasons,row.invalidation_reason), createdAt: row.created_at }), path === undefined ? {} : { path });
      });
    },
    async propose(identity: Identity, input: { organizationId: string; applicationId: string; kind: string; sourceRef: unknown }) {
      const value = parse(z.object({ organizationId: z.uuid(), applicationId: z.uuid(), ...proposeSchema.shape }).strict(), input);
      const prepared = await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator'], value.applicationId);
        return await loadCandidate(tx, value, value.sourceRef.candidateId);
      });
      const preparedAction = prepared.action;
      if (preparedAction.kind !== 'source_patch_pull_request') throw new BackendError('candidate_invalid', 'A source correction candidate must resolve to a source patch action', 409);
      let treeSha: string | null = null;
      let unsupportedReason = prepared.artifactUnsupportedReason;
      if (!unsupportedReason && prepared.patchFiles.length && deps.actionVerifier?.prepareArtifact) {
        try {
          const tree = await deps.actionVerifier.prepareArtifact({
            organizationId: preparedAction.organizationId, applicationId: preparedAction.applicationId,
            repositoryKey: preparedAction.target.repositoryKey, baseCommit: preparedAction.baseCommit, files: prepared.patchFiles,
          });
          treeSha = tree.treeSha;
          unsupportedReason = tree.unsupportedReason;
        } catch {
          unsupportedReason = 'repository_tree_unavailable';
        }
      } else if (!unsupportedReason) {
        unsupportedReason = 'repository_tree_unavailable';
      }
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator'], value.applicationId);
        const app = await tx.query<{ archived: boolean }>('SELECT archived FROM gotchu.applications WHERE organization_id=$1 AND id=$2 FOR UPDATE', [value.organizationId, value.applicationId]);
        if (!app.rows[0]) throw new BackendError('not_found', 'Application not found', 404);
        if (app.rows[0].archived) throw new BackendError('application_archived', 'Restore the application before proposing an action', 409);
        const current = await loadCandidate(tx, value, value.sourceRef.candidateId);
        if (current.action.kind !== 'source_patch_pull_request') throw new BackendError('candidate_invalid', 'A source correction candidate must resolve to a source patch action', 409);
        if (canonicalJson(current.action) !== canonicalJson(preparedAction)
          || canonicalJson(current.patchFiles) !== canonicalJson(prepared.patchFiles)
          || current.artifactUnsupportedReason !== prepared.artifactUnsupportedReason
          || current.action.snapshotSha256 !== preparedAction.snapshotSha256) {
          throw new BackendError('candidate_changed', 'The stored correction candidate changed while its repository tree was being read', 409);
        }
        const authorization = await tx.query<{ recovery_epoch: string }>('SELECT recovery_epoch FROM gotchu.lock_authorization_state()');
        const recoveryEpoch = String(authorization.rows[0]?.recovery_epoch ?? '');
        const actionHash = hashActionV2(current.action, recoveryEpoch);
        const prior = await tx.query<{ id: string }>('SELECT id FROM gotchu.proposals WHERE organization_id=$1 AND action_hash=$2', [value.organizationId, actionHash]);
        if (prior.rows[0]) return { proposalId: prior.rows[0].id, actionHash };
        const open = await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM gotchu.proposals WHERE organization_id=$1 AND application_id=$2 AND state NOT IN ('expired','invalidated','succeeded','failed')`, [value.organizationId, value.applicationId]);
        if ((open.rows[0]?.count ?? 0) >= 100) throw new BackendError('proposal_capacity', 'At most 100 open action proposals are allowed per application', 429);
        const id = randomUUID();
        const state = 'ineligible';
        const writeCapability = await tx.query<{ adapter_available: boolean }>('SELECT adapter_available FROM gotchu.action_capabilities WHERE kind=$1', [current.action.kind]);
        const reasons = [
          ...current.blockingReasons,
          ...(unsupportedReason ? [unsupportedReason] : []),
          ...(writeCapability.rows[0]?.adapter_available ? [] : ['sin adaptador de escritura']),
          ...(!deps.actionVerifier ? ['validation_verifier_unavailable'] : []),
        ];
        const inserted = await tx.query('INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id,state,source_ref,blocking_reasons) VALUES($1,$2,$3,$4,$5::jsonb,$6,2,$7,$8,$9,$10::jsonb,$11::jsonb) ON CONFLICT(organization_id,action_hash) DO NOTHING RETURNING id', [value.organizationId,value.applicationId,id,actionHash,JSON.stringify(current.action),recoveryEpoch,current.action.kind,current.action.capabilityId,state,JSON.stringify(value.sourceRef),JSON.stringify(reasons)]);
        if (!inserted.rowCount) {
          const prior = await tx.query<{ id: string }>('SELECT id FROM gotchu.proposals WHERE organization_id=$1 AND action_hash=$2', [value.organizationId, actionHash]);
          const existing = prior.rows[0];
          if (!existing) throw new BackendError('proposal_conflict', 'Idempotent action proposal disappeared', 409);
          return { proposalId: existing.id, actionHash };
        }
        await insertExecutionArtifact(tx, value, id, current.action, current.patchFiles, unsupportedReason, treeSha);
        await audit(tx, value.organizationId, identity.userId, 'action.proposed', id, { actionHash, kind: current.action.kind, capabilityId: current.action.capabilityId });
        return { proposalId: id, actionHash };
      });
    },
    async getEligibility(identity: Identity, input: { organizationId: string; applicationId: string; proposalId: string }) {
      const value = parse(z.object({ organizationId: z.uuid(), applicationId: z.uuid(), proposalId: z.uuid() }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, undefined, value.applicationId);
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
        if (action.kind === 'provider_response') reasons.push('sin adaptador de escritura');
        const verification = deps.actionVerifier ? await deps.actionVerifier.verify(action, { phase: 'proposal' }) : undefined;
        if (verification?.baseChanged) reasons.push('base cambió desde la propuesta');
        if (verification && !verification.eligible) reasons.push(...(verification.blockingReasons.length ? verification.blockingReasons : ['validaciones pendientes']));
        if (row.adapter_available && !deps.stepUpVerifier) reasons.push('MFA requerido');
        const eligible = reasons.length === 0;
        await tx.query('UPDATE gotchu.proposals SET state=$4,blocking_reasons=$5::jsonb,invalidated_at=CASE WHEN $6 THEN clock_timestamp() ELSE invalidated_at END,invalidation_reason=CASE WHEN $6 THEN \'base_changed\' ELSE invalidation_reason END WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND state IN (\'proposed\',\'eligible\',\'ineligible\')', [value.organizationId,value.applicationId,value.proposalId,verification?.baseChanged ? 'invalidated' : eligible ? 'eligible' : 'ineligible',JSON.stringify(reasons),verification?.baseChanged ?? false]);
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
        if (action.kind === 'source_patch_pull_request') throw new BackendError('proposal_ineligible','The exact approved base commit is missing from this action',409);
        if (String(row.recovery_epoch) !== String(current.recovery_epoch)) {
          await tx.query(`UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='recovery_epoch_changed',blocking_reasons='["propuesta invalidada tras una recuperación"]'::jsonb WHERE organization_id=$1 AND id=$2`, [value.organizationId,value.proposalId]);
          return new BackendError('stale_epoch', 'A new proposal is required after recovery', 409);
        }
        if (row.state !== 'eligible') throw new BackendError('proposal_ineligible', 'Action proposal is not eligible', 409);
        if (!row.adapter_available || !deps.actionVerifier) throw new BackendError('proposal_ineligible', 'No eligible independent verifier and write adapter are configured', 409);
        const check = await deps.actionVerifier.verify(action, { phase: 'approval' });
        if (check.baseChanged) {
          await tx.query("UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='base_changed' WHERE organization_id=$1 AND id=$2", [value.organizationId,value.proposalId]);
          return new BackendError('stale_state', 'The target base changed; prepare and validate a new proposal', 409);
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
        if (action.kind !== 'dependency_pull_request') throw new BackendError('proposal_ineligible','This action kind has no executor queue adapter',409);
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
