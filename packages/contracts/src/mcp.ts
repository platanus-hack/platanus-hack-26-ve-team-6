import { z } from 'zod';

const uuid = z.uuid().transform(value => value.toLowerCase());
const timestamp = z.iso.datetime();

/** Personal, workspace-scoped bearer credential for the Gotchu MCP server. It is read-only: it never queues work, approves or changes anything. */
export const mcpAccessTokenSchema = z.object({
  id: uuid,
  label: z.string().min(1).max(120),
  userId: z.string().min(1).max(256),
  state: z.enum(['active', 'expired', 'revoked']),
  createdAt: timestamp,
  expiresAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
}).strict();
export const mcpAccessTokenListSchema = z.array(mcpAccessTokenSchema).max(1000);
export const createMcpAccessTokenSchema = z.object({
  label: z.string().trim().min(1).max(120),
  expiresInDays: z.number().int().min(1).max(90).default(30),
}).strict();
/** `gmcp.<organizationId>.<tokenId>.<secret>`: the workspace and row are routing hints; only the secret authenticates. */
export const mcpBearerTokenSchema = z.string().regex(/^gmcp\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
export const createMcpAccessTokenResponseSchema = z.object({ token: mcpAccessTokenSchema, secret: mcpBearerTokenSchema }).strict();

// Tool inputs. The workspace always comes from the token, so no tool accepts an organization.
const application = { applicationId: z.uuid().describe('Application id from list_applications') };
export const mcpToolInputSchemas = {
  list_applications: z.object({}).strict(),
  get_monitoring_status: z.object(application).strict(),
  list_alerts: z.object({
    ...application,
    state: z.enum(['open', 'acknowledged', 'resolved']).optional().describe('Only alerts in this state'),
    limit: z.number().int().min(1).max(50).default(20),
  }).strict(),
  list_reports: z.object({ ...application, limit: z.number().int().min(1).max(50).default(10) }).strict(),
  get_report: z.object({ ...application, reportId: z.uuid() }).strict(),
  get_finding: z.object({ ...application, reportId: z.uuid(), findingId: z.uuid() }).strict(),
  get_finding_prompt: z.object({ ...application, reportId: z.uuid(), findingId: z.uuid() }).strict(),
} as const;
export type McpToolName = keyof typeof mcpToolInputSchemas;
export type McpAccessToken = z.infer<typeof mcpAccessTokenSchema>;
export type CreateMcpAccessToken = z.infer<typeof createMcpAccessTokenSchema>;
