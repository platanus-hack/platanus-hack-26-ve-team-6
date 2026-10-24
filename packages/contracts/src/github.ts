import { z } from 'zod';

export const githubScopeSchema = z.object({ organizationId: z.uuid() }).strict();
export const githubConnectionSchema = z.object({
  installationId: z.string().regex(/^\d{1,20}$/), accountLogin: z.string().min(1).max(100),
  state: z.enum(['active', 'revoked']), connectedAt: z.iso.datetime(),
}).strict();
export const githubRepositorySchema = z.object({
  id: z.number().int().positive(), fullName: z.string().min(3).max(200), defaultBranch: z.string().min(1).max(200),
  private: z.boolean(), archived: z.boolean(),
}).strict();
export const githubConnectResponseSchema = z.object({ installUrl: z.string().url() }).strict();
export const githubConnectStateSchema = z.object({ state: z.string().min(32).max(128) }).strict();
export const githubBindInputSchema = githubScopeSchema.extend({ state: z.string().min(32).max(128), userId: z.string().min(1).max(256), installationId: z.string().regex(/^\d{1,20}$/), accountLogin: z.string().min(1).max(100) }).strict();
export const githubConnectionsSchema = z.array(githubConnectionSchema).max(20);
export const githubRepositoriesSchema = z.array(githubRepositorySchema).max(1000);
export const githubLinkInputSchema = githubScopeSchema.extend({ applicationId: z.uuid(), installationId: z.string().regex(/^\d{1,20}$/), repositoryId: z.number().int().positive(), fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200), defaultBranch: z.string().min(1).max(200) }).strict();

export type GitHubConnection = z.infer<typeof githubConnectionSchema>;
export type GitHubRepository = z.infer<typeof githubRepositorySchema>;
