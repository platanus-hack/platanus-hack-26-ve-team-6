import { modelOutputSchema } from '@gotchu/agent';
import { aiCorrectionPatchSchema } from '@gotchu/contracts';
import { z } from 'zod';

// Codex structured output requires every object property, including fields that
// older provider replies may omit. Runtime validation remains independent.
function requireObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(requireObjectProperties);
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'default' && key !== '$schema')
    .map(([key, item]) => [key, requireObjectProperties(item)]));
  const properties = result.properties;
  if (result.type === 'object' && properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    result.required = Object.keys(properties);
  }
  return result;
}

function responseSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  const result = requireObjectProperties(z.toJSONSchema(schema, { target: 'draft-7' }));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Model response schema must be an object');
  return result;
}

export const investigationReplyJsonSchema = responseSchema(modelOutputSchema);
export const correctionReplyJsonSchema = responseSchema(aiCorrectionPatchSchema);
export const probeReplyJsonSchema = responseSchema(z.object({ ok: z.literal(true) }).strict());
