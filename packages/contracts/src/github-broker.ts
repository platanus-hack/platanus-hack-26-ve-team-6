import { z } from 'zod';
import { customerSourceSnapshotSchema } from './customer-assessment.js';
import { githubBindInputSchema, githubOAuthStartSchema, githubRepositorySchema } from './github.js';

const providerId = z.string().regex(/^\d{1,20}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const organization = z.object({ organizationId: z.uuid() });
const application = organization.extend({ applicationId: z.uuid() });

export const singleGitHubPublicAppSchema = z.object({
  id: providerId,
  clientId: z.string().min(1).max(200),
  slug: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
}).strict();

// This private service protocol exposes bounded provider results, never credentials.
export const githubBrokerRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('authorize'), actorId: z.string().min(1).max(256),
    state: z.string().min(32).max(128), code: z.string().min(1).max(1024) }).strict(),
  organization.extend({ operation: z.literal('installationStatus'), installationId: providerId }).strict(),
  application.extend({ operation: z.literal('listRepositories'), installationId: providerId }).strict(),
  application.extend({ operation: z.literal('readRepository'), repositoryLinkId: z.uuid(),
    read: z.enum(['snapshot', 'head', 'tree', 'automation']), commitSha: sha.optional() }).strict(),
]);

const authorizationResult = z.discriminatedUnion('kind', [
  organization.extend({ kind: z.literal('choose'), installations: z.array(z.object({
    id: z.number().int().positive(), account: z.object({ id: z.number().int().positive(),
      login: z.string().min(1).max(100), type: z.enum(['User', 'Organization']) }).strict(),
  }).strict()).max(1000) }).strict(),
  organization.extend({ kind: z.literal('connected') }).strict(),
]);
const repositoryResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), snapshot: customerSourceSnapshotSchema, digest,
    repository: githubRepositorySchema, installationId: providerId, appId: providerId, treeSha: sha }).strict(),
  z.object({ kind: z.literal('head'), sha }).strict(),
  z.object({ kind: z.literal('tree'), tree: z.object({ treeSha: sha, entries: z.array(z.object({
    path: z.string().min(1).max(4096), mode: z.enum(['100644', '100755', '120000', '160000']),
    type: z.enum(['blob', 'commit']), sha,
  }).strict()).max(100_000), truncated: z.boolean() }).strict() }).strict(),
  z.object({ kind: z.literal('automation'), violations: z.array(z.object({
    path: z.string().min(1).max(4096),
    rule: z.enum(['invalid_yaml', 'invalid_document', 'pull_request_target', 'push_without_branch_filter',
      'push_to_gotchu_branch', 'forbidden_pull_request_secret']),
    reason: z.string().min(1).max(1000),
  }).strict()).max(1000) }).strict(),
]);
export const githubBrokerResponseSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('authorize'), result: authorizationResult }).strict(),
  z.object({ operation: z.literal('installationStatus'), active: z.boolean() }).strict(),
  z.object({ operation: z.literal('listRepositories'), repositories: z.array(githubRepositorySchema).max(1000) }).strict(),
  z.object({ operation: z.literal('readRepository'), result: repositoryResult }).strict(),
]);

export const githubSingleAppOAuthStartSchema = githubOAuthStartSchema.extend({ appId: providerId.optional() }).strict();
export const githubSingleAppBindInputSchema = githubBindInputSchema.extend({ appId: providerId }).strict();
export const githubCapturedSourceInputSchema = application.extend({ repositoryLinkId: z.uuid(),
  sourceSnapshotId: z.uuid(), appId: providerId, installationId: providerId,
  repositoryId: z.number().int().positive(), commitSha: sha, treeSha: sha, digest }).strict();

export type GitHubBrokerRequest = z.infer<typeof githubBrokerRequestSchema>;
export type GitHubBrokerResponse = z.infer<typeof githubBrokerResponseSchema>;
