import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Transaction } from '@gotchu/database';
import {
  contextInventorySchema, createDependencyRelationSchema, createDeploymentSchema, createEnvironmentSchema,
  createOriginCandidateSchema, createRepositoryLinkSchema, createServiceSchema, updateEnvironmentSchema,
  updateServiceSchema, archiveEnvironmentSchema, revokeRepositoryLinkSchema, contextScopeSchema,
  environmentSchema, serviceSchema, repositoryLinkSchema, deploymentSchema, dependencyRelationSchema,
  originCandidateSchema, type ContextInventory,
} from '@gotchu/contracts';
import { audit, authorize, BackendError, canonicalJson, parse, sha256, systemClock, type BaseDependencies, type Identity } from './core.js';
import { assertStepUp, type StepUpVerifier } from './proposals.js';

const writeRoles = ['owner', 'operator'] as const;
const writeAccessInputSchema = contextScopeSchema.extend({ repositoryLinkId: z.uuid(), grant: z.boolean() }).strict();
const writeAccessChangeSchema = writeAccessInputSchema.extend({ actionHash: z.string().regex(/^[a-f0-9]{64}$/), stepUpProof: z.string().min(1).max(512) }).strict();
const writerVerificationSchema = z.object({ installationId: z.string().regex(/^[0-9]{1,20}$/), baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict();
type RepositoryWriteAccessVerifier = (input: { organizationId: string; applicationId: string; repositoryLinkId: string; repositoryKey: string; branch: string }) => Promise<unknown>;
type RepositoryWriteAccessRow = {
  id: string; repository_key: string; default_branch: string; state: string; revoked: boolean; read_access: string;
  write_access: 'not_granted' | 'granted' | 'revoked'; installation_id: string | null;
  read_installation_state: string | null; writer_installation_id: string | null; writer_verified_commit: string | null;
};

function writeAccessActionHash(input: {
  organizationId: string; applicationId: string; repositoryLinkId: string; repositoryKey: string; branch: string;
  from: string; grant: boolean; writerInstallationId: string | null; baseCommit: string | null;
}) {
  return sha256(`gotchu-repository-write-access-v1\n${canonicalJson(input)}`);
}

async function repositoryWriteAccessRow(tx: Transaction, organizationId: string, applicationId: string, repositoryLinkId: string, lock = false) {
  const result = await tx.query<RepositoryWriteAccessRow>(`SELECT l.id,l.repository_key,l.default_branch,l.state,l.revoked,l.read_access,l.write_access,
      l.installation_id,g.state AS read_installation_state,l.writer_installation_id,l.writer_verified_commit
    FROM gotchu.application_repository_links l LEFT JOIN gotchu.github_installations g
      ON g.organization_id=l.organization_id AND g.installation_id=l.installation_id
    WHERE l.organization_id=$1 AND l.application_id=$2 AND l.id=$3${lock ? ' FOR UPDATE OF l' : ''}`,
  [organizationId,applicationId,repositoryLinkId]);
  const row = result.rows[0];
  if (!row || row.revoked || row.state !== 'verified' || row.read_access !== 'granted'
    || !row.installation_id || row.read_installation_state !== 'active') {
    throw new BackendError('repository_link_unavailable', 'An active, verified GitHub repository link is required', 409);
  }
  return row;
}

function assertSameRepositoryWriteState(before: RepositoryWriteAccessRow, current: RepositoryWriteAccessRow) {
  if (before.id !== current.id || before.repository_key !== current.repository_key || before.default_branch !== current.default_branch
    || before.write_access !== current.write_access || before.writer_installation_id !== current.writer_installation_id
    || before.writer_verified_commit !== current.writer_verified_commit || before.installation_id !== current.installation_id
    || before.read_installation_state !== current.read_installation_state || before.state !== current.state
    || before.revoked !== current.revoked || before.read_access !== current.read_access) {
    throw new BackendError('stale_state', 'Repository write access changed while the approval was being confirmed', 409);
  }
}

function throwMutationFailure(code: string) {
  if (code === 'context_environment_limit' || code === 'context_service_limit' || code === 'context_dependency_limit' || code === 'context_origin_limit' || code === 'context_repository_limit') throw new BackendError(code, 'Application context limit reached', 429);
  if (code === 'context_self_assertion' || code === 'context_target_origin_mismatch') throw new BackendError('invalid_input', 'Customer context may only contain declared trust facts', 400);
  if (code === '23505') throw new BackendError('context_conflict', 'This context item already exists', 409);
  throw new BackendError('not_found', 'Application context item not found or unavailable', 404);
}
export function createContextService(deps: BaseDependencies & {
  stepUpVerifier?: StepUpVerifier;
  repositoryWriteAccessVerifier?: RepositoryWriteAccessVerifier;
}) {
  const clock = deps.clock ?? systemClock;
  return {
    async list(identity: Identity, input: unknown): Promise<ContextInventory> {
      const scope = parse(contextScopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity);
        const environments = await tx.query('SELECT id,application_id,name,kind,archived,state,source,observed_at,created_at FROM gotchu.application_environments WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at,id LIMIT 10', [scope.organizationId, scope.applicationId]);
        const services = await tx.query('SELECT id,environment_id,name,kind,state,source,observed_at,created_at FROM gotchu.application_services WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at,id LIMIT 500', [scope.organizationId, scope.applicationId]);
        const repositoryLinks = await tx.query('SELECT id,application_id,repository_key,subdirectory,default_branch,read_access,write_access,revoked,state,source,observed_at,created_at FROM gotchu.application_repository_links WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at,id LIMIT 100', [scope.organizationId, scope.applicationId]);
        const deployments = await tx.query('SELECT id,service_id,environment_id,release_id,commit_sha,source_snapshot_digest,artifact_digest,deployed_at,state,source,observed_at,created_at FROM gotchu.application_deployments WHERE organization_id=$1 AND application_id=$2 ORDER BY deployed_at DESC,id DESC LIMIT 5000', [scope.organizationId, scope.applicationId]);
        const dependencies = await tx.query('SELECT id,environment_id,service_id,kind,provider,component,region,state,source,observed_at,created_at FROM gotchu.application_dependencies WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at,id LIMIT 1000', [scope.organizationId, scope.applicationId]);
        const origins = await tx.query(`SELECT c.id,c.environment_id,c.origin,c.discovery_source,CASE WHEN c.authorization_target_id IS NOT NULL AND t.status='verified' AND t.expires_at>clock_timestamp() THEN 'verified' ELSE c.ownership END AS ownership,c.authorization_target_id,c.state,c.source,c.observed_at,c.created_at FROM gotchu.application_origin_candidates c LEFT JOIN gotchu.customer_targets t ON t.organization_id=c.organization_id AND t.application_id=c.application_id AND t.id=c.authorization_target_id WHERE c.organization_id=$1 AND c.application_id=$2 ORDER BY c.created_at,c.id LIMIT 2000`, [scope.organizationId, scope.applicationId]);
        const iso = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value instanceof Date ? value.toISOString() : value]));
        const inventory = {
          environments: environments.rows.map(row => parse(environmentSchema, { applicationId: scope.applicationId, ...iso(row) })),
          services: services.rows.map(row => parse(serviceSchema, { ...iso(row) })),
          repositoryLinks: repositoryLinks.rows.map(row => parse(repositoryLinkSchema, { applicationId: scope.applicationId, ...iso(row) })),
          deployments: deployments.rows.map(row => parse(deploymentSchema, { ...iso(row) })),
          dependencies: dependencies.rows.map(row => parse(dependencyRelationSchema, { ...iso(row) })),
          origins: origins.rows.map(row => parse(originCandidateSchema, { ...iso(row) })),
        };
        return parse(contextInventorySchema, inventory);
      });
    },
    async createEnvironment(identity: Identity, input: unknown) {
      const value = parse(createEnvironmentSchema, input); const id = randomUUID();
      await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, writeRoles);
        try { const result = await tx.query<{ allowed: boolean }>('SELECT gotchu.context_create_environment($1,$2,$3,$4,$5,$6,$7,$8) AS allowed', [value.organizationId,value.applicationId,identity.userId,id,value.name,value.kind,'customer_declared',value.observedAt]); if (!result.rows[0]?.allowed) throwMutationFailure('not_found'); }
        catch (error) { if (error instanceof BackendError) throw error; throwMutationFailure(databaseErrorCode(error)); }
        await audit(tx,value.organizationId,identity.userId,'context.environment_created',id);
      });
      return this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId}).then(result => result.environments.find(row => row.id===id));
    },
    async updateEnvironment(identity: Identity, input: unknown) {
      const value = parse(updateEnvironmentSchema,input);
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); try { const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_update_environment($1,$2,$3,$4,$5,$6) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId,value.name??null,value.kind??null]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); } catch(error) { if(error instanceof BackendError) throw error; throwMutationFailure(databaseErrorCode(error)); } await audit(tx,value.organizationId,identity.userId,'context.environment_updated',value.environmentId); });
      return (await this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId})).environments.find(row=>row.id===value.environmentId);
    },
    async archiveEnvironment(identity: Identity, input: unknown) {
      const value=parse(archiveEnvironmentSchema,input);
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_archive_environment($1,$2,$3,$4) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); await audit(tx,value.organizationId,identity.userId,'context.environment_archived',value.environmentId); });
      return (await this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId})).environments.find(row=>row.id===value.environmentId);
    },
    async createService(identity: Identity,input: unknown) {
      const value=parse(createServiceSchema,input); const id=randomUUID();
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); try { const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_create_service($1,$2,$3,$4,$5,$6,$7,$8,$9) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId,id,value.name,value.kind,'customer_declared',value.observedAt]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); } catch(error) { if(error instanceof BackendError) throw error; throwMutationFailure(databaseErrorCode(error)); } await audit(tx,value.organizationId,identity.userId,'context.service_created',id); });
      return (await this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId})).services.find(row=>row.id===id);
    },
    async updateService(identity: Identity,input: unknown) {
      const value=parse(updateServiceSchema,input);
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_update_service($1,$2,$3,$4,$5,$6) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.serviceId,value.name??null,value.kind??null]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); await audit(tx,value.organizationId,identity.userId,'context.service_updated',value.serviceId); });
      return (await this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId})).services.find(row=>row.id===value.serviceId);
    },
    async createRepositoryLink(identity: Identity,input: unknown) {
      const value=parse(createRepositoryLinkSchema,input); const id=randomUUID();
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); try { const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_create_repository($1,$2,$3,$4,$5,$6,$7,$8) AS allowed',[value.organizationId,value.applicationId,identity.userId,id,value.repositoryKey,value.subdirectory,value.defaultBranch,'granted']); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); } catch(error) { if(error instanceof BackendError) throw error; throwMutationFailure(databaseErrorCode(error)); } await audit(tx,value.organizationId,identity.userId,'context.repository_linked',id,{repositoryKey:value.repositoryKey}); });
      return (await this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId})).repositoryLinks.find(row=>row.id===id);
    },
    async revokeRepositoryLink(identity: Identity,input: unknown) {
      const value=parse(revokeRepositoryLinkSchema,input);
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_revoke_repository($1,$2,$3,$4) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.repositoryLinkId]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); await audit(tx,value.organizationId,identity.userId,'context.repository_revoked',value.repositoryLinkId); });
      return (await this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId})).repositoryLinks.find(row=>row.id===value.repositoryLinkId);
    },
    async getRepositoryWriteAccessChallenge(identity: Identity, input: unknown) {
      const value = parse(writeAccessInputSchema, input);
      const row = await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx,value.organizationId,identity,['owner'],value.applicationId);
        return repositoryWriteAccessRow(tx,value.organizationId,value.applicationId,value.repositoryLinkId);
      });
      if ((row.write_access === 'granted') === value.grant) throw new BackendError('stale_state','Repository write access already has the requested state',409);
      const verifier = deps.repositoryWriteAccessVerifier;
      let writer: z.infer<typeof writerVerificationSchema> | null = null;
      if (value.grant) {
        if (!verifier) throw new BackendError('repository_writer_unavailable','The independent Writer App is not configured',503);
        writer = writerVerificationSchema.parse(await verifier({
          organizationId:value.organizationId,applicationId:value.applicationId,repositoryLinkId:row.id,
          repositoryKey:row.repository_key,branch:row.default_branch,
        }));
      }
      return { actionHash: writeAccessActionHash({
        organizationId:value.organizationId,applicationId:value.applicationId,repositoryLinkId:row.id,
        repositoryKey:row.repository_key,branch:row.default_branch,from:row.write_access,grant:value.grant,
        writerInstallationId:writer?.installationId ?? row.writer_installation_id,
        baseCommit:writer?.baseCommit ?? row.writer_verified_commit,
      }) };
    },
    async setRepositoryWriteAccess(identity: Identity, input: unknown) {
      const value = parse(writeAccessChangeSchema, input);
      const before = await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx,value.organizationId,identity,['owner'],value.applicationId);
        return repositoryWriteAccessRow(tx,value.organizationId,value.applicationId,value.repositoryLinkId);
      });
      if ((before.write_access === 'granted') === value.grant) throw new BackendError('stale_state','Repository write access already has the requested state',409);
      const verifier = deps.repositoryWriteAccessVerifier;
      let writer: z.infer<typeof writerVerificationSchema> | null = null;
      if (value.grant) {
        if (!verifier) throw new BackendError('repository_writer_unavailable','The independent Writer App is not configured',503);
        writer = writerVerificationSchema.parse(await verifier({
          organizationId:value.organizationId,applicationId:value.applicationId,repositoryLinkId:before.id,
          repositoryKey:before.repository_key,branch:before.default_branch,
        }));
      }
      const actionHash = writeAccessActionHash({
        organizationId:value.organizationId,applicationId:value.applicationId,repositoryLinkId:before.id,
        repositoryKey:before.repository_key,branch:before.default_branch,from:before.write_access,grant:value.grant,
        writerInstallationId:writer?.installationId ?? before.writer_installation_id,
        baseCommit:writer?.baseCommit ?? before.writer_verified_commit,
      });
      if (actionHash !== value.actionHash) throw new BackendError('stale_state','Repository state or Writer App coverage changed; request a fresh confirmation',409);
      if (!deps.stepUpVerifier) throw new BackendError('step_up_required','Fresh WebAuthn verification is required',403);
      const proof = await deps.stepUpVerifier.verify({ proof:value.stepUpProof,userId:identity.userId,organizationId:value.organizationId,actionHash });
      assertStepUp(proof,{userId:identity.userId,organizationId:value.organizationId,actionHash},clock.now());
      if (proof.method !== 'webauthn') throw new BackendError('step_up_required','A fresh WebAuthn assertion is required',403);

      const writerVerifiedAt = writer ? clock.now() : null;
      await deps.database.tenant(value.organizationId,async tx=>{
        await authorize(tx,value.organizationId,identity,['owner'],value.applicationId);
        const current=await repositoryWriteAccessRow(tx,value.organizationId,value.applicationId,value.repositoryLinkId,true);
        assertSameRepositoryWriteState(before,current);
        await tx.query(`UPDATE gotchu.application_repository_links SET write_access=$4,writer_installation_id=$5,
          writer_verified_at=$6,writer_verified_commit=$7 WHERE organization_id=$1 AND application_id=$2 AND id=$3`,[
          value.organizationId,value.applicationId,value.repositoryLinkId,value.grant?'granted':'revoked',
          writer?.installationId ?? null,writerVerifiedAt,writer?.baseCommit ?? null,
        ]);
        if (!value.grant) {
          await tx.query('SELECT gotchu.invalidate_repository_write_actions($1,$2,$3)',[value.organizationId,value.applicationId,value.repositoryLinkId]);
        }
        await audit(tx,value.organizationId,identity.userId,value.grant?'context.repository_write_access_granted':'context.repository_write_access_revoked',
          value.repositoryLinkId,{applicationId:value.applicationId,repositoryKey:current.repository_key,branch:current.default_branch,
            actionHash,proofId:proof.proofId,method:proof.method,writerInstallationId:writer?.installationId ?? null,
            writerVerifiedAt:writerVerifiedAt?.toISOString() ?? null,writerVerifiedCommit:writer?.baseCommit ?? null});
      });
      return (await this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId})).repositoryLinks.find(row=>row.id===value.repositoryLinkId);
    },
    async createDeployment(identity: Identity,input: unknown) {
      const value=parse(createDeploymentSchema,input); const id=randomUUID();
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_create_deployment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId,value.serviceId,id,value.releaseId,value.commitSha,value.sourceSnapshotDigest,value.artifactDigest,value.deployedAt,'declared','customer_declared']); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); await audit(tx,value.organizationId,identity.userId,'context.deployment_created',id); });
      return (await this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId})).deployments.find(row=>row.id===id);
    },
    async createDependency(identity: Identity,input: unknown) {
      const value=parse(createDependencyRelationSchema,input); const id=randomUUID();
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); try { const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_create_dependency($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId,value.serviceId,id,value.kind,value.provider,value.component,value.region,'declared','customer_declared',value.observedAt]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); } catch(error) { if(error instanceof BackendError) throw error; throwMutationFailure(databaseErrorCode(error)); } await audit(tx,value.organizationId,identity.userId,'context.dependency_created',id); });
      return (await this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId})).dependencies.find(row=>row.id===id);
    },
    async createOriginCandidate(identity: Identity,input: unknown) {
      const value=parse(createOriginCandidateSchema,input); const id=randomUUID();
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); try { const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_create_origin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId,id,value.origin,value.discoverySource,value.ownership,value.authorizationTargetId,'declared','customer_declared',value.observedAt]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); } catch(error) { if(error instanceof BackendError) throw error; throwMutationFailure(databaseErrorCode(error)); } await audit(tx,value.organizationId,identity.userId,'context.origin_created',id); });
      return (await this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId})).origins.find(row=>row.id===id);
    },
  };
}
function databaseErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof error.message === 'string' && error.message.startsWith('context_')) return error.message;
    if ('code' in error && typeof error.code === 'string') return error.code;
  }
  return '';
}
