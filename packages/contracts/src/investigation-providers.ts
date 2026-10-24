import { z } from 'zod';

export const investigationProviderPresetIdSchema = z.enum([
  'openai', 'anthropic', 'google_gemini', 'deepseek', 'moonshot', 'zhipu_glm',
  'mistral', 'xai', 'groq', 'openrouter', 'custom_openai_compatible', 'claude_code', 'codex',
]);
export const investigationAdapterKindSchema = z.enum(['openai_compatible', 'anthropic', 'claude_code_cli', 'codex_cli']);
export const investigationProviderAuthStyleSchema = z.enum(['bearer', 'anthropic_messages']);
export const investigationMaxTokensFieldSchema = z.enum(['max_tokens', 'max_completion_tokens']);

const presetFields = {
  id: investigationProviderPresetIdSchema,
  displayName: z.string().min(1),
  baseUrl: z.string().url().nullable(),
  defaultModelId: z.string().min(1).nullable(),
  suggestedModelIds: z.array(z.string().min(1)),
  docsUrl: z.string().url(),
  modelDocsUrl: z.string().url().nullable(),
  /** Tokens reserved for "Test connection"; CLI agents add their own fixed prompt overhead. */
  probeTokenAllowance: z.number().int().min(1).max(20_000),
};
const perTokenPresetSchema = z.object({
  ...presetFields,
  billing: z.literal('per_token'),
  adapterKind: investigationAdapterKindSchema.extract(['openai_compatible', 'anthropic']),
  authHeaderStyle: investigationProviderAuthStyleSchema,
  maxTokensField: investigationMaxTokensFieldSchema,
  supportsJsonObjectMode: z.boolean(),
}).strict();
/** Runs the vendor's official CLI with the customer's own subscription login; no API key or per-token price. */
const subscriptionPresetSchema = z.object({
  ...presetFields,
  billing: z.literal('subscription'),
  adapterKind: investigationAdapterKindSchema.extract(['claude_code_cli', 'codex_cli']),
}).strict();
const providerPresetSchema = z.discriminatedUnion('billing', [perTokenPresetSchema, subscriptionPresetSchema]);

export const investigationProviderCatalogVersion = 3;

