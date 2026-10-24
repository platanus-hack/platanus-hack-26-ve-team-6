import { describe, expect, it } from 'vitest';
import { investigationModelProviderForPreset, investigationProviderCatalog } from '@gotchu/contracts';
import { createModelPort } from '../src/model-provider.js';

const livePresets = investigationProviderCatalog.filter(preset => preset.id !== 'custom_openai_compatible');
const environmentName = (id: string) => id.replace(/[^a-z0-9]+/gi, '_').toUpperCase();

describe.each(livePresets)('live model adapter: $displayName (opt-in; makes a real provider request)', preset => {
  const prefix = `GOTCHU_LLM_LIVE_${environmentName(preset.id)}`;
  const apiKey = process.env[`${prefix}_KEY`];
  const modelId = process.env[`${prefix}_MODEL`] ?? preset.defaultModelId;
  if (process.env.GOTCHU_LLM_LIVE_TEST_CONSENT !== 'true' || !apiKey || !modelId || !preset.baseUrl) {
    it.skip(`requires ${prefix}_KEY, an optional ${prefix}_MODEL, and GOTCHU_LLM_LIVE_TEST_CONSENT=true`, () => {});
  } else {
    it('returns schema-shaped JSON and usage from the selected live provider', async () => {
      const result = await createModelPort().complete({
        provider: investigationModelProviderForPreset(preset),
        providerPresetId: preset.id,
        endpoint: new URL(preset.baseUrl),
        modelId,
        apiKey,
        systemInstruction: 'Return only the JSON object {"ok":true}. Do not include markdown or commentary.',
        userContext: 'Return exactly {"ok":true}.',
        maxOutputTokens: 64,
        signal: AbortSignal.timeout(45_000),
      });
      expect(result.output).toEqual({ ok: true });
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
    }, 50_000);
  }
});
