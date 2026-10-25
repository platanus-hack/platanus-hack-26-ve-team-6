import { z } from 'zod';

// Provider authorization creates a dedicated local subscription session; credentials never reach the browser.
export const providerConnectionSchema = z.discriminatedUnion('status', [
  z.object({ id: z.uuid(), status: z.literal('pending'), verificationUrl: z.url().max(4096).refine(value => { const url = new URL(value); return !url.username && !url.password && ((url.origin === 'https://auth.openai.com' && url.pathname === '/codex/device' && !url.search && !url.hash) || (url.origin === 'https://claude.ai' && url.pathname === '/oauth/authorize') || (url.origin === 'https://claude.com' && url.pathname === '/cai/oauth/authorize') || (url.origin === 'https://openrouter.ai' && url.pathname === '/auth')); }), userCode: z.string().regex(/^[A-Z0-9-]{6,32}$/).optional(), acceptsCode: z.boolean().default(false), expiresAt: z.iso.datetime() }).strict(),
  z.object({ id: z.uuid(), status: z.enum(['connected', 'cancelled', 'expired', 'failed']) }).strict(),
]);

export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