/** Versioned source of truth shared by settings, backend validation, and gateway adapters. */
export const investigationProviderCatalog = [
  {
    billing: 'per_token', probeTokenAllowance: 64, id: 'openai', displayName: 'OpenAI', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1', defaultModelId: 'gpt-5.4', suggestedModelIds: ['gpt-5.4'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_completion_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://developers.openai.com/api/reference/overview',
    modelDocsUrl: 'https://developers.openai.com/api/docs/models/gpt-5.4',
  },
  {
    billing: 'per_token', probeTokenAllowance: 64, id: 'anthropic', displayName: 'Anthropic', adapterKind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1', defaultModelId: 'claude-sonnet-5-5', suggestedModelIds: ['claude-sonnet-5-5', 'claude-opus-5-5'],
    authHeaderStyle: 'anthropic_messages', maxTokensField: 'max_tokens', supportsJsonObjectMode: false,
    docsUrl: 'https://platform.claude.com/docs/en/api/overview',
    modelDocsUrl: 'https://platform.claude.com/docs/en/models/overview',
  },
  {
    billing: 'per_token', probeTokenAllowance: 64, id: 'google_gemini', displayName: 'Google Gemini', adapterKind: 'openai_compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModelId: 'gemini-3.8-flash', suggestedModelIds: ['gemini-3.8-flash'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai/',
    modelDocsUrl: 'https://ai.google.dev/gemini-api/docs/models',
  },
  {
    billing: 'per_token', probeTokenAllowance: 64, id: 'deepseek', displayName: 'DeepSeek', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com', defaultModelId: 'deepseek-flash', suggestedModelIds: ['deepseek-flash', 'deepseek-v4-pro'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://api-docs.deepseek.com/api/create-chat-completion/',
    modelDocsUrl: 'https://api-docs.deepseek.com/api/list-models/',
  },
  {
    billing: 'per_token', probeTokenAllowance: 64, id: 'moonshot', displayName: 'Moonshot AI (Kimi)', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.moonshot.ai/v1', defaultModelId: 'kimi-k3.1-pro', suggestedModelIds: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_completion_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://platform.kimi.ai/docs/api/chat', modelDocsUrl: 'https://platform.kimi.ai/docs/models',
  },
  {
    billing: 'per_token', probeTokenAllowance: 64, id: 'zhipu_glm', displayName: 'Zhipu GLM (Z.ai)', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.z.ai/api/paas/v4', defaultModelId: 'glm-5.3', suggestedModelIds: ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.6'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://docs.z.ai/api-reference/llm/chat-completion', modelDocsUrl: 'https://docs.z.ai/api-reference/llm/chat-completion',
  },
  {
    billing: 'per_token', probeTokenAllowance: 64, id: 'mistral', displayName: 'Mistral', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.mistral.ai/v1', defaultModelId: 'mistral-large-latest', suggestedModelIds: ['mistral-large-latest', 'mistral-small-latest'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://docs.mistral.ai/api/endpoint/chat', modelDocsUrl: 'https://docs.mistral.ai/api/endpoint/models',
  },
  {
    billing: 'per_token', probeTokenAllowance: 64, id: 'xai', displayName: 'xAI Grok', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.x.ai/v1', defaultModelId: 'grok-4.7', suggestedModelIds: ['grok-4.7'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://docs.x.ai/developers/rest-api-reference/inference', modelDocsUrl: 'https://docs.x.ai/developers/models/grok-4.7',
  },
  {
    billing: 'per_token', probeTokenAllowance: 64, id: 'groq', displayName: 'Groq', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1', defaultModelId: 'openai/gpt-oss-120b', suggestedModelIds: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_completion_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://console.groq.com/docs/overview', modelDocsUrl: 'https://console.groq.com/docs/models',
  },
  {
    billing: 'per_token', probeTokenAllowance: 64, id: 'openrouter', displayName: 'OpenRouter', adapterKind: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1', defaultModelId: 'anthropic/claude-sonnet-5.5',
    suggestedModelIds: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4.1-flash', 'moonshotai/kimi-k3.1-pro', 'z-ai/glm-5.3'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://openrouter.ai/docs/api_reference/overview', modelDocsUrl: 'https://openrouter.ai/models',
  },
  {
    billing: 'per_token', probeTokenAllowance: 64, id: 'custom_openai_compatible', displayName: 'Custom OpenAI-compatible', adapterKind: 'openai_compatible',
    baseUrl: null, defaultModelId: null, suggestedModelIds: [], authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: false,
    docsUrl: 'https://developers.openai.com/api/reference/chat/completions/overview', modelDocsUrl: null,
  },
  {
    billing: 'subscription', probeTokenAllowance: 2_000, id: 'claude_code', displayName: 'Claude Code (suscripción Claude)', adapterKind: 'claude_code_cli',
    baseUrl: 'https://api.anthropic.com/v1', defaultModelId: 'claude-sonnet-5-5', suggestedModelIds: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-5-5'],
    docsUrl: 'https://code.claude.com/docs/en/headless', modelDocsUrl: 'https://platform.claude.com/docs/en/models/overview',
  },
  {
    billing: 'subscription', probeTokenAllowance: 20_000, id: 'codex', displayName: 'Codex (suscripción ChatGPT)', adapterKind: 'codex_cli',
    baseUrl: 'https://chatgpt.com/backend-api/codex', defaultModelId: 'gpt-6-luna', suggestedModelIds: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-luna'],
    docsUrl: 'https://developers.openai.com/codex/noninteractive', modelDocsUrl: 'https://developers.openai.com/codex/models',
  },
] as const satisfies readonly z.infer<typeof providerPresetSchema>[];

export const investigationProviderCatalogSchema = z.object({
  version: z.literal(investigationProviderCatalogVersion),
  providers: z.array(providerPresetSchema).length(investigationProviderCatalog.length),
}).strict();

export const investigationProviderCatalogDocument = investigationProviderCatalogSchema.parse({
  version: investigationProviderCatalogVersion,
  providers: investigationProviderCatalog,
});

export type InvestigationProviderPresetId = z.infer<typeof investigationProviderPresetIdSchema>;
export type InvestigationAdapterKind = z.infer<typeof investigationAdapterKindSchema>;
export type InvestigationProviderPreset = z.infer<typeof providerPresetSchema>;

const codexAuthFileSchema = z.object({
  auth_mode: z.literal('chatgpt'),
  tokens: z.object({
    id_token: z.string().min(1), access_token: z.string().min(1), refresh_token: z.string().min(1),
  }).passthrough(),
}).passthrough();
const claudeCodeTokenSchema = z.string().regex(/^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/);

/**
 * Checks a pasted subscription credential: the token printed by `claude setup-token`, or the
 * `auth.json` written by `codex login`. Returns the canonical text to store, or null when invalid.
 */
export function parseSubscriptionCredential(presetId: 'claude_code' | 'codex', raw: string): string | null {
  const text = raw.trim();
  if (presetId === 'claude_code') return claudeCodeTokenSchema.safeParse(text).success ? text : null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return null; }
  return codexAuthFileSchema.safeParse(parsed).success ? JSON.stringify(parsed) : null;
}
