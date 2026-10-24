import { z } from 'zod';
import { investigationDataScopeSchema, modelProviderSchema } from '@gotchu/contracts';
import { canonicalJson, sha256 } from './core.js';

const modelConfigurationSnapshotSchema = z.object({
  provider: modelProviderSchema,
  endpoint: z.string().url().max(2_048),
  modelId: z.string().min(1).max(200),
  secretRef: z.string().nullable(),
  consentToExternalProcessing: z.boolean(),
  dataScopes: z.array(investigationDataScopeSchema).max(7),
  inputPriceMicroUsdPerMillionTokens: z.number().int().min(0).max(1_000_000_000),
  outputPriceMicroUsdPerMillionTokens: z.number().int().min(0).max(1_000_000_000),
}).strict();

export type ModelConfigurationSnapshot = z.infer<typeof modelConfigurationSnapshotSchema>;

/** Binds a reservation to the exact endpoint, consent, scopes, secret reference and prices read by the gateway. */
export function modelConfigurationFingerprint(raw: ModelConfigurationSnapshot): string {
  const value = modelConfigurationSnapshotSchema.parse(raw);
  return sha256(canonicalJson({ ...value, dataScopes: [...value.dataScopes].sort() }));
}
