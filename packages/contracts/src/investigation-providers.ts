import { z } from 'zod';

export const investigationProviderPresetIdSchema = z.enum([
  'openai', 'anthropic', 'google_gemini', 'deepseek', 'moonshot', 'zhipu_glm',
  'mistral', 'xai', 'groq', 'openrouter', 'custom_openai_compatible',
]);
export const investigationAdapterKindSchema = z.enum(['openai_compatible', 'anthropic']);
export const investigationProviderAuthStyleSchema = z.enum(['bearer', 'anthropic_messages']);
export const investigationMaxTokensFieldSchema = z.enum(['max_tokens', 'max_completion_tokens']);

const providerPresetSchema = z.object({
  id: investigationProviderPresetIdSchema,
  displayName: z.string().min(1),
  adapterKind: investigationAdapterKindSchema,
  baseUrl: z.string().url().nullable(),
  defaultModelId: z.string().min(1).nullable(),
  suggestedModelIds: z.array(z.string().min(1)),
  authHeaderStyle: investigationProviderAuthStyleSchema,
  maxTokensField: investigationMaxTokensFieldSchema,
  supportsJsonObjectMode: z.boolean(),
  docsUrl: z.string().url(),
  modelDocsUrl: z.string().url().nullable(),
}).strict();

export const investigationProviderCatalogVersion = 2;

/** Versioned source of truth shared by settings, backend validation, and gateway adapters. */
export const investigationProviderCatalog = [
  {
    id: 'openai', displayName: 'OpenAI', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1', defaultModelId: 'gpt-5.4', suggestedModelIds: ['gpt-5.4'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_completion_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://developers.openai.com/api/reference/overview',
    modelDocsUrl: 'https://developers.openai.com/api/docs/models/gpt-5.4',
  },
  {
    id: 'anthropic', displayName: 'Anthropic', adapterKind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1', defaultModelId: 'claude-sonnet-5-5', suggestedModelIds: ['claude-sonnet-5-5', 'claude-opus-5-5'],
    authHeaderStyle: 'anthropic_messages', maxTokensField: 'max_tokens', supportsJsonObjectMode: false,
    docsUrl: 'https://platform.claude.com/docs/en/api/overview',
    modelDocsUrl: 'https://platform.claude.com/docs/en/models/overview',
  },
  {
    id: 'google_gemini', displayName: 'Google Gemini', adapterKind: 'openai_compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModelId: 'gemini-3.8-flash', suggestedModelIds: ['gemini-3.8-flash'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai/',
    modelDocsUrl: 'https://ai.google.dev/gemini-api/docs/models',
  },
  {
    id: 'deepseek', displayName: 'DeepSeek', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com', defaultModelId: 'deepseek-flash', suggestedModelIds: ['deepseek-flash', 'deepseek-v4-pro'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://api-docs.deepseek.com/api/create-chat-completion/',
    modelDocsUrl: 'https://api-docs.deepseek.com/api/list-models/',
  },
  {
    id: 'moonshot', displayName: 'Moonshot AI (Kimi)', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.moonshot.ai/v1', defaultModelId: 'kimi-k3.1-pro', suggestedModelIds: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_completion_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://platform.kimi.ai/docs/api/chat', modelDocsUrl: 'https://platform.kimi.ai/docs/models',
  },
  {
    id: 'zhipu_glm', displayName: 'Zhipu GLM (Z.ai)', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.z.ai/api/paas/v4', defaultModelId: 'glm-5.3', suggestedModelIds: ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.6'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://docs.z.ai/api-reference/llm/chat-completion', modelDocsUrl: 'https://docs.z.ai/api-reference/llm/chat-completion',
  },
  {
    id: 'mistral', displayName: 'Mistral', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.mistral.ai/v1', defaultModelId: 'mistral-large-latest', suggestedModelIds: ['mistral-large-latest', 'mistral-small-latest'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://docs.mistral.ai/api/endpoint/chat', modelDocsUrl: 'https://docs.mistral.ai/api/endpoint/models',
  },
  {
    id: 'xai', displayName: 'xAI Grok', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.x.ai/v1', defaultModelId: 'grok-4.7', suggestedModelIds: ['grok-4.7'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://docs.x.ai/developers/rest-api-reference/inference', modelDocsUrl: 'https://docs.x.ai/developers/models/grok-4.7',
  },
  {
    id: 'groq', displayName: 'Groq', adapterKind: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1', defaultModelId: 'openai/gpt-oss-120b', suggestedModelIds: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    authHeaderStyle: 'bearer', maxTokensField: 'max_completion_tokens', supportsJsonObjectMode: true,
    docsUrl: 'https://console.groq.com/docs/overview', modelDocsUrl: 'https://console.groq.com/docs/models',
  },
  {
    id: 'openrouter', displayName: 'OpenRouter', adapterKind: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1', defaultModelId: null, suggestedModelIds: [],
    authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: false,
    docsUrl: 'https://openrouter.ai/docs/api_reference/overview', modelDocsUrl: 'https://openrouter.ai/models',
  },
  {
    id: 'custom_openai_compatible', displayName: 'Custom OpenAI-compatible', adapterKind: 'openai_compatible',
    baseUrl: null, defaultModelId: null, suggestedModelIds: [], authHeaderStyle: 'bearer', maxTokensField: 'max_tokens', supportsJsonObjectMode: false,
    docsUrl: 'https://developers.openai.com/api/reference/chat/completions/overview', modelDocsUrl: null,
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
