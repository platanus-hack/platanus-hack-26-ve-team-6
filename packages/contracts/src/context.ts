import { z } from 'zod';

const id = z.uuid();
const timestamp = z.iso.datetime();
export const contextStateSchema = z.enum(['declared', 'verified', 'unknown']);
export const contextSourceSchema = z.enum(['customer_declared', 'signed_telemetry', 'operator', 'github_app']);
const provenance = { source: contextSourceSchema, observedAt: timestamp.nullable(), createdAt: timestamp };

export const environmentSchema = z.object({
  id, applicationId: id, name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  kind: z.enum(['production', 'staging', 'development', 'test', 'other']), archived: z.boolean(),
  state: contextStateSchema, ...provenance,
}).strict();
export const serviceSchema = z.object({
  id, environmentId: id, name: z.string().min(1).max(120), kind: z.enum(['web', 'api', 'worker', 'database', 'queue', 'other']),
  state: contextStateSchema, ...provenance,
}).strict();
const repositoryKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
export const repositorySubdirectorySchema = z.string().max(256).nullable().refine(value => value === null || (
  value.length > 0 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
), 'Subdirectory must be relative and cannot contain traversal segments');
export const repositoryLinkSchema = z.object({
  id, applicationId: id, repositoryKey, subdirectory: repositorySubdirectorySchema,
  defaultBranch: z.string().min(1).max(128), readAccess: z.enum(['not_granted', 'granted', 'revoked']),
  writeAccess: z.enum(['not_granted', 'granted', 'revoked']).default('not_granted'), revoked: z.boolean(),
  state: contextStateSchema, ...provenance,
}).strict();
const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const artifactDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/i);
export const deploymentSchema = z.object({
  id, serviceId: id, environmentId: id, releaseId: z.string().min(1).max(200),
  commitSha: commitShaSchema.nullable(), sourceSnapshotDigest: z.string().regex(/^[0-9a-f]{64}$/i).nullable(),
  artifactDigest: artifactDigestSchema.nullable(), deployedAt: timestamp, state: contextStateSchema,
  source: contextSourceSchema, observedAt: timestamp, createdAt: timestamp,
}).strict();
export type AnalyzedSubject = { commitSha?: string | null; digest?: string | null };
export function compareAnalyzedToDeployed(report: AnalyzedSubject, deployment: Pick<z.infer<typeof deploymentSchema>, 'commitSha' | 'sourceSnapshotDigest' | 'state'>): 'matches' | 'differs' | 'unknown' {
  if (deployment.state !== 'verified') return 'unknown';
  if (report.commitSha && deployment.commitSha) return report.commitSha.toLowerCase() === deployment.commitSha.toLowerCase() ? 'matches' : 'differs';
  if (report.digest && deployment.sourceSnapshotDigest) return report.digest.toLowerCase() === deployment.sourceSnapshotDigest.toLowerCase() ? 'matches' : 'differs';
  return 'unknown';
}
export const dependencyRelationSchema = z.object({
  id, environmentId: id, serviceId: id, kind: z.enum(['provider_component', 'external_api', 'database', 'package']),
  provider: z.enum(['cloudflare', 'railway', 'postgres', 'other']), component: z.string().min(1).max(200),
  region: z.string().max(100).nullable(), state: contextStateSchema, ...provenance,
}).strict();
export const originSchema = z.string().max(300).superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) {
      context.addIssue({ code: 'custom', message: 'Origin must be an HTTPS origin without credentials, path, query, fragment, or custom port' });
    }
  } catch { context.addIssue({ code: 'custom', message: 'Origin must be a valid HTTPS origin' }); }
}).transform(value => new URL(value).origin).pipe(z.string().url());
export const originCandidateSchema = z.object({
  id, environmentId: id, origin: originSchema,
  discoverySource: z.enum(['customer_inventory', 'dns', 'public_reference']),
  ownership: z.enum(['unknown', 'claimed', 'verified']), authorizationTargetId: id.nullable(),
  state: contextStateSchema, ...provenance,
}).strict();

export const contextScopeSchema = z.object({ organizationId: id, applicationId: id }).strict();
export const createEnvironmentSchema = contextScopeSchema.extend({ name: environmentSchema.shape.name, kind: environmentSchema.shape.kind, observedAt: timestamp.nullable().default(null) }).strict();
export const updateEnvironmentSchema = contextScopeSchema.extend({ environmentId: id, name: environmentSchema.shape.name.optional(), kind: environmentSchema.shape.kind.optional() }).strict().refine(v => v.name !== undefined || v.kind !== undefined);
export const archiveEnvironmentSchema = contextScopeSchema.extend({ environmentId: id, archived: z.literal(true) }).strict();
export const createServiceSchema = contextScopeSchema.extend({ environmentId: id, name: serviceSchema.shape.name, kind: serviceSchema.shape.kind, observedAt: timestamp.nullable().default(null) }).strict();
export const updateServiceSchema = contextScopeSchema.extend({ serviceId: id, name: serviceSchema.shape.name.optional(), kind: serviceSchema.shape.kind.optional() }).strict().refine(v => v.name !== undefined || v.kind !== undefined);
export const createRepositoryLinkSchema = contextScopeSchema.extend({ repositoryKey, subdirectory: repositorySubdirectorySchema.default(null), defaultBranch: z.string().min(1).max(128) }).strict();
export const revokeRepositoryLinkSchema = contextScopeSchema.extend({ repositoryLinkId: id }).strict();
export const createDeploymentSchema = contextScopeSchema.extend({ serviceId: id, environmentId: id, releaseId: deploymentSchema.shape.releaseId, commitSha: commitShaSchema.nullable().default(null), sourceSnapshotDigest: deploymentSchema.shape.sourceSnapshotDigest.default(null), artifactDigest: artifactDigestSchema.nullable().default(null), deployedAt: timestamp }).strict();
export const createDependencyRelationSchema = contextScopeSchema.extend({ environmentId: id, serviceId: id, kind: dependencyRelationSchema.shape.kind, provider: dependencyRelationSchema.shape.provider, component: dependencyRelationSchema.shape.component, region: dependencyRelationSchema.shape.region, observedAt: timestamp.nullable().default(null) }).strict();
export const createOriginCandidateSchema = contextScopeSchema.extend({ environmentId: id, origin: originSchema, discoverySource: originCandidateSchema.shape.discoverySource, ownership: z.enum(['unknown', 'claimed']).default('unknown'), authorizationTargetId: id.nullable().default(null), observedAt: timestamp.nullable().default(null) }).strict();
export const contextInventorySchema = z.object({ environments: z.array(environmentSchema).max(10), services: z.array(serviceSchema).max(500), repositoryLinks: z.array(repositoryLinkSchema).max(100), deployments: z.array(deploymentSchema).max(5000), dependencies: z.array(dependencyRelationSchema).max(1000), origins: z.array(originCandidateSchema).max(2000) }).strict();
export type Environment = z.infer<typeof environmentSchema>;
export type Service = z.infer<typeof serviceSchema>;
export type RepositoryLink = z.infer<typeof repositoryLinkSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type DependencyRelation = z.infer<typeof dependencyRelationSchema>;
export type OriginCandidate = z.infer<typeof originCandidateSchema>;
export type ContextInventory = z.infer<typeof contextInventorySchema>;
