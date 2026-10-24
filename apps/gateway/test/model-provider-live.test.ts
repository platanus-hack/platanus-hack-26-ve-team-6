import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { investigationModelEndpointSchema, modelProviderSchema } from '@gotchu/contracts';
import { createModelPort } from '../src/model-provider.js';

// Opt-in live evidence. Requires an explicitly consented endpoint; it never downloads a model.
const liveConfig = process.env.GOTCHU_LIVE_MODEL_CONSENT === 'true'
  ? z.object({
    provider: modelProviderSchema,
    endpoint: investigationModelEndpointSchema,
    modelId: z.string().min(1).max(200),
    apiKey: z.string().min(1).optional(),
  }).strict().parse({
    provider: process.env.GOTCHU_LIVE_MODEL_PROVIDER,
    endpoint: process.env.GOTCHU_LIVE_MODEL_ENDPOINT,
    modelId: process.env.GOTCHU_LIVE_MODEL_ID,
    ...(process.env.GOTCHU_LIVE_MODEL_API_KEY ? { apiKey: process.env.GOTCHU_LIVE_MODEL_API_KEY } : {}),
  })
  : null;
const live = liveConfig ? describe : describe.skip;

live('LIVE configured model adapter (real endpoint, opt-in)', () => {
  it('returns structured JSON and provider-reported token usage', async () => {
    if (!liveConfig) throw new Error('Explicit live-model consent is required');
    const port = createModelPort();
    const result = await port.complete({
      provider: liveConfig.provider,
      endpoint: new URL(liveConfig.endpoint),
      modelId: liveConfig.modelId,
      ...(liveConfig.apiKey ? { apiKey: liveConfig.apiKey } : {}),
      systemInstruction: 'Return one JSON object only. Do not add markdown or explanation.',
      userContext: 'Return exactly {"ok":true}.',
      maxOutputTokens: 64,
      signal: AbortSignal.timeout(120_000),
    });
    expect(result.output).toEqual({ ok: true });
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  }, 125_000);
});
