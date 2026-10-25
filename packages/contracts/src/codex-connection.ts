import { z } from 'zod';

// Device codes authorize a dedicated local Codex session; credentials never reach the browser.
export const codexConnectionSchema = z.discriminatedUnion('status', [
  z.object({ id: z.uuid(), status: z.literal('pending'), verificationUrl: z.literal('https://auth.openai.com/codex/device'), userCode: z.string().regex(/^[A-Z0-9-]{6,32}$/), expiresAt: z.iso.datetime() }).strict(),
  z.object({ id: z.uuid(), status: z.enum(['connected', 'cancelled', 'expired', 'failed']) }).strict(),
]);

export type CodexConnection = z.infer<typeof codexConnectionSchema>;
