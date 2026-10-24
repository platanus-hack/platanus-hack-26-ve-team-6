import { actionV2Schema, customerSourceSnapshotSchema } from '@gotchu/contracts';
import type { Database } from '@gotchu/database';
import { z } from 'zod';
import { canonicalJson, sha256 } from './core.js';
import type { ActionEligibility, ActionVerifier } from './actions.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const runnerIsolationEvidenceSchema = z.object({
  sandbox: z.object({ kind: z.literal('bwrap+systemd-scope'), memoryMaxMiB: z.number().int().positive(), tasksMax: z.number().int().positive(), cpuQuotaPercent: z.number().int().positive() }).strict(),
  runnerVersion: z.string().min(1), firecrackerVersion: z.string().min(1), kernelDigest: digest, rootfsDigest: digest,
  profile: z.literal('node24-npm-test'), networkPolicy: z.object({ mode: z.literal('deny') }).strict(),
  lockfileSha256: digest, tarballSetSha256: digest, cleanupVerified: z.literal(true),
}).strict();

/** Local boundary schema: D05 owns the signed attestation contract and persistence. */
export const validationFactsSchema = z.object({
  baseDigest: commit,
  candidateDigest: commit,
  patchDigest: digest,
  rescanOutcome: z.enum(['passed','failed','not_run']),
  suiteOutcome: z.enum(['passed','failed','not_run']),
  regressionOutcome: z.enum(['passed','failed','not_run']),
  runnerIsolationEvidence: runnerIsolationEvidenceSchema,
  signatureVerified: z.boolean(),
  expiresAt: z.union([z.date(),z.iso.datetime().transform(value=>new Date(value))]),
}).strict();
export type ValidationFacts = z.infer<typeof validationFactsSchema>;
export interface ValidationFactsPort { getFacts(actionRef: string): Promise<ValidationFacts | null> }

export interface ActionVerifierRepositoryPort {
  readHead(input: { organizationId: string; applicationId: string; repositoryKey: string; branch: string }): Promise<string>;
  isPolicyCurrent(input: { organizationId: string; applicationId: string; capabilityId: string; policyVersion: string }): Promise<boolean>;
  isAutomationSafe(input: { organizationId: string; applicationId: string; repositoryKey: string; baseCommit: string }): Promise<boolean>;
}

/** Independent source/repository checks; no facts supplied by the browser or model are trusted. */
export function createActionVerifier(input: { database: Database; repository: ActionVerifierRepositoryPort; validationFacts: ValidationFactsPort }): ActionVerifier {
  return {
    async verify(rawAction): Promise<ActionEligibility> {
      const action = actionV2Schema.parse(rawAction);
      if (action.kind !== 'source_patch_pull_request' && action.kind !== 'dependency_pull_request') {
        return { eligible: false, blockingReasons: ['sin adaptador de escritura'] };
      }
      const link = await input.database.tenant(action.organizationId, async tx => {
        const result = await tx.query<{ repository_key: string; default_branch: string; state: string; revoked: boolean; write_access: string }>(
          `SELECT repository_key,default_branch,state,revoked,write_access FROM gotchu.application_repository_links
           WHERE organization_id=$1 AND application_id=$2 AND id=$3`,
          [action.organizationId, action.applicationId, action.target.repositoryLinkId],
        );
        return result.rows[0];
      });
      const linkValid = link !== undefined && !link.revoked && link.state === 'verified'
        && link.write_access === 'granted' && link.repository_key === action.target.repositoryKey
        && link.default_branch === action.target.branch;
      const capability = await input.database.tenant(action.organizationId, async tx => {
        const result = await tx.query<{ capability_id: string; adapter_available: boolean }>(
          'SELECT capability_id,adapter_available FROM gotchu.action_capabilities WHERE kind=$1', [action.kind],
        );
        return result.rows[0];
      });
      const capabilityValid = capability?.capability_id === action.capabilityId && capability.adapter_available;
      const candidate = action.kind === 'source_patch_pull_request'
        ? z.object({ id:z.uuid(),sha256:digest,kind:z.literal('private_correction_candidate') }).strict().safeParse(action.evidence.find(item => item.kind === 'private_correction_candidate'))
        : null;
      if (candidate && !candidate.success) return { eligible:false,blockingReasons:['artefacto candidato inválido'] };

      let artifactValid = false;
      if (candidate?.success) {
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
      }

      const expectedBase = action.kind === 'dependency_pull_request' ? action.baseCommit : undefined;
      let currentHead: string;
      try {
        currentHead = await input.repository.readHead({ organizationId:action.organizationId,applicationId:action.applicationId,repositoryKey:action.target.repositoryKey,branch:action.target.branch });
      } catch {
        return { eligible:false,blockingReasons:['base del repositorio desconocida','validación en VM no disponible'] };
      }
      if (expectedBase && currentHead !== expectedBase) return { eligible:false,baseChanged:true,blockingReasons:['base cambió desde la propuesta'] };

      const actionRef = candidate?.success ? candidate.data.id : action.evidence[0]?.id;
      const untrustedFacts = actionRef ? await input.validationFacts.getFacts(actionRef) : null;
      const factsResult = untrustedFacts === null ? null : validationFactsSchema.safeParse(untrustedFacts);
      const facts = factsResult?.success ? factsResult.data : null;
      const reasons: string[] = [];
      if (!linkValid) reasons.push('vínculo de repositorio no autorizado o cambiado');
      if (!capabilityValid) reasons.push('adaptador no habilitado para la capacidad');
      const currentPolicy = await input.repository.isPolicyCurrent({ organizationId:action.organizationId,applicationId:action.applicationId,capabilityId:action.capabilityId,policyVersion:action.policyVersion }).catch(() => false);
      if (!currentPolicy) reasons.push('política vigente no verificada');
      if (!artifactValid) reasons.push('artefacto candidato no disponible o digest incorrecto');
      if (!expectedBase) reasons.push('base aprobada no registrada en la acción');
      if (!facts) reasons.push('validación en VM no disponible');
      else {
        if (facts.expiresAt.getTime() <= Date.now()) reasons.push('attestation de validación expirada');
        if (!facts.signatureVerified) reasons.push('firma de validación no verificada');
        if (facts.patchDigest !== action.patchSha256) reasons.push('digest de patch no coincide');
        const expectedCandidate = action.kind === 'dependency_pull_request' ? action.candidateCommit : undefined;
        if (!expectedCandidate) reasons.push('commit candidato no registrado en la acción');
        if (!expectedCandidate || facts.candidateDigest !== expectedCandidate) reasons.push('digest de candidato no coincide');
        if (facts.baseDigest !== currentHead) reasons.push('base cambió desde la validación');
        if (facts.rescanOutcome !== 'passed' || facts.suiteOutcome !== 'passed' || facts.regressionOutcome !== 'passed') reasons.push('validaciones independientes incompletas');
      }
      const automationSafe = expectedBase ? await input.repository.isAutomationSafe({ organizationId:action.organizationId,applicationId:action.applicationId,repositoryKey:action.target.repositoryKey,baseCommit:expectedBase }).catch(() => false) : false;
      if (!automationSafe) reasons.push('automatización del repositorio no verificada');
      return { eligible:reasons.length===0,blockingReasons:reasons };
    },
  };
}
