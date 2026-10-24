import { randomUUID } from 'node:crypto';
import {
  contextInventorySchema, createDependencyRelationSchema, createDeploymentSchema, createEnvironmentSchema,
  createOriginCandidateSchema, createRepositoryLinkSchema, createServiceSchema, updateEnvironmentSchema,
  updateServiceSchema, archiveEnvironmentSchema, revokeRepositoryLinkSchema, contextScopeSchema,
  environmentSchema, serviceSchema, repositoryLinkSchema, deploymentSchema, dependencyRelationSchema,
  originCandidateSchema, type ContextInventory,
} from '@gotchu/contracts';
import { audit, authorize, BackendError, parse, type BaseDependencies, type Identity } from './core.js';

const writeRoles = ['owner', 'operator'] as const;
function throwMutationFailure(code: string) {
  if (code === 'context_environment_limit' || code === 'context_service_limit' || code === 'context_dependency_limit' || code === 'context_origin_limit') throw new BackendError(code, 'Application context limit reached', 429);
  if (code === '23505') throw new BackendError('context_conflict', 'This context item already exists', 409);
  throw new BackendError('not_found', 'Application context item not found or unavailable', 404);
}
export function createContextService(deps: BaseDependencies) {
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
        const origins = await tx.query('SELECT id,environment_id,origin,discovery_source,ownership,authorization_target_id,state,source,observed_at,created_at FROM gotchu.application_origin_candidates WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at,id LIMIT 2000', [scope.organizationId, scope.applicationId]);
        const iso = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value instanceof Date ? value.toISOString() : value]));
        return parse(contextInventorySchema, {
          environments: environments.rows.map(row => parse(environmentSchema, { applicationId: scope.applicationId, ...iso(row) })),
          services: services.rows.map(row => parse(serviceSchema, { ...iso(row) })),
          repositoryLinks: repositoryLinks.rows.map(row => parse(repositoryLinkSchema, { applicationId: scope.applicationId, ...iso(row), repositoryKey: row.repository_key, defaultBranch: row.default_branch, readAccess: row.read_access, writeAccess: row.write_access, observedAt: row.observed_at, createdAt: row.created_at })),
          deployments: deployments.rows.map(row => parse(deploymentSchema, { ...iso(row), releaseId: row.release_id, commitSha: row.commit_sha, sourceSnapshotDigest: row.source_snapshot_digest, artifactDigest: row.artifact_digest, deployedAt: row.deployed_at, observedAt: row.observed_at, createdAt: row.created_at })),
          dependencies: dependencies.rows.map(row => parse(dependencyRelationSchema, { ...iso(row), observedAt: row.observed_at, createdAt: row.created_at })),
          origins: origins.rows.map(row => parse(originCandidateSchema, { ...iso(row), discoverySource: row.discovery_source, ownership: row.ownership, authorizationTargetId: row.authorization_target_id, observedAt: row.observed_at, createdAt: row.created_at })),
        });
      });
    },
    async createEnvironment(identity: Identity, input: unknown) {
      const value = parse(createEnvironmentSchema, input); const id = randomUUID();
      await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, writeRoles);
        try { const result = await tx.query<{ allowed: boolean }>('SELECT gotchu.context_create_environment($1,$2,$3,$4,$5,$6,$7,$8) AS allowed', [value.organizationId,value.applicationId,identity.userId,id,value.name,value.kind,value.source,value.observedAt]); if (!result.rows[0]?.allowed) throwMutationFailure('not_found'); }
        catch (error) { if (error instanceof BackendError) throw error; throwMutationFailure(databaseErrorCode(error)); }
        await audit(tx,value.organizationId,identity.userId,'context.environment_created',id);
      });
      return this.list(identity,{organizationId:value.organizationId,applicationId:value.applicationId}).then(result => result.environments.find(row => row.id===id));
    },
    async updateEnvironment(identity: Identity, input: unknown) {
      const value = parse(updateEnvironmentSchema,input);
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_update_environment($1,$2,$3,$4,$5,$6) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId,value.name??null,value.kind??null]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); await audit(tx,value.organizationId,identity.userId,'context.environment_updated',value.environmentId); });
      return (await this.list(identity,value)).environments.find(row=>row.id===value.environmentId);
    },
    async archiveEnvironment(identity: Identity, input: unknown) {
      const value=parse(archiveEnvironmentSchema,input);
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_archive_environment($1,$2,$3,$4) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); await audit(tx,value.organizationId,identity.userId,'context.environment_archived',value.environmentId); });
      return (await this.list(identity,value)).environments.find(row=>row.id===value.environmentId);
    },
    async createService(identity: Identity,input: unknown) {
      const value=parse(createServiceSchema,input); const id=randomUUID();
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); try { const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_create_service($1,$2,$3,$4,$5,$6,$7,$8,$9) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId,id,value.name,value.kind,value.source,value.observedAt]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); } catch(error) { if(error instanceof BackendError) throw error; throwMutationFailure(databaseErrorCode(error)); } await audit(tx,value.organizationId,identity.userId,'context.service_created',id); });
      return (await this.list(identity,value)).services.find(row=>row.id===id);
    },
    async updateService(identity: Identity,input: unknown) {
      const value=parse(updateServiceSchema,input);
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_update_service($1,$2,$3,$4,$5,$6) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.serviceId,value.name??null,value.kind??null]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); await audit(tx,value.organizationId,identity.userId,'context.service_updated',value.serviceId); });
      return (await this.list(identity,value)).services.find(row=>row.id===value.serviceId);
    },
    async createRepositoryLink(identity: Identity,input: unknown) {
      const value=parse(createRepositoryLinkSchema,input); const id=randomUUID();
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); try { const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_create_repository($1,$2,$3,$4,$5,$6,$7,$8) AS allowed',[value.organizationId,value.applicationId,identity.userId,id,value.repositoryKey,value.subdirectory,value.defaultBranch,value.readAccess]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); } catch(error) { if(error instanceof BackendError) throw error; throwMutationFailure(databaseErrorCode(error)); } await audit(tx,value.organizationId,identity.userId,'context.repository_linked',id,{repositoryKey:value.repositoryKey}); });
      return (await this.list(identity,value)).repositoryLinks.find(row=>row.id===id);
    },
    async revokeRepositoryLink(identity: Identity,input: unknown) {
      const value=parse(revokeRepositoryLinkSchema,input);
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_revoke_repository($1,$2,$3,$4) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.repositoryLinkId]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); await audit(tx,value.organizationId,identity.userId,'context.repository_revoked',value.repositoryLinkId); });
      return (await this.list(identity,value)).repositoryLinks.find(row=>row.id===value.repositoryLinkId);
    },
    async createDeployment(identity: Identity,input: unknown) {
      const value=parse(createDeploymentSchema,input); const id=randomUUID();
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_create_deployment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId,value.serviceId,id,value.releaseId,value.commitSha,value.sourceSnapshotDigest,value.artifactDigest,value.deployedAt,value.state,value.source]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); await audit(tx,value.organizationId,identity.userId,'context.deployment_created',id); });
      return (await this.list(identity,value)).deployments.find(row=>row.id===id);
    },
    async createDependency(identity: Identity,input: unknown) {
      const value=parse(createDependencyRelationSchema,input); const id=randomUUID();
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); try { const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_create_dependency($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId,value.serviceId,id,value.kind,value.provider,value.component,value.region,value.state,value.source,value.observedAt]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); } catch(error) { if(error instanceof BackendError) throw error; throwMutationFailure(databaseErrorCode(error)); } await audit(tx,value.organizationId,identity.userId,'context.dependency_created',id); });
      return (await this.list(identity,value)).dependencies.find(row=>row.id===id);
    },
    async createOriginCandidate(identity: Identity,input: unknown) {
      const value=parse(createOriginCandidateSchema,input); const id=randomUUID();
      await deps.database.tenant(value.organizationId,async tx=>{ await authorize(tx,value.organizationId,identity,writeRoles); try { const r=await tx.query<{allowed:boolean}>('SELECT gotchu.context_create_origin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS allowed',[value.organizationId,value.applicationId,identity.userId,value.environmentId,id,value.origin,value.discoverySource,value.ownership,value.authorizationTargetId,value.state,value.source,value.observedAt]); if(!r.rows[0]?.allowed) throwMutationFailure('not_found'); } catch(error) { if(error instanceof BackendError) throw error; throwMutationFailure(databaseErrorCode(error)); } await audit(tx,value.organizationId,identity.userId,'context.origin_created',id); });
      return (await this.list(identity,value)).origins.find(row=>row.id===id);
    },
  };
}
function databaseErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && typeof error.code === 'string') return error.code;
    if ('message' in error && typeof error.message === 'string' && error.message.startsWith('context_')) return error.message;
  }
  return '';
}
