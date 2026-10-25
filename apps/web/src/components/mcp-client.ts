import { z } from 'zod';
import { createMcpAccessTokenResponseSchema, createMcpAccessTokenSchema, mcpAccessTokenListSchema, mcpAccessTokenSchema } from '@gotchu/contracts';
import { customerRequest } from './customer-client';

const tokensPath = (organizationId: string) => `/api/customer/workspaces/${encodeURIComponent(organizationId)}/mcp-tokens`;

export const mcpTokensApi = {
  list(organizationId: string) { return customerRequest(tokensPath(organizationId), mcpAccessTokenListSchema); },
  create(organizationId: string, input: z.input<typeof createMcpAccessTokenSchema>) {
    const value = createMcpAccessTokenSchema.parse(input);
    return customerRequest(tokensPath(organizationId), createMcpAccessTokenResponseSchema, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }, 201);
  },
  revoke(organizationId: string, tokenId: string) {
    return customerRequest(`${tokensPath(organizationId)}/${encodeURIComponent(z.uuid().parse(tokenId))}`, mcpAccessTokenSchema, { method: 'DELETE' });
  },
};
