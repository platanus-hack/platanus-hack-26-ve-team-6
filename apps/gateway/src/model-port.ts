import type { z } from 'zod';
import type { investigationProviderPresetIdSchema, modelProviderSchema } from '@gotchu/contracts';

export interface ModelCompletionRequest {
  readonly provider: z.infer<typeof modelProviderSchema>;
  readonly providerPresetId: z.infer<typeof investigationProviderPresetIdSchema>;
  readonly endpoint: URL;
  readonly modelId: string;
  readonly apiKey?: string;
  readonly systemInstruction: string;
  readonly userContext: string;
  readonly maxOutputTokens?: number;
  /** Server-selected JSON schema; subscription CLIs can enforce the response shape. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  /** Called when a CLI login rotated its own tokens during the call, whether or not the call succeeded. */
  readonly persistCredential?: (credential: string) => Promise<void>;
}
export interface ModelCompletion {
  readonly output: unknown;
  readonly inputTokens: number;
  readonly outputTokens: number;
}
export interface ModelPort { complete(request: ModelCompletionRequest): Promise<ModelCompletion> }

export class ModelProviderError extends Error {
  constructor(readonly code: 'request_failed' | 'invalid_response' | 'missing_usage' | 'aborted' | 'cli_unavailable', readonly status?: number) {
    super(code);
    this.name = 'ModelProviderError';
  }
}
